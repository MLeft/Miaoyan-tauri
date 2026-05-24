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

  loadProjects: (rootPath: string) => Promise<void>;
  loadNotes: (rootPath: string) => Promise<void>;
  loadNotesInFolder: (folderPath: string, rootPath: string) => Promise<void>;
  selectNote: (note: NoteMetadata) => Promise<void>;
  updateContent: (content: string, rootPath: string) => void;
  saveCurrentNote: () => Promise<void>;
  setSearchQuery: (query: string, rootPath: string) => Promise<void>;
  setActiveFolder: (folder: string | null, rootPath: string) => Promise<void>;
  setSortMode: (mode: SortMode) => void;
  toggleSortDirection: () => void;
  refreshNotes: (rootPath: string) => Promise<void>;
  duplicateNote: (rootPath: string) => Promise<void>;
  loadCustomSortOrder: (rootPath: string, folder: string | null) => Promise<void>;
  applyCustomSortOrder: (rootPath: string, folder: string | null, noteIds: string[]) => Promise<void>;
  setEncryptionDialog: (dialog: NotesState['encryptionDialog']) => void;
  onNoteUnlocked: (content: string, password: string) => void;
  clearEncryptionPassword: () => void;
}

export const useNotesStore = create<NotesState>((set, get) => ({
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

  loadProjects: async (rootPath) => {
    try {
      const projects = await getProjects(rootPath);
      set({ projects });
    } catch (e) {
      console.error('Failed to load projects:', e);
    }
  },

  loadNotes: async (rootPath) => {
    set({ isLoading: true });
    try {
      const notes = await getAllNotes(rootPath);
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
    // Save current note if dirty
    const state = get();
    if (state.isDirty && state.activeNote) {
      await get().saveCurrentNote();
    }

    set({ activeNote: note, isLoading: true, activeEncryptionPassword: null });

    // If encrypted, show unlock dialog instead of loading content
    if (note.is_encrypted) {
      set({ activeContent: '', isLoading: false, isDirty: false });
      set({
        encryptionDialog: { visible: true, mode: 'unlock', notePath: note.path },
      });
      return;
    }

    try {
      const result = await readNote(note.path);
      set({ activeContent: result.content, isLoading: false, isDirty: false });
    } catch (e) {
      console.error('Failed to read note:', e);
      set({ activeContent: '', isLoading: false });
    }
  },

  updateContent: (content, rootPath) => {
    const state = get();
    set({ activeContent: content, isDirty: true });

    // Debounced auto-save (1.5 seconds)
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
    }
    const timer = setTimeout(async () => {
      await get().saveCurrentNote();
    }, 1500);
    set({ saveTimer: timer });
  },

  saveCurrentNote: async () => {
    const { activeNote, activeContent, isDirty, activeEncryptionPassword } = get();
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

      if (activeNote.is_encrypted && activeEncryptionPassword) {
        // Save as encrypted
        await saveEncryptedNote(activeNote.path, contentToSave, activeEncryptionPassword);
      } else {
        await writeNote(activeNote.path, contentToSave);
      }
      set({ isDirty: false });
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
    set({ activeContent: content, isDirty: false, activeEncryptionPassword: password });
  },

  clearEncryptionPassword: () => {
    set({ activeEncryptionPassword: null });
  },
}));
