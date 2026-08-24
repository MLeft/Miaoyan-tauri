import { create } from 'zustand';
import type { NoteMetadata, NoteContent, Project, SortMode, SortDirection } from '../types';
import {
  getAllNotes,
  getNotesInFolder,
  getProjects,
  readNote,
  writeNote,
  createNote,
  searchNotes,
  getSortOrder,
  saveSortOrder as saveSortOrderBridge,
  saveEncryptedNote,
} from '../services/tauri-bridge';
import { useSettingsStore } from './settings-store';
import { perfReport } from '../services/perf';
import { useEditorStore } from './editor-store';
import type { ViewMode } from './editor-store';

// 应用自身最近写入的文件（path → 时间戳），不进 store 避免触发订阅
const recentWrites = new Map<string, number>();

export interface OpenTab {
  path: string;
  note: NoteMetadata;
  content: string;
  isDirty: boolean;
  viewMode: ViewMode;
  encryptionPassword?: string | null;
}

interface NotesState {
  projects: Project[];
  notes: NoteMetadata[];
  activeNote: NoteMetadata | null;
  activeContent: string;
  activeFolder: string | null;
  searchQuery: string;
  sortMode: SortMode;
  sortDirection: SortDirection;
  isLoading: boolean;
  isDirty: boolean;
  saveTimer: ReturnType<typeof setTimeout> | null;

  customSortOrder: string[]; // note paths in custom order

  // Encryption state
  encryptionDialog: { visible: boolean; mode: 'unlock' | 'encrypt' | 'remove'; notePath: string } | null;
  activeEncryptionPassword: string | null; // password for currently open encrypted note

  // Temporary file state
  isTemporaryFile: boolean;
  openTemporaryFile: (path: string) => Promise<void>;

  loadProjects: (rootPath: string) => Promise<void>;
  loadNotes: (rootPath: string) => Promise<void>;
  loadNotesInFolder: (folderPath: string, rootPath: string) => Promise<void>;
  selectNote: (note: NoteMetadata) => Promise<void>;
  closeTab: (path: string) => Promise<void>;
  switchTab: (path: string) => Promise<void>;
  closeAllTabs: () => Promise<void>;
  closeOtherTabs: (path: string) => Promise<void>;
  closeLeftTabs: (path: string) => Promise<void>;
  closeRightTabs: (path: string) => Promise<void>;
  reloadOpenTabs: (changedPaths: string[]) => Promise<void>;
  updateContent: (content: string, rootPath: string) => void;
  saveCurrentNote: () => Promise<void>;
  setSearchQuery: (query: string, rootPath: string) => Promise<void>;
  setActiveFolder: (folder: string | null, rootPath: string) => Promise<void>;
  setSortMode: (mode: SortMode) => void;
  toggleSortDirection: () => void;
  refreshNotes: (rootPath: string) => Promise<void>;
  setNotesFromCache: (loaded: NoteMetadata[]) => void;
  markRecentWrite: (path: string) => void;
  consumeRecentWrite: (path: string) => boolean;
  duplicateNote: (rootPath: string) => Promise<void>;
  loadCustomSortOrder: (rootPath: string, folder: string | null) => Promise<void>;
  applyCustomSortOrder: (rootPath: string, folder: string | null, noteIds: string[]) => Promise<void>;
  setEncryptionDialog: (dialog: NotesState['encryptionDialog']) => void;
  onNoteUnlocked: (content: string, password: string) => void;
  clearEncryptionPassword: () => void;

  // Tab state
  openTabs: OpenTab[];
  activeTabPath: string | null;

  // Sidebar tree UI state
  expandedFolders: string[];
  allNotesExpanded: boolean;
  toggleExpandedFolder: (path: string) => void;
  setAllNotesExpanded: (v: boolean) => void;
  clearExpandedFolders: () => void;
}

export const useNotesStore = create<NotesState>((set, get) => {
  // （私有）把 activeContent/isDirty 同步回活动标签缓存。
  // updateContent 不再每键更新 openTabs（避免整个数组引用每键变化、
  // 所有订阅 openTabs 的组件每键重渲染），改在切标签/关标签/外部重载前调用
  const syncActiveTab = () => {
    const s = get();
    if (!s.activeTabPath) return;
    const tab = s.openTabs.find(t => t.path === s.activeTabPath);
    if (tab && tab.content === s.activeContent && tab.isDirty === s.isDirty) return;
    set({
      openTabs: s.openTabs.map(t =>
        t.path === s.activeTabPath ? { ...t, content: s.activeContent, isDirty: s.isDirty } : t
      ),
    });
  };

  return {
  projects: [],
  notes: [],
  activeNote: null,
  activeContent: '',
  activeFolder: null,
  searchQuery: '',
  sortMode: 'modified',
  sortDirection: 'desc',
  isLoading: false,
  isDirty: false,
  saveTimer: null,

  customSortOrder: [],

  encryptionDialog: null,
  activeEncryptionPassword: null,

  isTemporaryFile: false,

  // Tab state
  openTabs: [],
  activeTabPath: null,

  // Sidebar tree UI state
  expandedFolders: [],
  allNotesExpanded: true,
  toggleExpandedFolder: (path) => set((s) => ({
    expandedFolders: s.expandedFolders.includes(path)
      ? s.expandedFolders.filter(p => p !== path)
      : [...s.expandedFolders, path],
  })),
  setAllNotesExpanded: (v) => set({ allNotesExpanded: v }),
  clearExpandedFolders: () => set({ expandedFolders: [] }),

  loadProjects: async (rootPath) => {
    try {
      const config = useSettingsStore.getState().config;
      const projects = await getProjects(rootPath, config.extra_folders || []);
      set({ projects });
    } catch (e) {
      console.error('Failed to load projects:', e);
    }
  },

  loadNotes: async (rootPath) => {
    set({ isLoading: true });
    try {
      const config = useSettingsStore.getState().config;
      const t0 = performance.now();
      const notes = await getAllNotes(rootPath, config.extra_folders || []);
      // 全量目录扫描超过 200ms 记录（启动/全量刷新链路）
      const dt = performance.now() - t0;
      if (dt > 200) perfReport('scan-notes', dt, `count=${notes.length}`);
      set({ notes, isLoading: false });
    } catch (e) {
      console.error('Failed to load notes:', e);
      set({ isLoading: false });
    }
  },

  loadNotesInFolder: async (folderPath, rootPath) => {
    set({ isLoading: true });
    try {
      const notes = await getNotesInFolder(folderPath, rootPath);
      set({ notes, isLoading: false });
    } catch (e) {
      console.error('Failed to load notes in folder:', e);
      set({ isLoading: false });
    }
  },

  selectNote: async (note) => {
    // Save current tab if dirty
    const before = get();
    if (before.isDirty && before.activeNote) {
      await get().saveCurrentNote();
    }
    syncActiveTab();

    // Check if note is already open in a tab
    const state = get();
    const existingTab = state.openTabs.find(t => t.path === note.path);
    if (existingTab) {
      // Switch to existing tab
      set({
        activeNote: existingTab.note,
        activeContent: existingTab.content,
        activeTabPath: existingTab.path,
        isDirty: existingTab.isDirty,
        isLoading: false,
        activeEncryptionPassword: existingTab.encryptionPassword || null,
        isTemporaryFile: false,
      });
      useEditorStore.getState().setViewMode(existingTab.viewMode);
      return;
    }

    set({ isLoading: true, activeEncryptionPassword: null, isTemporaryFile: false });

    // If encrypted, show unlock dialog instead of loading content
    if (note.is_encrypted) {
      set({ activeNote: note, activeContent: '', isLoading: false, isDirty: false });
      set({
        encryptionDialog: { visible: true, mode: 'unlock', notePath: note.path },
      });
      return;
    }

    try {
      const t0 = performance.now();
      const result = await readNote(note.path);
      // 读盘超过 100ms 记录（切换笔记卡顿定位）
      const readMs = performance.now() - t0;
      if (readMs > 100) perfReport('read-note', readMs, `len=${result.content.length}`);
      const isEmpty = !result.content.trim();
      const viewMode: ViewMode = isEmpty ? 'split' : 'preview';

      // Create new tab
      const newTab: OpenTab = {
        path: note.path,
        note,
        content: result.content,
        isDirty: false,
        viewMode,
      };

      // Set activeNote + activeContent atomically to avoid blank first render
      set((s) => ({
        activeNote: note,
        openTabs: [...s.openTabs, newTab],
        activeTabPath: note.path,
        activeContent: result.content,
        isLoading: false,
        isDirty: false,
      }));
      useEditorStore.getState().setViewMode(viewMode);
    } catch (e) {
      console.error('Failed to read note:', e);
      set({ activeNote: note, activeContent: '', isLoading: false });
      useEditorStore.getState().setViewMode('split');
    }
  },

  switchTab: async (path) => {
    const before = get();
    // Save current tab if dirty
    if (before.isDirty && before.activeNote) {
      await get().saveCurrentNote();
    }
    syncActiveTab();

    const state = get();
    const tab = state.openTabs.find(t => t.path === path);
    if (!tab) return;

    // Save current viewMode to old tab before switching
    const currentViewMode = useEditorStore.getState().viewMode;
    const updatedTabs = state.openTabs.map(t =>
      t.path === state.activeTabPath ? { ...t, viewMode: currentViewMode } : t
    );

    set({
      openTabs: updatedTabs,
      activeNote: tab.note,
      activeContent: tab.content,
      activeTabPath: tab.path,
      isDirty: tab.isDirty,
      isLoading: false,
      activeEncryptionPassword: tab.encryptionPassword || null,
      isTemporaryFile: false,
    });
    useEditorStore.getState().setViewMode(tab.viewMode);
  },

  closeTab: async (path) => {
    syncActiveTab();
    const state = get();
    const tab = state.openTabs.find(t => t.path === path);

    // Save dirty tab before closing
    if (tab && tab.isDirty) {
      try {
        const { config } = useSettingsStore.getState();
        let contentToSave = tab.content;
        if (config.line_ending === 'crlf') {
          contentToSave = contentToSave.replace(/(?<!\r)\n/g, '\r\n');
        } else {
          contentToSave = contentToSave.replace(/\r\n/g, '\n');
        }
        if (tab.note.is_encrypted && tab.encryptionPassword) {
          await saveEncryptedNote(tab.path, contentToSave, tab.encryptionPassword);
        } else {
          await writeNote(tab.path, contentToSave);
        }
      } catch (e) {
        console.error('Failed to save dirty tab on close:', e);
      }
    }

    const newTabs = state.openTabs.filter(t => t.path !== path);

    if (state.activeTabPath === path) {
      if (newTabs.length === 0) {
        // No tabs left
        set({
          openTabs: [],
          activeTabPath: null,
          activeNote: null,
          activeContent: '',
          isDirty: false,
          isLoading: false,
        });
      } else {
        // Switch to adjacent tab
        const oldIndex = state.openTabs.findIndex(t => t.path === path);
        const newIndex = Math.min(oldIndex, newTabs.length - 1);
        const nextTab = newTabs[newIndex];
        set({
          openTabs: newTabs,
          activeTabPath: nextTab.path,
          activeNote: nextTab.note,
          activeContent: nextTab.content,
          isDirty: nextTab.isDirty,
          isLoading: false,
          activeEncryptionPassword: nextTab.encryptionPassword || null,
        });
        useEditorStore.getState().setViewMode(nextTab.viewMode);
      }
    } else {
      set({ openTabs: newTabs });
    }
  },

  closeAllTabs: async () => {
    syncActiveTab();
    const state = get();
    // Save all dirty tabs
    for (const tab of state.openTabs) {
      if (tab.isDirty) {
        try {
          const { config } = useSettingsStore.getState();
          let contentToSave = tab.content;
          if (config.line_ending === 'crlf') {
            contentToSave = contentToSave.replace(/(?<!\r)\n/g, '\r\n');
          } else {
            contentToSave = contentToSave.replace(/\r\n/g, '\n');
          }
          if (tab.note.is_encrypted && tab.encryptionPassword) {
            await saveEncryptedNote(tab.path, contentToSave, tab.encryptionPassword);
          } else {
            await writeNote(tab.path, contentToSave);
          }
        } catch (e) {
          console.error('Failed to save dirty tab:', e);
        }
      }
    }
    set({
      openTabs: [],
      activeTabPath: null,
      activeNote: null,
      activeContent: '',
      isDirty: false,
      isLoading: false,
    });
  },

  closeOtherTabs: async (path) => {
    syncActiveTab();
    const state = get();
    const keepTab = state.openTabs.find(t => t.path === path);
    if (!keepTab) return;
    // Save dirty tabs that are being closed
    for (const tab of state.openTabs) {
      if (tab.path !== path && tab.isDirty) {
        try {
          const { config } = useSettingsStore.getState();
          let contentToSave = tab.content;
          if (config.line_ending === 'crlf') {
            contentToSave = contentToSave.replace(/(?<!\r)\n/g, '\r\n');
          } else {
            contentToSave = contentToSave.replace(/\r\n/g, '\n');
          }
          if (tab.note.is_encrypted && tab.encryptionPassword) {
            await saveEncryptedNote(tab.path, contentToSave, tab.encryptionPassword);
          } else {
            await writeNote(tab.path, contentToSave);
          }
        } catch (e) {
          console.error('Failed to save dirty tab:', e);
        }
      }
    }
    set({
      openTabs: [keepTab],
      activeTabPath: keepTab.path,
      activeNote: keepTab.note,
      activeContent: keepTab.content,
      isDirty: keepTab.isDirty,
      isLoading: false,
    });
    useEditorStore.getState().setViewMode(keepTab.viewMode);
  },

  closeLeftTabs: async (path) => {
    syncActiveTab();
    const state = get();
    const idx = state.openTabs.findIndex(t => t.path === path);
    if (idx <= 0) return;
    const toClose = state.openTabs.slice(0, idx);
    for (const tab of toClose) {
      if (tab.isDirty) {
        try {
          const { config } = useSettingsStore.getState();
          let contentToSave = tab.content;
          if (config.line_ending === 'crlf') {
            contentToSave = contentToSave.replace(/(?<!\r)\n/g, '\r\n');
          } else {
            contentToSave = contentToSave.replace(/\r\n/g, '\n');
          }
          if (tab.note.is_encrypted && tab.encryptionPassword) {
            await saveEncryptedNote(tab.path, contentToSave, tab.encryptionPassword);
          } else {
            await writeNote(tab.path, contentToSave);
          }
        } catch (e) { console.error('Failed to save dirty tab:', e); }
      }
    }
    const remaining = state.openTabs.slice(idx);
    // If active tab was closed, switch to the target tab
    const activeInRemaining = remaining.find(t => t.path === state.activeTabPath) || remaining[0];
    set({
      openTabs: remaining,
      activeTabPath: activeInRemaining?.path ?? null,
      activeNote: activeInRemaining?.note ?? null,
      activeContent: activeInRemaining?.content ?? '',
      isDirty: activeInRemaining?.isDirty ?? false,
      isLoading: false,
    });
    if (activeInRemaining) {
      useEditorStore.getState().setViewMode(activeInRemaining.viewMode);
    }
  },

  closeRightTabs: async (path) => {
    syncActiveTab();
    const state = get();
    const idx = state.openTabs.findIndex(t => t.path === path);
    if (idx < 0 || idx >= state.openTabs.length - 1) return;
    const toClose = state.openTabs.slice(idx + 1);
    for (const tab of toClose) {
      if (tab.isDirty) {
        try {
          const { config } = useSettingsStore.getState();
          let contentToSave = tab.content;
          if (config.line_ending === 'crlf') {
            contentToSave = contentToSave.replace(/(?<!\r)\n/g, '\r\n');
          } else {
            contentToSave = contentToSave.replace(/\r\n/g, '\n');
          }
          if (tab.note.is_encrypted && tab.encryptionPassword) {
            await saveEncryptedNote(tab.path, contentToSave, tab.encryptionPassword);
          } else {
            await writeNote(tab.path, contentToSave);
          }
        } catch (e) { console.error('Failed to save dirty tab:', e); }
      }
    }
    const remaining = state.openTabs.slice(0, idx + 1);
    const activeInRemaining = remaining.find(t => t.path === state.activeTabPath) || remaining[remaining.length - 1];
    set({
      openTabs: remaining,
      activeTabPath: activeInRemaining?.path ?? null,
      activeNote: activeInRemaining?.note ?? null,
      activeContent: activeInRemaining?.content ?? '',
      isDirty: activeInRemaining?.isDirty ?? false,
      isLoading: false,
    });
    if (activeInRemaining) {
      useEditorStore.getState().setViewMode(activeInRemaining.viewMode);
    }
  },

  reloadOpenTabs: async (changedPaths) => {
    syncActiveTab();
    const state = get();
    const changedSet = new Set(changedPaths.map(p => p.replace(/\\/g, '/')));
    let updatedTabs = [...state.openTabs];
    let activeNeedsReload = false;

    for (let i = 0; i < updatedTabs.length; i++) {
      const tab = updatedTabs[i];
      const normalizedPath = tab.path.replace(/\\/g, '/');
      // Only reload if file was changed externally and tab is not dirty
      if (changedSet.has(normalizedPath) && !tab.isDirty) {
        try {
          const result = await readNote(tab.path);
          updatedTabs[i] = { ...tab, content: result.content };
          if (tab.path === state.activeTabPath) {
            activeNeedsReload = true;
          }
        } catch (e) {
          // File might have been deleted
          console.warn('Failed to reload tab:', tab.path, e);
        }
      }
    }

    const updates: any = { openTabs: updatedTabs };
    if (activeNeedsReload) {
      const activeTab = updatedTabs.find(t => t.path === state.activeTabPath);
      if (activeTab) {
        updates.activeContent = activeTab.content;
      }
    }
    set(updates);
  },

  updateContent: (content, rootPath) => {
    const state = get();
    // 只更新 store 级字段；openTabs 缓存延迟到切换/关闭时同步，
    // 避免每次按键都新建 openTabs 数组导致订阅方全部重渲染

    // Debounced auto-save (1.5 seconds)
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
    }
    const timer = setTimeout(async () => {
      await get().saveCurrentNote();
    }, 1500);
    // 合并为单次 set：避免每次按键两次通知全部订阅者
    set({ activeContent: content, isDirty: true, saveTimer: timer });
  },

  saveCurrentNote: async () => {
    const { activeNote, activeContent, isDirty, activeEncryptionPassword, activeTabPath } = get();
    if (!activeNote || !isDirty) return;

    try {
      // Apply line ending conversion based on config
      const { config } = useSettingsStore.getState();
      let contentToSave = activeContent;
      if (config.line_ending === 'crlf') {
        contentToSave = activeContent.replace(/(?<!\r)\n/g, '\r\n');
      } else {
        contentToSave = activeContent.replace(/\r\n/g, '\n');
      }

      // 先标记自身写入，确保 watcher 回环事件到达时必被吞掉
      get().markRecentWrite(activeNote.path);
      const t0 = performance.now();
      if (activeNote.is_encrypted && activeEncryptionPassword) {
        // Save as encrypted
        await saveEncryptedNote(activeNote.path, contentToSave, activeEncryptionPassword);
      } else {
        await writeNote(activeNote.path, contentToSave);
      }
      // 保存（含加密/写盘）超过 100ms 记录，用于定位保存引发的卡顿
      const saveMs = performance.now() - t0;
      if (saveMs > 100) perfReport('save-note', saveMs, `len=${contentToSave.length}`);

      // Update dirty state in both store and tab
      const updatedTabs = get().openTabs.map(t =>
        t.path === activeTabPath ? { ...t, isDirty: false, content: activeContent } : t
      );
      set({ isDirty: false, openTabs: updatedTabs });
    } catch (e) {
      console.error('Failed to save note:', e);
    }
  },

  setSearchQuery: async (query, rootPath) => {
    set({ searchQuery: query });
    if (query.trim()) {
      try {
        const notes = await searchNotes(rootPath, query);
        set({ notes });
      } catch (e) {
        console.error('Failed to search:', e);
      }
    } else {
      const { activeFolder } = get();
      if (activeFolder) {
        await get().loadNotesInFolder(activeFolder, rootPath);
      } else {
        await get().loadNotes(rootPath);
      }
    }
  },

  setActiveFolder: async (folder, rootPath) => {
    set({ activeFolder: folder, searchQuery: '' });
    if (folder) {
      await get().loadNotesInFolder(folder, rootPath);
    } else {
      await get().loadNotes(rootPath);
    }
    // Load custom sort order for this folder
    if (get().sortMode === 'custom') {
      await get().loadCustomSortOrder(rootPath, folder);
    }
  },

  setSortMode: (mode) => {
    set({ sortMode: mode });
  },

  toggleSortDirection: () => {
    set((state) => ({ sortDirection: state.sortDirection === 'asc' ? 'desc' : 'asc' }));
  },

  loadCustomSortOrder: async (rootPath, folder) => {
    try {
      const folderKey = folder || '';
      const order = await getSortOrder(rootPath, folderKey);
      set({ customSortOrder: order });
    } catch (e) {
      console.error('Failed to load custom sort order:', e);
      set({ customSortOrder: [] });
    }
  },

  applyCustomSortOrder: async (rootPath, folder, noteIds) => {
    try {
      const folderKey = folder || '';
      await saveSortOrderBridge(rootPath, folderKey, noteIds);
      set({ customSortOrder: noteIds });
    } catch (e) {
      console.error('Failed to save custom sort order:', e);
    }
  },

  refreshNotes: async (rootPath) => {
    const { activeFolder, searchQuery } = get();
    if (searchQuery) {
      await get().setSearchQuery(searchQuery, rootPath);
    } else if (activeFolder) {
      await get().loadNotesInFolder(activeFolder, rootPath);
    } else {
      await get().loadNotes(rootPath);
    }
    await get().loadProjects(rootPath);
  },

  setNotesFromCache: (loaded) => {
    // 用已扫描的全量笔记更新 store.notes，避免重复磁盘扫描
    const { activeFolder, searchQuery } = get();
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      set({ notes: loaded.filter(n => n.title.toLowerCase().includes(q)) });
    } else if (activeFolder) {
      set({ notes: loaded.filter(n => n.path.startsWith(activeFolder + '\\') || n.path.startsWith(activeFolder + '/')) });
    } else {
      set({ notes: loaded });
    }
  },

  // 应用自身写入标记：watcher 会回环触发自己保存的文件事件，
  // 命中时直接吞掉，避免每次自动保存都引发刷新
  markRecentWrite: (path) => {
    recentWrites.set(path.replace(/\\/g, '/'), Date.now());
  },
  consumeRecentWrite: (path) => {
    const key = path.replace(/\\/g, '/');
    const ts = recentWrites.get(key);
    if (ts !== undefined) {
      recentWrites.delete(key);
      return Date.now() - ts < 5000;
    }
    return false;
  },

  duplicateNote: async (rootPath) => {
    const { activeNote, activeFolder } = get();
    if (!activeNote) return;
    try {
      const result = await readNote(activeNote.path);
      const copyTitle = `${activeNote.title} copy`;
      const folder = activeFolder || rootPath;
      const newNote = await createNote(folder, copyTitle);
      await writeNote(newNote.path, result.content);
      await get().refreshNotes(rootPath);
    } catch (e) {
      console.error('Failed to duplicate note:', e);
    }
  },

  setEncryptionDialog: (dialog) => {
    set({ encryptionDialog: dialog });
  },

  onNoteUnlocked: (content, password) => {
    const { activeTabPath } = get();
    const updatedTabs = get().openTabs.map(t =>
      t.path === activeTabPath ? { ...t, content, isDirty: false, encryptionPassword: password } : t
    );
    set({ activeContent: content, isDirty: false, activeEncryptionPassword: password, openTabs: updatedTabs });
  },

  clearEncryptionPassword: () => {
    set({ activeEncryptionPassword: null });
  },

  openTemporaryFile: async (path: string) => {
    try {
      const content = await readNote(path);
      const meta: NoteMetadata = {
        id: path,
        title: path.split('/').pop()?.replace('.md', '') || 'Untitled',
        path,
        folder: path.substring(0, path.lastIndexOf('/')),
        created_at: new Date().toISOString(),
        modified_at: new Date().toISOString(),
        pinned: false,
        size: content.content.length,
        is_encrypted: false,
      };
      // Add as tab
      const newTab: OpenTab = {
        path,
        note: meta,
        content: content.content,
        isDirty: false,
        viewMode: 'split',
      };
      set((s) => ({
        openTabs: [...s.openTabs.filter(t => t.path !== path), newTab],
        activeTabPath: path,
        activeNote: meta,
        activeContent: content.content,
        isTemporaryFile: true,
      }));
      useEditorStore.getState().setViewMode('split');
    } catch (e) {
      console.error('Failed to open temporary file:', e);
    }
  },
  };
});
