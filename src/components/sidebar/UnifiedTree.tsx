import { useState, useCallback, useRef, useEffect, useMemo, useLayoutEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useVirtualizer } from '@tanstack/react-virtual';
import { listen } from '@tauri-apps/api/event';
import type { Project, NoteMetadata } from '../../types';
import { documentRenameTarget, useNotesStore } from '../../stores/notes-store';
import { useSettingsStore } from '../../stores/settings-store';
import {
  renameNote,
  createFolder, moveNote, renameFolder,
  revealInFinder, openInTerminal, getAllNotes, getNotesMetadata,
  startWatching, readDirectorySnapshot, getScanId, isCurrentScan, scopeRootsOverlap, type ScanEvent,
} from '../../services/tauri-bridge';
import { useTranslation } from 'react-i18next';
import { SyncStatusIndicator } from '../shared/SyncStatus';
import { EncryptionDialog } from '../shared/EncryptionDialog';
import { perfReport } from '../../services/perf';
import { isPdfPath, noteMatchesSearchType } from '../../utils/fileType';
import type { SearchFileType } from '../../utils/fileType';
import { pathIdentity, isPathWithin } from '../../utils/path-identity';

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
/* PDF 文档图标（文档 + PDF 字样） */
const IconFilePdf = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
    <path d="M7.5 17v-4h1.2a1.3 1.3 0 0 1 0 2.6H7.5M12.5 17v-4h1a2 2 0 0 1 0 4zM18.5 13H16.5v4" />
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
  if (lower.endsWith('.pdf')) {
    return { icon: <IconFilePdf />, color: '#e05252' };
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
  return /\.(md|markdown|txt|html|htm|pdf)$/.test(lower) || lower.endsWith('.md.encrypted');
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${m}/${day}`;
}

function stripKnownExt(title: string): string {
  return title.replace(/\.(md|markdown|txt)$/i, '');
}

/* ── 路径归一化：Windows 分隔符 / 大小写不敏感 ── */
const normPath = (p: string) => p.replace(/\\/g, '/').toLowerCase();
const slashPath = (p: string) => p.replace(/\\/g, '/');
const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const isUnderPath = (p: string, root: string) => {
  const np = normPath(p);
  const nr = normPath(root);
  return np === nr || np.startsWith(`${nr}/`);
};
const remapPath = (p: string, from: string, to: string) =>
  slashPath(to) + slashPath(p).slice(slashPath(from).length);
const sortProjects = (list: Project[]) =>
  [...list].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
const projectTreeHas = (list: Project[], path: string): boolean =>
  list.some(p => isUnderPath(p.path, path) || projectTreeHas(p.children, path));
const sameNoteMeta = (a: NoteMetadata, b: NoteMetadata) =>
  a.title === b.title && a.modified_at === b.modified_at && a.size === b.size &&
  a.is_encrypted === b.is_encrypted;

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
    expandedFolders, allNotesExpanded, searchQuery, searchResults, searchStatus, searchError, setSearchQuery,
    searchScope, searchType, setSearchFilters,
    toggleExpandedFolder, setAllNotesExpanded,
  } = useNotesStore(useShallow((s) => ({
    projects: s.projects, activeNote: s.activeNote,
    selectNote: s.selectNote,
    isLoading: s.isLoading, loadProjects: s.loadProjects,
    encryptionDialog: s.encryptionDialog, setEncryptionDialog: s.setEncryptionDialog, onNoteUnlocked: s.onNoteUnlocked,
    expandedFolders: s.expandedFolders, allNotesExpanded: s.allNotesExpanded, searchQuery: s.searchQuery,
    searchResults: s.searchResults, searchStatus: s.searchStatus, searchError: s.searchError, setSearchQuery: s.setSearchQuery,
    searchScope: s.searchScope, searchType: s.searchType, setSearchFilters: s.setSearchFilters,
    toggleExpandedFolder: s.toggleExpandedFolder, setAllNotesExpanded: s.setAllNotesExpanded,
  })));
  const { config } = useSettingsStore();

  const [contextMenu, setContextMenu] = useState<TreeContextMenu>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersActive = searchScope !== 'content' || searchType !== 'all';
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!contextMenu) return;
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.max(8, Math.min(contextMenu.x, window.innerWidth - rect.width - 8));
    const y = Math.max(8, Math.min(contextMenu.y, window.innerHeight - rect.height - 8));
    setMenuPos({ x, y });
  }, [contextMenu]);
  const [renamingNoteId, setRenamingNoteId] = useState<string | null>(null);
  const [renameNoteValue, setRenameNoteValue] = useState('');
  const [renamingFolderPath, setRenamingFolderPath] = useState<string | null>(null);
  const [renameFolderValue, setRenameFolderValue] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const searchInput = searchQuery;
  const setSearchInput = (query: string) => { void setSearchQuery(query, config.storage_path); };
  useEffect(() => {
    const query = useNotesStore.getState().searchQuery;
    if (query.trim()) void setSearchQuery(query, config.storage_path);
  }, [config.storage_path, config.extra_folders, setSearchQuery]);

  /* ── Local cache of ALL notes (not filtered by active folder) ── */
  const [allNotes, setAllNotes] = useState<NoteMetadata[]>([]);
  const allNotesRef = useRef(allNotes);
  useEffect(() => { allNotesRef.current = allNotes; }, [allNotes]);

  /* ── 渐进加载进度：扫描期间「全部笔记」右侧显示 已加载/总数，完成后只显示总数 ──
     总数优先用上次会话持久值（启动即可显示分数），Rust scan-total 事件到达后校正 ── */
  const [scanning, setScanning] = useState(false);
  const fullLoadGeneration = useRef(0);
  const libraryMounted = useRef(true);
  const storageRevision = useSettingsStore(s => s.storageRevision);
  const savingSettings = useSettingsStore(s => s.saveStatus === 'saving');
  const [scanTotal, setScanTotal] = useState(() => {
    try { return Number(localStorage.getItem('miaoyan.scanTotal')) || 0; } catch { return 0; }
  });

  const reloadAllNotes = useCallback(async () => {
    if (!libraryMounted.current) return;
    const generation = ++fullLoadGeneration.current;
    const { config: cfg, storageRevision: revision } = useSettingsStore.getState();
    const pending = getAllNotes(cfg.storage_path, cfg.extra_folders);
    const scanId = getScanId(pending);
    const isCurrent = () => {
      const current = useSettingsStore.getState();
      return libraryMounted.current && generation === fullLoadGeneration.current && revision === current.storageRevision && isCurrentScan(scanId, 'notes', current.config.storage_path, current.config.extra_folders);
    };
    setScanning(true);
    try {
      const callFolders = (cfg.extra_folders || []).map(p => p.replace(/\\/g, '/').toLowerCase());
      // 扫描开始时的既有路径：用于识别扫描期间本地增量新增的行
      const beforePaths = new Set(allNotesRef.current.map(n => normPath(n.path)));
      const t0 = performance.now();
      const loaded = await pending;
      if (!isCurrent()) return;
      // 启动/全量刷新链路：目录扫描超过 200ms 记录
      const dt = performance.now() - t0;
      if (dt > 200) perfReport('scan-notes', dt, `count=${loaded.length}`);
      // 迟到保护：扫描期间配置变更时，权威结果须按当前配置裁剪——
      // 新增文件夹的增量行按前缀保留（避免计数跌落），已移除文件夹的笔记过滤（避免移除行复活）
      const current = useSettingsStore.getState().config;
      const now = current.extra_folders;
      const nowNorm = now.map(p => p.replace(/\\/g, '/').toLowerCase());
      const added = nowNorm.filter(f => !callFolders.includes(f));
      const roots = [current.storage_path, ...now].filter(Boolean);
      let merged = loaded.filter(note => roots.some(root => isPathWithin(note.path, root)));
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
      // 迟到保护：扫描期间由文件监听增量加入的笔记，不能被未包含它们的扫描结果抹掉
      const mergedPaths = new Set(merged.map(n => normPath(n.path)));
      const lateNotes = allNotesRef.current.filter(n => {
        const key = normPath(n.path);
        return roots.some(root => isPathWithin(n.path, root)) && !beforePaths.has(key) && !mergedPaths.has(key);
      });
      if (lateNotes.length > 0) {
        merged = [...merged, ...lateNotes].sort((a, b) => b.modified_at.localeCompare(a.modified_at));
      }
      setAllNotes(merged);
      useNotesStore.getState().setNotesFromCache(merged);
      try { localStorage.setItem('miaoyan.scanTotal', String(merged.length)); } catch { /* 隐私模式等场景忽略 */ }
    } catch (e) {
      if (isCurrent()) window.dispatchEvent(new CustomEvent('show-toast', { detail: { type: 'warning', message: `扫描未完成，已保留现有列表 / Scan incomplete; existing notes were kept: ${String(e)}` } }));
    } finally { if (isCurrent()) setScanning(false); }
  }, []);

  // Load all notes on mount / storage change / mixed folder changes;
  // 纯新增由导入链路 scan_folder 增量扫描（chunk 事件自动合并）、纯移除由 removeFolderLocal 本地过滤，均跳过避免全库重扫
  const prevLibraryRef = useRef<{ root: string; extras: string[]; revision: number } | null>(null);
  useEffect(() => {
    libraryMounted.current = true;
    return () => { libraryMounted.current = false; fullLoadGeneration.current++; prevLibraryRef.current = null; };
  }, []);
  useEffect(() => {
    const prev = prevLibraryRef.current;
    const next = config.extra_folders;
    prevLibraryRef.current = { root: config.storage_path, extras: next, revision: storageRevision };
    const mainChanged = prev === null || prev.revision !== storageRevision || pathIdentity(prev.root) !== pathIdentity(config.storage_path);
    if (prev !== null && mainChanged) {
      const roots = [config.storage_path, ...next].filter(Boolean);
      const kept = allNotesRef.current.filter(note => roots.some(root => isPathWithin(note.path, root)));
      allNotesRef.current = kept;
      setAllNotes(kept);
      useNotesStore.getState().setNotesFromCache(kept);
    }
    if (!mainChanged && prev !== null) {
      const added = next.filter(folder => !prev.extras.some(old => pathIdentity(old) === pathIdentity(folder)));
      const removed = prev.extras.filter(folder => !next.some(current => pathIdentity(current) === pathIdentity(folder)));
      if (added.length === 0 || removed.length === 0) return;
    }
    void reloadAllNotes();
  }, [config.storage_path, config.extra_folders, storageRevision, reloadAllNotes]);

  // 非扫描态下把当前总数回写持久化（增量导入/文件监听变更后，下次启动的分数分母即时准确）
  useEffect(() => {
    if (!scanning && allNotes.length > 0) {
      try { localStorage.setItem('miaoyan.scanTotal', String(allNotes.length)); } catch { /* 隐私模式等场景忽略 */ }
    }
  }, [allNotes, scanning]);

  /* ── 渐进加载：Rust 每扫完一个顶层目录发 chunk 事件，前端立即并入，首屏/全量刷新逐目录实时显示 ── */
  useEffect(() => {
    const unNotes = listen<ScanEvent<{ dir: string; notes: NoteMetadata[] }>>('miaoyan://notes-chunk', (e) => {
      const cfg = useSettingsStore.getState().config;
      if (!isCurrentScan(e.payload.scan_id, 'notes', cfg.storage_path, cfg.extra_folders)) return;
      const roots = [cfg.storage_path, ...cfg.extra_folders].filter(Boolean);
      const valid = e.payload.data.notes.filter(note => roots.some(root => isPathWithin(note.path, root)));
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
    const unProjects = listen<ScanEvent<Project>>('miaoyan://project-chunk', (e) => {
      const cfg = useSettingsStore.getState().config;
      if (isCurrentScan(e.payload.scan_id, 'projects', cfg.storage_path, cfg.extra_folders)) useNotesStore.getState().mergeProjectChunk(e.payload.data);
    });
    const unTotal = listen<ScanEvent<number>>('miaoyan://scan-total', (e) => {
      const cfg = useSettingsStore.getState().config;
      if (isCurrentScan(e.payload.scan_id, 'notes', cfg.storage_path, cfg.extra_folders)) setScanTotal(e.payload.data);
    });
    return () => { unNotes.then(fn => fn()); unProjects.then(fn => fn()); unTotal.then(fn => fn()); };
  }, []);

  /* ── Refresh local cache + store notes + projects (single disk scan) ── */
  const handleRefreshAll = useCallback(async () => {
    await reloadAllNotes();
    await loadProjects(config.storage_path);
  }, [reloadAllNotes, loadProjects, config.storage_path]);

  const removeFolderLocal = useCallback(async (folderPath: string): Promise<void> => {
    if (!libraryMounted.current) return;
    const current = useSettingsStore.getState();
    if (current.config.extra_folders.some(folder => pathIdentity(folder) === pathIdentity(folderPath))) return;
    const roots = [current.config.storage_path, ...current.config.extra_folders].filter(Boolean);
    const signature = JSON.stringify([current.storageRevision, ...roots.map(pathIdentity)]);
    try {
      const overlaps = await scopeRootsOverlap([folderPath], roots);
      if (!libraryMounted.current) return;
      const latest = useSettingsStore.getState();
      const latestRoots = [latest.config.storage_path, ...latest.config.extra_folders].filter(Boolean);
      if (signature !== JSON.stringify([latest.storageRevision, ...latestRoots.map(pathIdentity)])) {
        await removeFolderLocal(folderPath);
        return;
      }
      if (overlaps) {
        await Promise.all([reloadAllNotes(), loadProjects(latest.config.storage_path)]);
        return;
      }
      const strip = (list: Project[]): Project[] => list.filter(project => !isPathWithin(project.path, folderPath)).map(project => ({ ...project, children: strip(project.children) }));
      useNotesStore.setState(state => ({ projects: strip(state.projects), activeFolder: state.activeFolder && isPathWithin(state.activeFolder, folderPath) ? null : state.activeFolder }));
      setAllNotes(prev => {
        const next = prev.filter(note => !isPathWithin(note.path, folderPath));
        allNotesRef.current = next;
        useNotesStore.getState().setNotesFromCache(next);
        return next;
      });
    } catch (error) {
      if (!libraryMounted.current) return;
      const latest = useSettingsStore.getState();
      const latestRoots = [latest.config.storage_path, ...latest.config.extra_folders].filter(Boolean);
      if (signature !== JSON.stringify([latest.storageRevision, ...latestRoots.map(pathIdentity)])) {
        await removeFolderLocal(folderPath);
        return;
      }
      window.dispatchEvent(new CustomEvent('show-toast', { detail: { type: 'warning', message: `目录设置已保存，但视图校验失败，请刷新 / Folder settings saved; view validation failed, please refresh: ${String(error)}` } }));
    }
  }, [reloadAllNotes, loadProjects]);

  /* ── 增量换行（重命名/移动）：本地立即把旧路径行换成新路径行，零全扫 ──
     全量刷新的 chunk 是逐目录渐进并入，旧路径行要到扫描收尾才消失——期间新旧标题会并存闪现 */
  const renameNoteLocal = useCallback((oldPath: string, newPath: string, newTitle: string) => {
    const oldKey = oldPath.replace(/\\/g, '/').toLowerCase();
    setAllNotes(prev => {
      const existing = prev.find(n => n.path.replace(/\\/g, '/').toLowerCase() === oldKey);
      if (!existing) return prev;
      const next = [
        ...prev.filter(n => n.path.replace(/\\/g, '/').toLowerCase() !== oldKey),
        { ...existing, id: newPath, path: newPath, title: newTitle, is_encrypted: newPath.toLowerCase().endsWith('.encrypted') },
      ].sort((a, b) => b.modified_at.localeCompare(a.modified_at));
      allNotesRef.current = next;
      useNotesStore.getState().setNotesFromCache(next);
      return next;
    });
  }, []);

  // 重命名/移动的所有入口（侧栏行内、编辑器标题栏、拖拽移动）都经 applyNotePathChange 广播
  useEffect(() => {
    const handler = (e: Event) => {
      const { oldPath, newPath, newTitle } = (e as CustomEvent<{ oldPath: string; newPath: string; newTitle: string }>).detail;
      renameNoteLocal(oldPath, newPath, newTitle);
    };
    window.addEventListener('note-path-changed', handler);
    return () => window.removeEventListener('note-path-changed', handler);
  }, [renameNoteLocal]);

  /* ── 增量插行（新建/复制）：本地立即插入新笔记行，零全扫 ──
     全量刷新会让目录树先收空壳 chunk 再收完整 chunk，展开的子树收起又展开 */
  const insertNoteLocal = useCallback((note: NoteMetadata) => {
    const key = note.path.replace(/\\/g, '/');
    setAllNotes(prev => {
      const next = [note, ...prev.filter(n => n.path.replace(/\\/g, '/') !== key)]
        .sort((a, b) => b.modified_at.localeCompare(a.modified_at));
      allNotesRef.current = next;
      useNotesStore.getState().setNotesFromCache(next);
      return next;
    });
  }, []);

  // 新建的所有入口（侧栏右键新建、工具栏新建、Cmd+D 复制、deep-link）都经 registerCreatedNote 广播
  useEffect(() => {
    const handler = (e: Event) => {
      const { note } = (e as CustomEvent<{ note: NoteMetadata }>).detail;
      insertNoteLocal(note);
    };
    window.addEventListener('note-created', handler);
    return () => window.removeEventListener('note-created', handler);
  }, [insertNoteLocal]);

  /* ── 删除笔记：本地摘行，零全扫 ── */
  const removeNoteLocal = useCallback((notePath: string) => {
    const key = normPath(notePath);
    setAllNotes(prev => {
      if (!prev.some(n => normPath(n.path) === key)) return prev;
      const next = prev.filter(n => normPath(n.path) !== key);
      allNotesRef.current = next;
      useNotesStore.getState().setNotesFromCache(next);
      return next;
    });
  }, []);

  /* ── 目录结构事件：本地增量增删换行，绝不触发整库重扫 ── */
  const dirCreateLocal = useCallback((dirPath: string) => {
    const cfg = useSettingsStore.getState().config;
    const roots = [cfg.storage_path, ...(cfg.extra_folders || [])].filter(Boolean);
    if (!roots.some(r => isUnderPath(dirPath, r) && normPath(dirPath) !== normPath(r))) return;
    const parentPath = getParentPath(dirPath);
    const node: Project = { name: baseName(dirPath), path: dirPath, children: [], is_root: false };
    useNotesStore.setState(state => {
      if (roots.some(r => normPath(r) === normPath(parentPath))) {
        if (state.projects.some(p => normPath(p.path) === normPath(node.path))) return state;
        return { projects: sortProjects([...state.projects, node]) };
      }
      const insert = (list: Project[]): Project[] => {
        let changed = false;
        const next = list.map(p => {
          if (normPath(p.path) === normPath(parentPath)) {
            changed = true;
            if (p.children.some(c => normPath(c.path) === normPath(node.path))) return p;
            return { ...p, children: sortProjects([...p.children, node]) };
          }
          const children = insert(p.children);
          if (children !== p.children) {
            changed = true;
            return { ...p, children };
          }
          return p;
        });
        return changed ? next : list;
      };
      const projects = insert(state.projects);
      return projects === state.projects ? state : { projects };
    });
  }, []);

  const dirRemoveLocal = useCallback((dirPath: string) => {
    // 非笔记文件（图片/附件）也会走到这里：与已知目录/笔记都不沾边则直接忽略
    const known = projectTreeHas(useNotesStore.getState().projects, dirPath)
      || allNotesRef.current.some(n => isUnderPath(n.path, dirPath));
    if (!known) return;
    const strip = (list: Project[]): Project[] => list
      .filter(p => !isUnderPath(p.path, dirPath))
      .map(p => ({ ...p, children: strip(p.children) }));
    useNotesStore.setState(s => ({
      projects: strip(s.projects),
      expandedFolders: s.expandedFolders.filter(p => !isUnderPath(p, dirPath)),
    }));
    setAllNotes(prev => {
      if (!prev.some(n => isUnderPath(n.path, dirPath))) return prev;
      const next = prev.filter(n => !isUnderPath(n.path, dirPath));
      allNotesRef.current = next;
      useNotesStore.getState().setNotesFromCache(next);
      return next;
    });
  }, []);

  const dirRenameLocal = useCallback((fromPath: string, toPath: string) => {
    const known = projectTreeHas(useNotesStore.getState().projects, fromPath)
      || allNotesRef.current.some(n => isUnderPath(n.path, fromPath));
    if (!known) {
      // 外部先建后改时可能只收到 To：按新建补一个节点
      dirCreateLocal(toPath);
      return;
    }
    const renameTree = (list: Project[]): Project[] => {
      let changed = false;
      const next = list.map(p => {
        const children = renameTree(p.children);
        if (isUnderPath(p.path, fromPath)) {
          changed = true;
          return {
            ...p,
            path: remapPath(p.path, fromPath, toPath),
            name: normPath(p.path) === normPath(fromPath) ? baseName(toPath) : p.name,
            children,
          };
        }
        if (children !== p.children) {
          changed = true;
          return { ...p, children };
        }
        return p;
      });
      return changed ? next : list;
    };
    useNotesStore.setState(s => ({ projects: renameTree(s.projects) }));
    useNotesStore.getState().applyFolderPathChange(fromPath, toPath);
    setAllNotes(prev => {
      if (!prev.some(n => isUnderPath(n.path, fromPath))) return prev;
      // 保持原有行序：改名不应让任何行在父目录里跳动
      const next = prev.map(n => {
        if (!isUnderPath(n.path, fromPath)) return n;
        const path = remapPath(n.path, fromPath, toPath);
        return { ...n, id: path, path };
      });
      allNotesRef.current = next;
      useNotesStore.getState().setNotesFromCache(next);
      return next;
    });
  }, [dirCreateLocal]);

  // 快捷方式新建目录（App 快捷键）等入口经 folder-created 广播本地插行
  useEffect(() => {
    const handler = (e: Event) => {
      const { path } = (e as CustomEvent<{ path: string }>).detail;
      dirCreateLocal(path);
    };
    window.addEventListener('folder-created', handler);
    return () => window.removeEventListener('folder-created', handler);
  }, [dirCreateLocal]);

  /* ── Watch filesystem changes ── */
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingFiles = new Map<string, string>();
    let metadataRunning = false;
    let active = true;
    let structureGeneration = 0;
    let directoryRunning: { path: string } | null = null;
    const pendingDirectories = new Map<string, { path: string }>();

    const applyDirectory = (path: string, project: Project | null, notes: NoteMetadata[]) => {
      const cfg = useSettingsStore.getState().config;
      const roots = [cfg.storage_path, ...cfg.extra_folders].filter(Boolean);
      if (!roots.some(root => isUnderPath(path, root))) return;
      if (!project) { dirRemoveLocal(path); return; }
      if (normPath(path) === normPath(cfg.storage_path)) {
        const extras = new Set(cfg.extra_folders.map(normPath));
        useNotesStore.setState(state => ({ projects: sortProjects([
          ...state.projects.filter(item => !isUnderPath(item.path, path) || extras.has(normPath(item.path))),
          ...project.children.filter(item => !extras.has(normPath(item.path))),
        ]) }));
      } else {
        dirCreateLocal(path);
        const replace = (items: Project[]): Project[] => items.map(item => normPath(item.path) === normPath(path) ? project : { ...item, children: replace(item.children) });
        useNotesStore.setState(state => ({ projects: replace(state.projects) }));
      }
      const next = [...allNotesRef.current.filter(note => !isUnderPath(note.path, path)), ...notes];
      allNotesRef.current = next;
      setAllNotes(next);
      useNotesStore.getState().setNotesFromCache(next);
      void useNotesStore.getState().reloadOpenTabs(notes.map(note => note.path));
    };

    const drainDirectories = async () => {
      if (!active || directoryRunning) return;
      while (active && pendingDirectories.size) {
        const [key, request] = pendingDirectories.entries().next().value!;
        pendingDirectories.delete(key);
        directoryRunning = request;
        try {
          const snapshot = await readDirectorySnapshot(request.path);
          if (active && ![...pendingDirectories.values()].some(next => isUnderPath(next.path, request.path) || isUnderPath(request.path, next.path))) {
            applyDirectory(request.path, snapshot.project, snapshot.notes);
          }
        } catch (error) {
          if (active) window.dispatchEvent(new CustomEvent('show-toast', { detail: { message: String(error), type: 'warning' } }));
        } finally { directoryRunning = null; }
      }
    };

    const queueDirectory = (path: string) => {
      ++structureGeneration;
      const cfg = useSettingsStore.getState().config;
      const roots = [cfg.storage_path, ...cfg.extra_folders].filter(root => root && isUnderPath(path, root));
      if (!roots.length) return;
      let refreshPath = path;
      const root = roots.sort((a, b) => b.length - a.length)[0];
      while (normPath(refreshPath) !== normPath(root)) {
        const parent = getParentPath(refreshPath);
        if (normPath(parent) === normPath(root) || projectTreeHas(useNotesStore.getState().projects, parent)) break;
        refreshPath = parent;
      }
      if (directoryRunning && (isUnderPath(refreshPath, directoryRunning.path) || isUnderPath(directoryRunning.path, refreshPath))) {
        refreshPath = isUnderPath(refreshPath, directoryRunning.path) ? directoryRunning.path : refreshPath;
      }
      for (const pending of pendingDirectories.values()) if (isUnderPath(refreshPath, pending.path)) refreshPath = pending.path;
      for (const [key, pending] of pendingDirectories) if (isUnderPath(pending.path, refreshPath)) pendingDirectories.delete(key);
      pendingDirectories.set(normPath(refreshPath), { path: refreshPath });
      if (pendingDirectories.size > 256) {
        pendingDirectories.clear();
        for (const root of [cfg.storage_path, ...cfg.extra_folders].filter(Boolean)) pendingDirectories.set(normPath(root), { path: root });
      }
      void drainDirectories();
    };

    // Start watching storage path + extra folders
    const watchPaths = [config.storage_path, ...(config.extra_folders || [])].filter(Boolean);
    if (watchPaths.length > 0) {
      startWatching(watchPaths).catch(error => {
        if (active) window.dispatchEvent(new CustomEvent('show-toast', { detail: { message: String(error), type: 'warning' } }));
      });
    }

    // 文件级增量更新：只对变更文件取元数据，不重扫目录树。
    // 修改事件原位替换（不重排父目录），只有真正新增的行才参与排序
    const applyIncremental = async (files: Map<string, string>) => {
      try {
        const cfg = useSettingsStore.getState().config;
        const generation = structureGeneration;
        const requestedPaths = [...files.keys()];
        const upsertedRaw = await getNotesMetadata(requestedPaths, cfg.storage_path, cfg.extra_folders || []);
        if (!active) return;
        if (generation !== structureGeneration) {
          for (const path of requestedPaths) if (!pendingFiles.has(normPath(path))) pendingFiles.set(normPath(path), path);
          return;
        }
        const paths = requestedPaths.filter(path => !pendingFiles.has(normPath(path)));
        const accepted = new Set(paths.map(normPath));
        const probePaths = paths;
        // 外部变更可能来自已移除文件夹：只接受当前根之下的笔记，避免移除行复活
        const roots = [cfg.storage_path, ...(cfg.extra_folders || [])].filter(Boolean).map(normPath);
        const upserted = upsertedRaw.filter(n => accepted.has(normPath(n.path)) && roots.some(r => isUnderPath(n.path, r)));
        const upsertedByKey = new Map(upserted.map(n => [normPath(n.path), n]));
        const removedSet = new Set<string>();
        // create/modify 事件但文件已读不到 → 视为删除
        for (const p of probePaths) {
          if (!upsertedByKey.has(normPath(p))) removedSet.add(normPath(p));
        }

        const prev = allNotesRef.current;
        const prevKeys = new Set(prev.map(n => normPath(n.path)));
        let changed = false;
        const next: NoteMetadata[] = [];
        for (const n of prev) {
          const key = normPath(n.path);
          if (removedSet.has(key)) { changed = true; continue; }
          const fresh = upsertedByKey.get(key);
          if (!fresh) { next.push(n); continue; }
          if (sameNoteMeta(n, fresh)) next.push(n);
          else { next.push(fresh); changed = true; }
        }
        const added = upserted.filter(n => !prevKeys.has(normPath(n.path)));
        if (added.length > 0) {
          changed = true;
          next.push(...added);
          next.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
        }
        if (changed) {
          allNotesRef.current = next;
          setAllNotes(next);
          useNotesStore.getState().setNotesFromCache(next);
        }
        await useNotesStore.getState().reloadOpenTabs(paths);
      } catch (e) {
        if (active) window.dispatchEvent(new CustomEvent('show-toast', { detail: { message: String(e), type: 'warning' } }));
      }
    };

    const drainMetadata = async () => {
      if (!active || metadataRunning) return;
      metadataRunning = true;
      try {
        while (active && pendingFiles.size && debounceTimer === null) {
          const files = new Map([...pendingFiles.values()].map(path => [path, 'probe']));
          pendingFiles = new Map();
          await applyIncremental(files);
        }
      } finally { metadataRunning = false; }
    };

    const unlisten = listen<{ type: string; paths: string[] }>('fs-change', (event) => {
      if (event.payload.type === 'rescan') {
        for (const path of event.payload.paths) queueDirectory(path);
        return;
      }
      const external = event.payload.paths;
      if (external.length === 0) return;

      let hasNote = false;
      for (const p of external) {
        // 目录 Modify 噪音与其他非笔记文件不参与树刷新
        if (isNoteFilePath(p)) {
          pendingFiles.set(normPath(p), p);
          if (pendingFiles.size > 1024) {
            pendingFiles.clear();
            const cfg = useSettingsStore.getState().config;
            for (const root of [cfg.storage_path, ...cfg.extra_folders].filter(Boolean)) queueDirectory(root);
            return;
          }
          hasNote = true;
        }
      }
      if (!hasNote) return;

      if (debounceTimer !== null) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void drainMetadata();
      }, 400);
    });

    // 目录结构事件：新建/重命名/删除目录都本地增量应用，零全库重扫
    const unlistenStructure = listen<{ kind: string; path?: string | null; from?: string | null; to?: string | null }>(
      'fs-structure',
      (event) => {
        const { kind, path: p, from, to } = event.payload;
        if (kind === 'dir-create' && p) { dirCreateLocal(p); queueDirectory(p); }
        else if (kind === 'dir-rename' && from && to) { dirRenameLocal(from, to); queueDirectory(from); queueDirectory(to); }
        else if (kind === 'path-remove' && p) queueDirectory(p);
      },
    );

    return () => {
      active = false;
      pendingDirectories.clear();
      pendingFiles.clear();
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      unlisten.then(fn => fn());
      unlistenStructure.then(fn => fn());
    };
  }, [config.storage_path, config.extra_folders, reloadAllNotes, dirCreateLocal, dirRenameLocal, dirRemoveLocal]);

  const filteredNotes = useMemo(() => {
    const q = searchInput.trim().toLowerCase();
    if (!q) return allNotes;
    const contentResults = searchScope === 'content' ? searchResults : [];
    const bodyMatches = new Set(contentResults.map(note => normPath(note.path)));
    const candidates = new Map([...allNotes, ...contentResults].map(note => [normPath(note.path), note]));
    return [...candidates.values()].filter(note =>
      noteMatchesSearchType(note, searchType) &&
      (bodyMatches.has(normPath(note.path)) ||
        note.title.toLowerCase().includes(q) || getParentPath(note.path).toLowerCase().includes(q)));
  }, [allNotes, searchInput, searchResults, searchScope, searchType]);

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
    const folderPath = contextMenu.project.path;
    try {
      const created = await useNotesStore.getState().createDocument(folderPath, `Untitled-${Date.now()}`);
      const st = useNotesStore.getState();
      if (!created || created.requestId === null || !st.isCurrentOpen(created.requestId)) return;
      if (!st.expandedFolders.includes(folderPath)) st.toggleExpandedFolder(folderPath);
      setRenamingNoteId(created.note.id);
      setRenameNoteValue(stripKnownExt(created.note.title));
    } catch (e) { console.error('Failed to create note:', e); }
    setContextMenu(null);
  }, [contextMenu, selectNote]);

  /* ── Note context menu handlers ── */
  const handleDeleteNote = useCallback(async () => {
    if (!contextMenu || contextMenu.type !== 'note') return;
    const path = contextMenu.note.path;
    try {
      if (await useNotesStore.getState().deleteDocument(path)) removeNoteLocal(path);
    } catch (e) { console.error('Failed to delete note:', e); }
    setContextMenu(null);
  }, [contextMenu, removeNoteLocal]);

  const handleStartRenameNote = useCallback(() => {
    if (!contextMenu || contextMenu.type !== 'note') return;
    setRenamingNoteId(contextMenu.note.id);
    setRenameNoteValue(stripKnownExt(contextMenu.note.title));
    setContextMenu(null);
  }, [contextMenu]);

  const handleRenameNoteSubmit = useCallback(async (note: NoteMetadata) => {
    const newTitle = renameNoteValue.trim();
    if (!newTitle || newTitle === note.title || newTitle === stripKnownExt(note.title)) { setRenamingNoteId(null); return; }
    try {
      await useNotesStore.getState().withDocumentPathChange(note.path, false, async () => {
        const newPath = await renameNote(note.path, newTitle);
        const newFileName = newPath.split(/[\\/]/).pop() ?? newTitle;
        useNotesStore.getState().applyNotePathChange(note.path, newPath, newFileName);
        if (useNotesStore.getState().activeNote?.path === newPath) {
          window.dispatchEvent(new CustomEvent('editor-focus'));
        }
      }, [{ path: documentRenameTarget(note.path, newTitle), directory: false }]);
    } catch (e) { console.error('Failed to rename note:', e); }
    setRenamingNoteId(null);
  }, [renameNoteValue]);

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
      await useNotesStore.getState().withDocumentPathChange(`${contextMenu.project.path}/${name}`, true, async () => {
        const newPath = await createFolder(contextMenu.project.path, name);
        dirCreateLocal(newPath);
      });
    } catch (e) { console.error('Failed to create subfolder:', e); }
    setContextMenu(null);
  }, [contextMenu, dirCreateLocal, t]);

  const handleStartRenameFolder = useCallback(() => {
    if (!contextMenu || contextMenu.type !== 'folder') return;
    setRenamingFolderPath(contextMenu.project.path);
    setRenameFolderValue(contextMenu.project.name);
    setContextMenu(null);
  }, [contextMenu]);

  const handleRenameFolderSubmit = useCallback(async (project: Project) => {
    if (!renameFolderValue.trim() || renameFolderValue.trim() === project.name) { setRenamingFolderPath(null); return; }
    try {
      await useNotesStore.getState().withDocumentPathChange(project.path, true, async () => {
        const newPath = await renameFolder(project.path, renameFolderValue.trim());
        dirRenameLocal(project.path, newPath);
      }, [{ path: documentRenameTarget(project.path, renameFolderValue.trim(), true), directory: true }]);
    } catch (e) { console.error('Failed to rename folder:', e); }
    setRenamingFolderPath(null);
  }, [renameFolderValue, dirRenameLocal]);

  const handleDeleteFolder = useCallback(async () => {
    if (!contextMenu || contextMenu.type !== 'folder') return;
    const path = contextMenu.project.path;
    try {
      if (await useNotesStore.getState().deleteDocument(path, true)) dirRemoveLocal(path);
    } catch (e) { console.error('Failed to delete folder:', e); }
    setContextMenu(null);
  }, [contextMenu, dirRemoveLocal]);

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
      setRenameNoteValue(stripKnownExt(an.title));
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
            onFocus={(e) => e.target.select()}
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
          e.currentTarget.style.backgroundColor = isActive ? 'var(--accent-light)' : 'transparent';
          if (notePath) {
            try {
              await useNotesStore.getState().withDocumentPathChange(notePath, false, async () => {
                const newPath = await moveNote(notePath, project.path);
                const newFileName = newPath.split(/[\\/]/).pop() ?? '';
                useNotesStore.getState().applyNotePathChange(notePath, newPath, newFileName);
              }, [{ path: `${project.path}/${baseName(notePath)}`, directory: false }]);
            } catch (err) { console.error('Failed to move note:', err); }
          }
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
            disabled={savingSettings}
            onClick={async (e) => {
              e.stopPropagation();
              const settings = useSettingsStore.getState();
              const desired = settings.draftConfig ?? settings.config;
              const newFolders = desired.extra_folders.filter(folder => pathIdentity(folder) !== pathIdentity(project.path));
              if (await settings.updateConfig({ extra_folders: newFolders })) await removeFolderLocal(project.path);
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
        <div className="relative flex items-center gap-1">
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
          <button
            type="button"
            title={t('search.filter')}
            aria-label={t('search.filter')}
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen(open => !open)}
            className="flex items-center justify-center rounded-md flex-shrink-0"
            style={{
              width: 26, height: 26, border: 'none', cursor: 'pointer',
              color: filtersActive ? 'var(--accent-icon)' : 'var(--text-tertiary)',
              backgroundColor: filtersActive ? 'var(--accent-light)' : 'transparent',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>
          </button>
          {filtersOpen && (
            <>
              <div className="fixed inset-0" style={{ zIndex: 40 }} onClick={() => setFiltersOpen(false)} />
              <div
                role="dialog"
                aria-label={t('search.filter')}
                className="absolute right-0 rounded-md shadow-lg p-2 text-xs"
                style={{ top: '100%', marginTop: 4, zIndex: 50, width: 190, backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border)' }}
              >
                <div className="px-1 pb-1 text-[10px] font-medium" style={{ color: 'var(--text-tertiary)' }}>{t('search.scope')}</div>
                {([['content', t('search.scopeContent')], ['filename', t('search.scopeFilename')]] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={searchScope === value}
                    onClick={() => setSearchFilters({ scope: value })}
                    className="w-full text-left px-1.5 rounded flex items-center gap-1.5"
                    style={{ height: 24, border: 'none', cursor: 'pointer', color: 'var(--text-primary)', backgroundColor: searchScope === value ? 'var(--accent-light)' : 'transparent' }}
                  >
                    <span className="w-3 text-center flex-shrink-0" style={{ color: 'var(--accent-icon)' }}>{searchScope === value ? '✓' : ''}</span>
                    {label}
                  </button>
                ))}
                <div className="px-1 pb-1 pt-2 text-[10px] font-medium" style={{ color: 'var(--text-tertiary)' }}>{t('search.type')}</div>
                {([['all', t('search.allTypes')], ['md', t('search.markdown')], ['pdf', 'PDF'], ['html', 'HTML']] as [SearchFileType, string][]).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={searchType === value}
                    onClick={() => setSearchFilters({ type: value })}
                    className="w-full text-left px-1.5 rounded flex items-center gap-1.5"
                    style={{ height: 24, border: 'none', cursor: 'pointer', color: 'var(--text-primary)', backgroundColor: searchType === value ? 'var(--accent-light)' : 'transparent' }}
                  >
                    <span className="w-3 text-center flex-shrink-0" style={{ color: 'var(--accent-icon)' }}>{searchType === value ? '✓' : ''}</span>
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
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

        {searchStatus === 'loading' && <div role="status" className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>{t('notesList.searching')}</div>}
        {searchError && <div role="alert" className="px-3 py-2 text-xs space-y-2" style={{ color: 'var(--text-secondary)' }}>
          <p>{t('notesList.searchFailed')}</p>
          <p className="break-all">{searchError}</p>
          <button className="rounded border px-2 py-1" onClick={() => void setSearchQuery(searchQuery, config.storage_path)}>{t('notesList.retrySearch')}</button>
        </div>}
        {/* Loading / Empty */}
        {isLoading && allNotes.length === 0 ? (
          <div className="flex items-center justify-center h-12 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>Loading...</div>
        ) : filteredNotes.length === 0 && searchInput.trim() && searchStatus === 'idle' ? (
          <div className="flex items-center justify-center h-12 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            {t('notesList.noResults')}
          </div>
        ) : null}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-[9999] rounded-lg px-1 py-1 min-w-[160px]"
          style={{ left: menuPos.x, top: menuPos.y, backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)', boxShadow: '0 4px 16px rgba(0,0,0,0.2)' }}
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
              {!isPdfPath(contextMenu.note.path) && (
                <>
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
                </>
              )}
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
          requestId={encryptionDialog.requestId}
          onUnlocked={onNoteUnlocked}
          onEncrypted={() => handleRefreshAll()}
          onRemoved={() => handleRefreshAll()}
        />
      )}
    </div>
  );
}
