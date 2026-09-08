import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useVirtualizer } from '@tanstack/react-virtual';
import { listen } from '@tauri-apps/api/event';
import type { Project, NoteMetadata } from '../../types';
import { useNotesStore } from '../../stores/notes-store';
import { useSettingsStore } from '../../stores/settings-store';
import {
  createNote, deleteNote, renameNote,
  createFolder, moveNote, renameFolder, deleteFolder,
  revealInFinder, openInTerminal, getAllNotes, getNotesMetadata,
  startWatching,
} from '../../services/tauri-bridge';
import { useTranslation } from 'react-i18next';
import { SyncStatusIndicator } from '../shared/SyncStatus';
import { EncryptionDialog } from '../shared/EncryptionDialog';
import { perfReport } from '../../services/perf';

/* ── SVG Icons ── */
const IconHome = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" />
  </svg>
);
const IconFolder = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);
const IconFile = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
  </svg>
);
/* Markdown 格式图标（M + 下箭头） */
const IconFileMd = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <path d="M6 15v-6l3 3.5L12 8.5v6" />
    <path d="M17 9v4.5" /><path d="M15 12l2 2 2-2" />
  </svg>
);
/* HTML 格式图标（尖括号） */
const IconFileHtml = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="8 6 3 12 8 18" />
    <polyline points="16 6 21 12 16 18" />
  </svg>
);
/* 纯文本格式图标（文档 + 横线） */
const IconFileTxt = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
    <line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="16" y2="17" />
  </svg>
);

/* 根据文件后缀返回对应的格式图标与颜色，方便一眼区分文件类型 */
function getFileTypeIcon(path: string): { icon: React.ReactNode; color: string } {
  const lower = path.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    return { icon: <IconFileMd />, color: '#519aba' };
  }
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    return { icon: <IconFileHtml />, color: '#e37933' };
  }
  if (lower.endsWith('.txt')) {
    return { icon: <IconFileTxt />, color: 'var(--text-tertiary)' };
  }
  return { icon: <IconFile />, color: 'var(--text-tertiary)' };
}
const IconChevronRight = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 18 15 12 9 6" />
  </svg>
);
const IconChevronDown = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9 12 15 18 9" />
  </svg>
);
const IconPlus = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);
const IconSearch = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);
const IconLockSmall = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

/* ── Context Menu Icons ── */
const IconFolderPlus = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    <line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" />
  </svg>
);
const IconEdit = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);
const IconFinder = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
);
const IconTerminal = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
  </svg>
);
const IconTrash = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);
const IconCopy = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

/* ── Helpers ── */
function getParentPath(notePath: string): string {
  const i = Math.max(notePath.lastIndexOf('/'), notePath.lastIndexOf('\\'));
  return i >= 0 ? notePath.substring(0, i) : '';
}

/* 判断是否为笔记文件路径（区分文件级事件与目录级事件） */
function isNoteFilePath(p: string): boolean {
  const lower = p.toLowerCase();
  return /\.(md|markdown|txt|html|htm)$/.test(lower) || lower.endsWith('.md.encrypted');
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${m}/${day}`;
}

/* ── Note context menu ── */
interface NoteContextMenu {
  x: number; y: number;
  type: 'note';
  note: NoteMetadata;
}

/* ── Folder context menu ── */
interface FolderContextMenu {
  x: number; y: number;
  type: 'folder';
  project: Project;
}

type TreeContextMenu = NoteContextMenu | FolderContextMenu | null;

/* ── Shared row style helper ── */
function rowStyle(depth: number, isActive: boolean, isNote = false): React.CSSProperties {
  return {
    paddingLeft: `${depth * 14 + 10 + (isNote ? 14 : 0)}px`,
    paddingRight: '8px',
    height: '26px',
    color: isActive ? 'var(--accent-icon)' : 'var(--text-secondary)',
    backgroundColor: isActive ? 'var(--accent-light)' : 'transparent',
    borderRadius: isActive ? '6px' : '0',
  };
}

export function UnifiedTree() {
  const { t } = useTranslation();
  const {
    projects, activeNote,
    selectNote,
    isLoading, loadProjects,
    encryptionDialog, setEncryptionDialog, onNoteUnlocked,
    expandedFolders, allNotesExpanded, searchQuery,
    toggleExpandedFolder, setAllNotesExpanded, clearExpandedFolders,
  } = useNotesStore(useShallow((s) => ({
    projects: s.projects, activeNote: s.activeNote,
    selectNote: s.selectNote,
    isLoading: s.isLoading, loadProjects: s.loadProjects,
    encryptionDialog: s.encryptionDialog, setEncryptionDialog: s.setEncryptionDialog, onNoteUnlocked: s.onNoteUnlocked,
    expandedFolders: s.expandedFolders, allNotesExpanded: s.allNotesExpanded, searchQuery: s.searchQuery,
    toggleExpandedFolder: s.toggleExpandedFolder, setAllNotesExpanded: s.setAllNotesExpanded, clearExpandedFolders: s.clearExpandedFolders,
  })));
  const { config } = useSettingsStore();

  const [contextMenu, setContextMenu] = useState<TreeContextMenu>(null);
  const [renamingNoteId, setRenamingNoteId] = useState<string | null>(null);
  const [renameNoteValue, setRenameNoteValue] = useState('');
  const [renamingFolderPath, setRenamingFolderPath] = useState<string | null>(null);
  const [renameFolderValue, setRenameFolderValue] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  // 本地搜索输入：纯前端标题过滤，避免每次按键触发 Rust 全文扫描
  const [searchInput, setSearchInput] = useState('');

  /* ── Local cache of ALL notes (not filtered by active folder) ── */
  const [allNotes, setAllNotes] = useState<NoteMetadata[]>([]);
  const allNotesRef = useRef(allNotes);
  useEffect(() => { allNotesRef.current = allNotes; }, [allNotes]);

  /* ── 渐进加载进度：扫描期间「全部笔记」右侧显示 已加载/总数，完成后只显示总数 ──
     总数优先用上次会话持久值（启动即可显示分数），Rust scan-total 事件到达后校正 ── */
  const [scanning, setScanning] = useState(false);
  const [scanTotal, setScanTotal] = useState(() => {
    try { return Number(localStorage.getItem('miaoyan.scanTotal')) || 0; } catch { return 0; }
  });

  const reloadAllNotes = useCallback(async () => {
    setScanning(true);
    try {
      const cfg = useSettingsStore.getState().config;
      const callFolders = (cfg.extra_folders || []).map(p => p.replace(/\\/g, '/').toLowerCase());
      const t0 = performance.now();
      const loaded = await getAllNotes(cfg.storage_path, cfg.extra_folders || []);
      // 启动/全量刷新链路：目录扫描超过 200ms 记录
      const dt = performance.now() - t0;
      if (dt > 200) perfReport('scan-notes', dt, `count=${loaded.length}`);
      // 迟到保护：扫描期间配置变更时，权威结果须按当前配置裁剪——
      // 新增文件夹的增量行按前缀保留（避免计数跌落），已移除文件夹的笔记过滤（避免移除行复活）
      const now = useSettingsStore.getState().config.extra_folders || [];
      const nowNorm = now.map(p => p.replace(/\\/g, '/').toLowerCase());
      const added = nowNorm.filter(f => !callFolders.includes(f));
      const removed = callFolders.filter(f => !nowNorm.includes(f));
      let merged = loaded;
      if (removed.length > 0) {
        merged = merged.filter(n => {
          const np = n.path.replace(/\\/g, '/').toLowerCase();
          return !removed.some(r => np === r || np.startsWith(r + '/'));
        });
      }
      if (added.length > 0) {
        const have = new Set(merged.map(n => n.path.replace(/\\/g, '/').toLowerCase()));
        const keep = allNotesRef.current.filter(n => {
          const np = n.path.replace(/\\/g, '/').toLowerCase();
          return !have.has(np) && added.some(a => np === a || np.startsWith(a + '/'));
        });
        if (keep.length > 0) {
          merged = [...merged, ...keep].sort((a, b) => b.modified_at.localeCompare(a.modified_at));
        }
      }
      setAllNotes(merged);
      useNotesStore.getState().setNotesFromCache(merged);
      try { localStorage.setItem('miaoyan.scanTotal', String(merged.length)); } catch { /* 隐私模式等场景忽略 */ }
    } catch (e) { console.error('Failed to load all notes:', e); }
    finally { setScanning(false); }
  }, []);

  // Load all notes on mount / storage change / mixed folder changes;
  // 纯新增由导入链路 scan_folder 增量扫描（chunk 事件自动合并）、纯移除由 removeFolderLocal 本地过滤，均跳过避免全库重扫
  const prevExtraRef = useRef<string[] | null>(null);
  useEffect(() => {
    const prev = prevExtraRef.current;
    const next = config.extra_folders || [];
    prevExtraRef.current = next;
    if (prev !== null) {
      const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
      const added = next.filter(f => !prev.some(p => norm(p) === norm(f)));
      const removed = prev.filter(f => !next.some(p => norm(p) === norm(f)));
      if (added.length === 0 || removed.length === 0) return;
    }
    reloadAllNotes();
  }, [config.storage_path, config.extra_folders, reloadAllNotes]);

  // 非扫描态下把当前总数回写持久化（增量导入/文件监听变更后，下次启动的分数分母即时准确）
  useEffect(() => {
    if (!scanning && allNotes.length > 0) {
      try { localStorage.setItem('miaoyan.scanTotal', String(allNotes.length)); } catch { /* 隐私模式等场景忽略 */ }
    }
  }, [allNotes, scanning]);

  /* ── 渐进加载：Rust 每扫完一个顶层目录发 chunk 事件，前端立即并入，首屏/全量刷新逐目录实时显示 ── */
  useEffect(() => {
    const unNotes = listen<{ dir: string; notes: NoteMetadata[] }>('miaoyan://notes-chunk', (e) => {
      // 在途扫描的 chunk 可能属于已移除文件夹：只并入当前根（storage_path + extra_folders）之下的笔记
      const cfg = useSettingsStore.getState().config;
      const roots = [cfg.storage_path, ...(cfg.extra_folders || [])].filter(Boolean)
        .map(p => p.replace(/\\/g, '/').toLowerCase());
      const valid = e.payload.notes.filter(n => {
        const np = n.path.replace(/\\/g, '/').toLowerCase();
        return roots.some(r => np === r || np.startsWith(r + '/'));
      });
      if (valid.length === 0) return;
      // 按本 chunk 路径集合精确去重（顶层文件 chunk 的 dir 为根目录，前缀剔除会误删整棵子树）
      const incoming = new Set(valid.map(n => n.path.replace(/\\/g, '/').toLowerCase()));
      setAllNotes(prev => {
        const next = [
          ...prev.filter(n => !incoming.has(n.path.replace(/\\/g, '/').toLowerCase())),
          ...valid,
        ].sort((a, b) => b.modified_at.localeCompare(a.modified_at));
        allNotesRef.current = next;
        useNotesStore.getState().setNotesFromCache(next);
        return next;
      });
    });
    const unProjects = listen<Project>('miaoyan://project-chunk', (e) => {
      useNotesStore.getState().mergeProjectChunk(e.payload);
    });
    const unTotal = listen<number>('miaoyan://scan-total', (e) => {
      setScanTotal(e.payload);
    });
    return () => { unNotes.then(fn => fn()); unProjects.then(fn => fn()); unTotal.then(fn => fn()); };
  }, []);

  /* ── Refresh local cache + store notes + projects (single disk scan) ── */
  const handleRefreshAll = useCallback(async () => {
    await reloadAllNotes();
    await loadProjects(config.storage_path);
  }, [reloadAllNotes, loadProjects, config.storage_path]);

  /* ── 增量移除额外文件夹：本地立即过滤文件夹行与其笔记，零全扫（行与计数同帧消失） ── */
  const removeFolderLocal = useCallback((folderPath: string) => {
    const rm = folderPath.replace(/\\/g, '/').toLowerCase();
    const inRemoved = (np: string) => np === rm || np.startsWith(rm + '/');
    const strip = (list: Project[]): Project[] => list
      .filter(p => !inRemoved(p.path.replace(/\\/g, '/').toLowerCase()))
      .map(p => ({ ...p, children: strip(p.children) }));
    useNotesStore.setState(s => ({ projects: strip(s.projects) }));
    setAllNotes(prev => {
      const next = prev.filter(n => !inRemoved(n.path.replace(/\\/g, '/').toLowerCase()));
      allNotesRef.current = next;
      useNotesStore.getState().setNotesFromCache(next);
      return next;
    });
  }, []);

  /* ── Watch filesystem changes ── */
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingFiles = new Map<string, string>(); // path -> 最近事件类型
    let needsFull = false;

    // Start watching storage path + extra folders
    const watchPaths = [config.storage_path, ...(config.extra_folders || [])].filter(Boolean);
    if (watchPaths.length > 0) {
      startWatching(watchPaths).catch(e => console.error('Failed to start watcher:', e));
    }

    // 文件级增量更新：只对变更文件取元数据，不重扫目录树
    const applyIncremental = async (files: Map<string, string>) => {
      try {
        const cfg = useSettingsStore.getState().config;
        const paths = [...files.keys()];
        const probePaths = paths.filter(p => files.get(p) !== 'remove');
        const upsertedRaw = probePaths.length
          ? await getNotesMetadata(probePaths, cfg.storage_path, cfg.extra_folders || [])
          : [];
        // 外部变更可能来自已移除文件夹：只接受当前根之下的笔记，避免移除行复活
        const roots = [cfg.storage_path, ...(cfg.extra_folders || [])].filter(Boolean)
          .map(p => p.replace(/\\/g, '/').toLowerCase());
        const upserted = upsertedRaw.filter(n => {
          const np = n.path.replace(/\\/g, '/').toLowerCase();
          return roots.some(r => np === r || np.startsWith(r + '/'));
        });
        const upsertedSet = new Set(upserted.map(n => n.path.replace(/\\/g, '/')));
        const removedSet = new Set(
          paths.filter(p => files.get(p) === 'remove').map(p => p.replace(/\\/g, '/'))
        );
        // create/modify 事件但文件已读不到 → 视为删除
        for (const p of probePaths) {
          if (!upsertedSet.has(p.replace(/\\/g, '/'))) removedSet.add(p.replace(/\\/g, '/'));
        }
        const prev = allNotesRef.current;
        const next = [
          ...prev.filter(n => {
            const key = n.path.replace(/\\/g, '/');
            return !removedSet.has(key) && !upsertedSet.has(key);
          }),
          ...upserted,
        ].sort((a, b) => b.modified_at.localeCompare(a.modified_at));
        allNotesRef.current = next;
        setAllNotes(next);
        useNotesStore.getState().setNotesFromCache(next);
        // 外部变更的打开标签重载内容
        useNotesStore.getState().reloadOpenTabs(paths);
      } catch (e) {
        console.error('Incremental refresh failed, falling back to full scan:', e);
        await reloadAllNotes();
      }
    };

    const unlisten = listen<{ type: string; paths: string[] }>('fs-change', (event) => {
      // 吞掉应用自身写入的回环事件（自动保存不再触发任何刷新）
      const external = event.payload.paths.filter(p => !useNotesStore.getState().consumeRecentWrite(p));
      if (external.length === 0) return;

      for (const p of external) {
        if (isNoteFilePath(p)) {
          pendingFiles.set(p, event.payload.type);
        } else {
          needsFull = true; // 目录级变更（新建/重命名/删除文件夹）才需全量刷新
        }
      }

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        const files = pendingFiles;
        pendingFiles = new Map();
        const full = needsFull;
        needsFull = false;
        if (full) {
          await reloadAllNotes();
          await loadProjects(config.storage_path);
          if (files.size > 0) {
            useNotesStore.getState().reloadOpenTabs([...files.keys()]);
          }
        } else if (files.size > 0) {
          await applyIncremental(files);
        }
      }, 400);
    });

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      unlisten.then(fn => fn());
    };
  }, [config.storage_path, config.extra_folders, reloadAllNotes, loadProjects]);

  /* ── Sync external search query (e.g. deep link) into local input ── */
  useEffect(() => {
    if (document.activeElement !== searchRef.current && searchQuery !== searchInput) {
      setSearchInput(searchQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  /* ── Search filter (local, by title) ── */
  const filteredNotes = useMemo(() => {
    const q = searchInput.trim().toLowerCase();
    if (!q) return allNotes;
    return allNotes.filter(n => n.title.toLowerCase().includes(q));
  }, [allNotes, searchInput]);

  /* ── Group notes by parent folder path ── */
  const notesByFolder = useMemo(() => {
    const map: Record<string, NoteMetadata[]> = {};
    for (const note of filteredNotes) {
      const fp = getParentPath(note.path);
      if (!map[fp]) map[fp] = [];
      map[fp].push(note);
    }
    return map;
  }, [filteredNotes]);

  /* ── Precomputed note counts per folder (including subfolders) ── */
  const folderCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const [folder, list] of Object.entries(notesByFolder)) {
      let cur = folder;
      for (;;) {
        counts[cur] = (counts[cur] || 0) + list.length;
        const idx = Math.max(cur.lastIndexOf('\\'), cur.lastIndexOf('/'));
        if (idx <= 0) break;
        cur = cur.slice(0, idx);
      }
    }
    return counts;
  }, [notesByFolder]);

  const countNotesIn = useCallback((folderPath: string) =>
    folderCounts[folderPath] || 0, [folderCounts]);

  /* ── Toggle folder expand ── */
  const toggleFolderExpand = useCallback((path: string) => {
    toggleExpandedFolder(path);
  }, [toggleExpandedFolder]);

  /* ── Create note (in right-clicked folder) ── */
  const handleNewFileInFolder = useCallback(async () => {
    if (!contextMenu || contextMenu.type !== 'folder') return;
    try {
      const note = await createNote(contextMenu.project.path, `Untitled-${Date.now()}`);
      await handleRefreshAll();
      await loadProjects(config.storage_path);
      await selectNote(note);
    } catch (e) { console.error('Failed to create note:', e); }
    setContextMenu(null);
  }, [contextMenu, handleRefreshAll, loadProjects, config.storage_path, selectNote]);

  /* ── Note context menu handlers ── */
  const handleDeleteNote = useCallback(async () => {
    if (!contextMenu || contextMenu.type !== 'note') return;
    try { await deleteNote(contextMenu.note.path); await handleRefreshAll(); }
    catch (e) { console.error('Failed to delete note:', e); }
    setContextMenu(null);
  }, [contextMenu, handleRefreshAll]);

  const handleStartRenameNote = useCallback(() => {
    if (!contextMenu || contextMenu.type !== 'note') return;
    setRenamingNoteId(contextMenu.note.id);
    setRenameNoteValue(contextMenu.note.title);
    setContextMenu(null);
  }, [contextMenu]);

  const handleRenameNoteSubmit = useCallback(async (note: NoteMetadata) => {
    if (!renameNoteValue.trim() || renameNoteValue === note.title) { setRenamingNoteId(null); return; }
    try { await renameNote(note.path, renameNoteValue.trim()); await handleRefreshAll(); }
    catch (e) { console.error('Failed to rename note:', e); }
    setRenamingNoteId(null);
  }, [renameNoteValue, handleRefreshAll]);

  const handleEncryptNote = useCallback(() => {
    if (!contextMenu || contextMenu.type !== 'note') return;
    setEncryptionDialog({ visible: true, mode: 'encrypt', notePath: contextMenu.note.path });
    setContextMenu(null);
  }, [contextMenu, setEncryptionDialog]);

  const handleRemoveEncryption = useCallback(() => {
    if (!contextMenu || contextMenu.type !== 'note') return;
    setEncryptionDialog({ visible: true, mode: 'remove', notePath: contextMenu.note.path });
    setContextMenu(null);
  }, [contextMenu, setEncryptionDialog]);

  const handleCopyName = useCallback(async (name: string) => {
    try {
      await navigator.clipboard.writeText(name);
    } catch (e) {
      console.error('Failed to copy name:', e);
    }
    setContextMenu(null);
  }, []);

  /* ── Folder context menu handlers ── */
  const handleNewSubfolder = useCallback(async () => {
    if (!contextMenu || contextMenu.type !== 'folder') return;
    const name = prompt(t('sidebar.newFolder'));
    if (!name) return;
    try {
      await createFolder(contextMenu.project.path, name);
      await loadProjects(config.storage_path);
    } catch (e) { console.error('Failed to create subfolder:', e); }
    setContextMenu(null);
  }, [contextMenu, loadProjects, config.storage_path, t]);

  const handleStartRenameFolder = useCallback(() => {
    if (!contextMenu || contextMenu.type !== 'folder') return;
    setRenamingFolderPath(contextMenu.project.path);
    setRenameFolderValue(contextMenu.project.name);
    setContextMenu(null);
  }, [contextMenu]);

  const handleRenameFolderSubmit = useCallback(async (project: Project) => {
    if (!renameFolderValue.trim() || renameFolderValue.trim() === project.name) { setRenamingFolderPath(null); return; }
    try { await renameFolder(project.path, renameFolderValue.trim()); await loadProjects(config.storage_path); }
    catch (e) { console.error('Failed to rename folder:', e); }
    setRenamingFolderPath(null);
  }, [renameFolderValue, loadProjects, config.storage_path]);

  const handleDeleteFolder = useCallback(async () => {
    if (!contextMenu || contextMenu.type !== 'folder') return;
    try {
      await deleteFolder(contextMenu.project.path);
      await loadProjects(config.storage_path);
      await handleRefreshAll();
    } catch (e) { console.error('Failed to delete folder:', e); }
    setContextMenu(null);
  }, [contextMenu, loadProjects, handleRefreshAll]);

  const handleRevealInFinder = useCallback(async () => {
    if (!contextMenu || contextMenu.type !== 'folder') return;
    try { await revealInFinder(contextMenu.project.path); }
    catch (e) { console.error('Failed to reveal in Finder:', e); }
    setContextMenu(null);
  }, [contextMenu]);

  const handleOpenInTerminal = useCallback(async () => {
    if (!contextMenu || contextMenu.type !== 'folder') return;
    try { await openInTerminal(contextMenu.project.path); }
    catch (e) { console.error('Failed to open in Terminal:', e); }
    setContextMenu(null);
  }, [contextMenu]);

  /* ── Close context menu ── */
  useEffect(() => {
    const handler = () => { if (contextMenu) setContextMenu(null); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [contextMenu]);

  /* ── Global: focus search via Cmd+F ── */
  useEffect(() => {
    const handler = () => { searchRef.current?.focus(); searchRef.current?.select(); };
    window.addEventListener('sidebar-focus-search', handler);
    return () => window.removeEventListener('sidebar-focus-search', handler);
  }, []);

  /* ── Global: rename active note via Cmd+R ── */
  useEffect(() => {
    const handler = () => {
      const an = useNotesStore.getState().activeNote;
      if (!an) return;
      setRenamingNoteId(an.id);
      setRenameNoteValue(an.title);
    };
    window.addEventListener('sidebar-rename-note', handler);
    return () => window.removeEventListener('sidebar-rename-note', handler);
  }, []);

  /* ── Render a note row ── */
  const renderNoteRow = (note: NoteMetadata, depth: number) => {
    const isActive = activeNote?.id === note.id;
    const isRenaming = renamingNoteId === note.id;
    const typeIcon = getFileTypeIcon(note.path);
    return (
      <div
        key={`note-${note.id}`}
        className="flex items-center gap-1 cursor-pointer text-xs transition-colors"
        style={rowStyle(depth, isActive, true)}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('application/note-path', note.path);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onClick={() => selectNote(note)}
        onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, type: 'note', note }); }}
        onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'; }}
        onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = 'transparent'; }}
      >
        <span className="flex-shrink-0 flex items-center" style={{ color: typeIcon.color, opacity: 0.85 }}>{typeIcon.icon}</span>
        {note.is_encrypted && <span className="flex-shrink-0" style={{ color: 'var(--text-tertiary)', opacity: 0.6 }}><IconLockSmall /></span>}
        {isRenaming ? (
          <input
            autoFocus value={renameNoteValue}
            onChange={(e) => setRenameNoteValue(e.target.value)}
            onBlur={() => handleRenameNoteSubmit(note)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRenameNoteSubmit(note); if (e.key === 'Escape') setRenamingNoteId(null); }}
            className="flex-1 min-w-0 px-1 py-0 text-xs rounded outline-none"
            style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--accent)' }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="truncate" style={{ color: isActive ? 'var(--accent-icon)' : 'var(--text-primary)' }}>
            {note.title}
          </span>
        )}
        <span className="flex-shrink-0 text-[10px] ml-auto opacity-50">{formatDate(note.modified_at)}</span>
      </div>
    );
  };

  /* ── Check if folder or its descendants match the search query ── */
  const folderMatchesSearch = useCallback((project: Project, query: string): boolean => {
    if (!query) return true;
    const q = query.toLowerCase();
    // Match folder name
    if (project.name.toLowerCase().includes(q)) return true;
    // Match notes directly in this folder
    const notes = notesByFolder[project.path] || [];
    if (notes.length > 0) return true;
    // Recursively check child folders
    return project.children.some(child => folderMatchesSearch(child, query));
  }, [notesByFolder]);

  /* ── Persist expanded folders when search is cleared ── */
  const prevSearchRef = useRef(searchInput);
  useEffect(() => {
    const prev = prevSearchRef.current.trim();
    const curr = searchInput.trim();
    prevSearchRef.current = searchInput;
    if (prev && !curr) {
      // No folder selected → collapse all auto-expanded folders
        clearExpandedFolders();
    }
  }, [searchInput, clearExpandedFolders]);

  /* ── Flatten visible rows for virtualized rendering ── */
  type TreeRow =
    | { kind: 'folder'; project: Project; depth: number }
    | { kind: 'note'; note: NoteMetadata; depth: number };

  const rows = useMemo<TreeRow[]>(() => {
    const out: TreeRow[] = [];
    if (!allNotesExpanded) return out;
    const q = searchInput.trim();
    const walk = (project: Project, depth: number) => {
      if (q && !folderMatchesSearch(project, q)) return;
      out.push({ kind: 'folder', project, depth });
      const isExpanded = q ? true : expandedFolders.includes(project.path);
      if (isExpanded) {
        project.children.forEach(child => walk(child, depth + 1));
        (notesByFolder[project.path] || []).forEach(note => out.push({ kind: 'note', note, depth: depth + 1 }));
      }
    };
    projects.forEach(p => walk(p, 0));
    (notesByFolder[config.storage_path] || []).forEach(note => out.push({ kind: 'note', note, depth: 0 }));
    return out;
  }, [allNotesExpanded, searchInput, folderMatchesSearch, expandedFolders, notesByFolder, projects, config.storage_path]);

  const treeRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => treeRef.current,
    estimateSize: () => 26,
    overscan: 20,
  });

  /* ── Render a folder row (content only; recursion handled by rows flattening) ── */
  const renderFolderRow = (project: Project, depth: number) => {
    const query = searchInput.trim();
    const isExpanded = query ? true : expandedFolders.includes(project.path);
    const isActive = false;
    const isRenaming = renamingFolderPath === project.path;
    const noteCount = countNotesIn(project.path);

    return (
      <div
        className="group flex items-center gap-1 cursor-pointer text-xs transition-colors"
        style={rowStyle(depth, isActive)}
        onClick={() => toggleFolderExpand(project.path)}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); if (!isActive) e.currentTarget.style.backgroundColor = 'var(--accent-light)'; }}
        onDragLeave={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = 'transparent'; }}
        onDrop={async (e) => {
          e.preventDefault(); e.stopPropagation();
          const notePath = e.dataTransfer.getData('application/note-path');
          if (notePath) {
            try {
              await moveNote(notePath, project.path);
              await handleRefreshAll();
              await loadProjects(config.storage_path);
            } catch (err) { console.error('Failed to move note:', err); }
          }
          e.currentTarget.style.backgroundColor = isActive ? 'var(--accent-light)' : 'transparent';
        }}
        onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, type: 'folder', project }); }}
        onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'; }}
        onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = 'transparent'; }}
      >
        <span
          className="w-3 h-3 flex items-center justify-center flex-shrink-0 opacity-50"
          onClick={(e) => { e.stopPropagation(); toggleFolderExpand(project.path); }}
        >
          {isExpanded ? <IconChevronDown /> : <IconChevronRight />}
        </span>
        <span className="flex-shrink-0 opacity-60"><IconFolder /></span>
        {isRenaming ? (
          <input
            autoFocus value={renameFolderValue}
            onChange={(e) => setRenameFolderValue(e.target.value)}
            onBlur={() => handleRenameFolderSubmit(project)}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenamingFolderPath(null); }}
            className="truncate outline-none"
            style={{
              background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
              border: '1px solid var(--accent-icon)', borderRadius: '3px',
              padding: '0 4px', fontSize: 'inherit', lineHeight: 'inherit',
              width: '0', minWidth: '60px', flex: '1 1 auto',
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="truncate">{project.name}</span>
        )}
        {noteCount > 0 && (
          <span className="flex-shrink-0 text-[10px] ml-auto opacity-40">{noteCount}</span>
        )}
        {config.extra_folders.includes(project.path) && (
          <button
            className="flex-shrink-0 opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity p-0.5"
            style={{ color: 'var(--text-tertiary)' }}
            onClick={(e) => {
              e.stopPropagation();
              const newFolders = config.extra_folders.filter(f => f !== project.path);
              useSettingsStore.getState().updateConfig({ extra_folders: newFolders });
              // 增量移除：本地立即过滤，不触发全库重扫
              removeFolderLocal(project.path);
            }}
            title="Remove from tree (keeps local files)"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col border-r sidebar-transition" style={{ backgroundColor: 'var(--bg-sidebar)', borderColor: 'var(--border)' }}>
      {/* Search + Actions */}
      <div className="px-2 pt-2 pb-1">
        <div className="flex items-center gap-1">
          <div className="flex-1 flex items-center gap-1.5 px-2 rounded-md text-xs"
            style={{ backgroundColor: 'var(--bg-tertiary)', height: '26px' }}>
            <span style={{ color: 'var(--text-tertiary)' }}><IconSearch /></span>
            <input
              ref={searchRef}
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t('notesList.search')}
              className="flex-1 bg-transparent outline-none text-xs"
              style={{ color: 'var(--text-primary)' }}
            />
          </div>
        </div>
      </div>

      {/* Sync status */}
      <div className="px-3 py-0.5 flex items-center justify-end">
        <SyncStatusIndicator compact />
      </div>

      {/* Tree */}
      <div ref={treeRef} className="flex-1 overflow-y-auto py-0.5">
        {/* All Notes */}
        <div
          className="flex items-center gap-1.5 cursor-pointer text-xs transition-colors"
          style={{
            paddingLeft: '10px', paddingRight: '8px',
            height: '28px',
            color: 'var(--accent-icon)',
            backgroundColor: 'var(--accent-light)',
            borderRadius: '6px',
          }}
          onClick={() => setAllNotesExpanded(!allNotesExpanded)}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'var(--accent-light)'}
        >
          <span className="w-3 h-3 flex items-center justify-center flex-shrink-0 opacity-50"
            onClick={(e) => { e.stopPropagation(); setAllNotesExpanded(!allNotesExpanded); }}>
            {allNotesExpanded ? <IconChevronDown /> : <IconChevronRight />}
          </span>
          <span className="flex-shrink-0"><IconHome /></span>
          <span className="font-medium">{t('sidebar.allNotes')}</span>
          <span className="ml-auto text-[10px] opacity-50">{scanning ? (scanTotal > 0 ? `${allNotes.length}/${Math.max(scanTotal, allNotes.length)}` : `${allNotes.length}/…`) : allNotes.length}</span>
        </div>

        {/* Tree content (virtualized: only visible rows are mounted) */}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', overflow: 'hidden' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index];
            return (
              <div
                key={row.kind === 'folder' ? `folder-${row.project.path}` : `note-${row.note.id}`}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: vi.size, transform: `translateY(${vi.start}px)` }}
              >
                {row.kind === 'folder' ? renderFolderRow(row.project, row.depth) : renderNoteRow(row.note, row.depth)}
              </div>
            );
          })}
        </div>

        {/* Loading / Empty */}
        {isLoading && allNotes.length === 0 ? (
          <div className="flex items-center justify-center h-12 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>Loading...</div>
        ) : filteredNotes.length === 0 && searchInput.trim() ? (
          <div className="flex items-center justify-center h-12 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            {t('notesList.noResults')}
          </div>
        ) : null}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="fixed z-[9999] rounded-lg px-1 py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y, backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)', boxShadow: '0 4px 16px rgba(0,0,0,0.2)' }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {contextMenu.type === 'note' ? (
            <>
              {/* Note context menu */}
              <button onClick={handleStartRenameNote} className="w-full text-left text-xs rounded-md"
                style={{ color: 'var(--text-primary)', padding: '5px 12px' }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
                {t('contextMenu.rename')}
              </button>
              <button onClick={() => handleCopyName(contextMenu.note.title)} className="w-full text-left text-xs rounded-md"
                style={{ color: 'var(--text-primary)', padding: '5px 12px' }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
                {t('contextMenu.copyName')}
              </button>
              <button onClick={() => handleCopyName(contextMenu.note.path)} className="w-full text-left text-xs rounded-md"
                style={{ color: 'var(--text-primary)', padding: '5px 12px' }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
                {t('contextMenu.copyPath')}
              </button>
              <div style={{ borderTop: '1px solid var(--border)', margin: '3px 0' }} />
              {contextMenu.note.is_encrypted ? (
                <button onClick={handleRemoveEncryption} className="w-full text-left text-xs rounded-md"
                  style={{ color: 'var(--text-primary)', padding: '5px 12px' }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
                  {t('encryption.removeEncryption')}
                </button>
              ) : (
                <button onClick={handleEncryptNote} className="w-full text-left text-xs rounded-md"
                  style={{ color: 'var(--text-primary)', padding: '5px 12px' }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
                  {t('encryption.encrypt')}
                </button>
              )}
              <div style={{ borderTop: '1px solid var(--border)', margin: '3px 0' }} />
              <button onClick={handleDeleteNote} className="w-full text-left text-xs rounded-md"
                style={{ color: 'var(--danger-color)', padding: '5px 12px' }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
                {t('contextMenu.delete')}
              </button>
            </>
          ) : (
            <>
              {/* Folder context menu */}
              <div className="flex items-center gap-2 cursor-pointer text-xs"
                style={{ padding: '5px 12px', color: 'var(--text-primary)' }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                onClick={handleNewFileInFolder}>
                <span style={{ opacity: 0.6 }}><IconFile /></span>
                <span>{t('folderMenu.newFile')}</span>
              </div>
              <div className="flex items-center gap-2 cursor-pointer text-xs"
                style={{ padding: '5px 12px', color: 'var(--text-primary)' }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                onClick={handleNewSubfolder}>
                <span style={{ opacity: 0.6 }}><IconFolderPlus /></span>
                <span>{t('folderMenu.newSubfolder')}</span>
              </div>
              <div className="flex items-center gap-2 cursor-pointer text-xs"
                style={{ padding: '5px 12px', color: 'var(--text-primary)' }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                onClick={handleStartRenameFolder}>
                <span style={{ opacity: 0.6 }}><IconEdit /></span>
                <span>{t('folderMenu.rename')}</span>
              </div>
              <div className="flex items-center gap-2 cursor-pointer text-xs"
                style={{ padding: '5px 12px', color: 'var(--text-primary)' }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                onClick={() => handleCopyName(contextMenu.project.name)}>
                <span style={{ opacity: 0.6 }}><IconCopy /></span>
                <span>{t('folderMenu.copyName')}</span>
              </div>
              <div className="flex items-center gap-2 cursor-pointer text-xs"
                style={{ padding: '5px 12px', color: 'var(--text-primary)' }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                onClick={handleRevealInFinder}>
                <span style={{ opacity: 0.6 }}><IconFinder /></span>
                <span>{t('folderMenu.revealInFinder')}</span>
              </div>
              <div className="flex items-center gap-2 cursor-pointer text-xs"
                style={{ padding: '5px 12px', color: 'var(--text-primary)' }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                onClick={handleOpenInTerminal}>
                <span style={{ opacity: 0.6 }}><IconTerminal /></span>
                <span>{t('folderMenu.openInTerminal')}</span>
              </div>
              <div className="flex items-center gap-2 cursor-pointer text-xs"
                style={{ padding: '5px 12px', color: 'var(--text-primary)' }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                onClick={() => handleCopyName(contextMenu.project.path)}>
                <span style={{ opacity: 0.6 }}><IconCopy /></span>
                <span>{t('folderMenu.copyPath')}</span>
              </div>
              <div style={{ borderTop: '1px solid var(--border)', margin: '3px 0' }} />
              <div className="flex items-center gap-2 cursor-pointer text-xs"
                style={{ padding: '5px 12px', color: '#e55' }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                onClick={handleDeleteFolder}>
                <span style={{ opacity: 0.8 }}><IconTrash /></span>
                <span>{t('folderMenu.delete')}</span>
              </div>
            </>
          )}
        </div>
      )}

      {/* Encryption Dialog */}
      {encryptionDialog && (
        <EncryptionDialog
          mode={encryptionDialog.mode}
          notePath={encryptionDialog.notePath}
          visible={encryptionDialog.visible}
          onClose={() => setEncryptionDialog(null)}
          onUnlocked={(content, password) => { onNoteUnlocked(content, password); }}
          onEncrypted={() => handleRefreshAll()}
          onRemoved={() => handleRefreshAll()}
        />
      )}
    </div>
  );
}
