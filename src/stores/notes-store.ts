import { create } from 'zustand';
import type { NoteMetadata, NoteContent, Project, SortMode, SortDirection } from '../types';
import {
  getAllNotes,
  getNotesInFolder,
  getProjects,
  getScanId,
  isCurrentScan,
  readNote,
  writeNote,
  createNote,
  deleteNote,
  deleteFolder,
  searchNotes,
  startSearchSession,
  invalidateSearch,
  getSortOrder,
  saveSortOrder as saveSortOrderBridge,
  saveEncryptedNote,
  decryptNote,
  encryptNote,
  removeEncryption,
  saveDocumentCopy,
} from '../services/tauri-bridge';
import { useSettingsStore } from './settings-store';
import { perfReport } from '../services/perf';
import { useEditorStore } from './editor-store';
import type { ViewMode } from './editor-store';
import { isPdfPath } from '../utils/fileType';
import type { SearchFileType } from '../utils/fileType';
import { pathIdentity, isPathWithin } from '../utils/path-identity';

const projectKey = (p: string) => p.replace(/\\/g, '/').toLowerCase();

function collectProjectPaths(list: Project[], out: Set<string>) {
  for (const p of list) {
    out.add(projectKey(p.path));
    collectProjectPaths(p.children, out);
  }
}

function collectProjectNodes(list: Project[], out: Array<{ node: Project; depth: number }>, depth = 0) {
  for (const p of list) {
    out.push({ node: p, depth });
    collectProjectNodes(p.children, out, depth + 1);
  }
}

const parentKeyOf = (p: string) => {
  const s = p.replace(/\\/g, '/');
  const idx = s.lastIndexOf('/');
  return idx > 0 ? s.slice(0, idx).toLowerCase() : '';
};

/// 把晚到的目录节点插回扫描结果：顶层追加，嵌套按父路径递归插入
function insertProjectNode(list: Project[], roots: string[], node: Project): Project[] {
  const parentKey = parentKeyOf(node.path);
  if (roots.some((r) => projectKey(r) === parentKey)) {
    if (list.some((p) => projectKey(p.path) === projectKey(node.path))) return list;
    return [...list, node];
  }
  let changed = false;
  const next = list.map((p) => {
    if (projectKey(p.path) === parentKey) {
      changed = true;
      if (p.children.some((c) => projectKey(c.path) === projectKey(node.path))) return p;
      return {
        ...p,
        children: [...p.children, node].sort((a, b) =>
          a.name.toLowerCase().localeCompare(b.name.toLowerCase())
        ),
      };
    }
    const children = insertProjectNode(p.children, roots, node);
    if (children !== p.children) {
      changed = true;
      return { ...p, children };
    }
    return p;
  });
  return changed ? next : list;
}

export type DocumentSaveStatus = 'idle' | 'saving' | 'error';
export interface DocumentPathScope { path: string; directory: boolean }

export function documentRenameTarget(path: string, title: string, directory = false): string {
  const slash = path.replace(/\\/g, '/');
  const ext = directory ? '' : (slash.slice(slash.lastIndexOf('/') + 1).match(/\.[^.]+$/)?.[0] ?? '.');
  return slash.slice(0, slash.lastIndexOf('/') + 1) + title + (ext && !title.endsWith(ext) ? ext : '');
}

export interface DocumentSessionSnapshot {
  /** Opaque session lifetime token: stable across edits/saves/moves, new on reopen. */
  readonly identity: number;
  readonly path: string;
  readonly content: string;
  readonly revision: number;
  readonly savedRevision: number;
  readonly isDirty: boolean;
  readonly saveStatus: DocumentSaveStatus;
  readonly saveError: string | null;
  readonly isTemporaryFile: boolean;
}

export interface DocumentWorkSnapshot { key: string; pending: boolean; error: string | null; draft?: string }
interface DocumentWork {
  key: string;
  run: () => Promise<void>;
  promise: Promise<boolean> | null;
  error: string | null;
  draft?: string;
}

interface DocumentSession {
  readonly identity: number;
  note: NoteMetadata;
  content: string;
  revision: number;
  savedRevision: number;
  diskVersion: string;
  saveStatus: DocumentSaveStatus;
  saveError: string | null;
  savePromise: Promise<boolean> | null;
  drainPromise: Promise<boolean> | null;
  work: Map<string, DocumentWork>;
  timer: ReturnType<typeof setTimeout> | null;
  reloadGeneration: number;
  pathGeneration: number;
  password: string | null;
  temporary: boolean;
  viewMode: ViewMode;
}

export interface OpenTab {
  readonly path: string;
  readonly note: NoteMetadata;
  // Compatibility selector, not a second body cache. Read from the session.
  readonly content: string;
  readonly isDirty: boolean;
  readonly viewMode: ViewMode;
  readonly saveStatus: DocumentSaveStatus;
  readonly saveError: string | null;
}

const documentKey = (path: string) => {
  let slash = path.replace(/\\/g, '/');
  if (slash.startsWith('//?/UNC/')) slash = '//' + slash.slice(8);
  else if (slash.startsWith('//?/')) slash = slash.slice(4);
  // Windows drive/UNC paths are case-insensitive; do not lowercase POSIX paths.
  return /^[a-z]:\//i.test(slash) || slash.startsWith('//') ? slash.toLowerCase() : slash;
};
const encryptedPath = (path: string) => /\.encrypted$/i.test(path);
const dirty = (session: DocumentSession) => session.revision !== session.savedRevision;
const warnDocument = (message: string) => {
  window.dispatchEvent(new CustomEvent('show-toast', { detail: { message, type: 'warning' } }));
};

interface NotesState {
  projects: Project[];
  notes: NoteMetadata[];
  activeNote: NoteMetadata | null;
  activeContent: string;
  activeFolder: string | null;
  searchQuery: string;
  searchResults: NoteMetadata[];
  searchStatus: 'idle' | 'loading' | 'error';
  searchError: string | null;
  searchScope: 'content' | 'filename';
  searchType: SearchFileType;
  setSearchFilters: (filters: { scope?: 'content' | 'filename'; type?: SearchFileType }) => void;
  sortMode: SortMode;
  sortDirection: SortDirection;
  isLoading: boolean;
  isDirty: boolean;
  activeDocumentReadOnly: boolean;
  recoveryPaths: string[];
  setRecoveryPaths: (paths: string[]) => void;
  isDocumentWritable: (path: string) => boolean;
  closing: 'draining' | 'destroying' | null;
  setClosing: (phase: NotesState['closing']) => void;

  customSortOrder: string[]; // note paths in custom order

  // Encryption state
  encryptionDialog: { visible: boolean; mode: 'unlock' | 'encrypt' | 'remove'; notePath: string; requestId?: number } | null;
  activeEncryptionPassword: string | null; // password for currently open encrypted note

  // Temporary file state
  isTemporaryFile: boolean;
  openTemporaryFile: (path: string, initialViewMode?: ViewMode) => Promise<number | null>;
  /** Accepted open identity; a later intent (including the same path) invalidates it. */
  isCurrentOpen: (requestId: number) => boolean;

  loadProjects: (rootPath: string) => Promise<void>;
  loadNotes: (rootPath: string) => Promise<void>;
  loadNotesInFolder: (folderPath: string, rootPath: string) => Promise<void>;
  selectNote: (note: NoteMetadata) => Promise<number | null>;
  closeTab: (path: string) => Promise<void>;
  switchTab: (path: string) => Promise<void>;
  closeAllTabs: () => Promise<void>;
  closeOtherTabs: (path: string) => Promise<void>;
  closeLeftTabs: (path: string) => Promise<void>;
  closeRightTabs: (path: string) => Promise<void>;
  reloadOpenTabs: (changedPaths: string[]) => Promise<void>;
  updateContent: (content: string, rootPath: string) => void;
  saveCurrentNote: () => Promise<boolean>;
  saveDocument: (path: string, identity: number) => Promise<boolean>;
  saveDocumentCopy: (path: string, identity: number, targetPath: string) => Promise<boolean>;
  discardDocument: (path: string, identity: number, expectedRevision?: number) => boolean;
  runDocumentWork: (path: string, identity: number, key: string, run: () => Promise<void>, draft?: string) => Promise<boolean>;
  waitDocumentWork: (path: string, prefix: string) => Promise<boolean>;
  retryDocumentWork: (path: string, prefix: string) => Promise<boolean>;
  getDocumentWork: (path: string, prefix: string) => DocumentWorkSnapshot | null;
  /** Drain all dirty/in-flight sessions, rechecking edits made while waiting. False retains drafts. */
  flushPendingSaves: () => Promise<boolean>;
  /** Reserve source/destinations atomically; drain before sealing edits. Accepted work drains through close; new work is rejected during close. */
  withDocumentPathChange: (path: string, directory: boolean, change: () => Promise<void>, destinations?: DocumentPathScope[], options?: { preserveOpenRequest?: number; preserveDialog?: boolean }) => Promise<boolean>;
  deleteDocument: (path: string, directory?: boolean) => Promise<boolean>;
  changeDocumentEncryption: (path: string, password: string, enabled: boolean) => Promise<boolean>;
  createDocument: (folder: string, title: string, content?: string, activate?: boolean) => Promise<{ note: NoteMetadata; requestId: number | null } | null>;
  /** Snapshot only; null means no loaded session. Passwords/queues are never exposed. */
  getDocumentSession: (path: string) => DocumentSessionSnapshot | null;
  /** Opaque monotonic token. Changes on edits, reloads, rename and reopen (not on save). */
  getDocumentRevision: (path: string) => number | null;
  /** CAS edit, including inactive documents. False for stale/missing/PDF; no side effects on rejection. */
  updateDocumentContent: (path: string, content: string, expectedRevision: number) => boolean;
  setSearchQuery: (query: string, rootPath: string) => Promise<void>;
  setActiveFolder: (folder: string | null, rootPath: string, requestId?: number) => Promise<void>;
  setSortMode: (mode: SortMode) => void;
  toggleSortDirection: () => void;
  refreshNotes: (rootPath: string) => Promise<void>;
  applyNotePathChange: (oldPath: string, newPath: string, newTitle: string) => void;
  applyFolderPathChange: (fromPath: string, toPath: string) => void;
  registerCreatedNote: (note: NoteMetadata) => void;
  setNotesFromCache: (loaded: NoteMetadata[]) => void;
  mergeProjectChunk: (project: Project) => void;
  duplicateNote: (rootPath: string) => Promise<void>;
  loadCustomSortOrder: (rootPath: string, folder: string | null) => Promise<void>;
  applyCustomSortOrder: (rootPath: string, folder: string | null, noteIds: string[]) => Promise<void>;
  setEncryptionDialog: (dialog: NotesState['encryptionDialog']) => void;
  onNoteUnlocked: (notePath: string, snapshot: NoteContent, password: string, requestId: number) => boolean;
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
  // The Map owns bodies/revisions/queues. Store fields and tabs are UI projections.
  const sessions = new Map<string, DocumentSession>();
  const openingReads = new Map<string, Promise<NoteContent>>();
  const pathGuards = new Set<{ path: string; directory: boolean; sealed: boolean }>();
  const pathOperations = new Set<Promise<boolean>>();
  const inScope = (path: string, scope: { path: string; directory: boolean }) => {
    const key = documentKey(path), root = documentKey(scope.path).replace(/\/$/, '');
    return key === root || (scope.directory && key.startsWith(root + '/'));
  };
  let revisionClock = 0;
  let navigationGeneration = 0;
  let folderGeneration = 0;
  let projectsGeneration = 0, notesGeneration = 0;
  let searchGeneration = 0;
  let searchSession: Promise<string> | null = null;
  const getSearchSession = () => {
    if (searchSession === null) {
      const pending = startSearchSession();
      searchSession = pending;
      void pending.catch(() => { if (searchSession === pending) searchSession = null; });
    }
    return searchSession;
  };
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let searching = false;
  let queuedSearch: { generation: number; root: string; query: string; extras: string[]; resolve: () => void } | null = null;
  const runSearch = async () => {
    if (searching || searchTimer !== null || !queuedSearch) return;
    const request = queuedSearch;
    queuedSearch = null;
    searching = true;
    try {
      const sessionId = await getSearchSession();
      if (request.generation !== searchGeneration) return;
      const results = await searchNotes(request.root, request.query, request.extras, sessionId, request.generation);
      if (request.generation === searchGeneration) set({ searchResults: results, searchStatus: 'idle', searchError: null });
    } catch (error) {
      if (request.generation === searchGeneration) set({ searchStatus: 'error', searchError: String(error) });
    } finally {
      searching = false;
      request.resolve();
      void runSearch();
    }
  };
  let pendingOpen: { note: NoteMetadata; temporary: boolean; requestId: number; viewMode?: ViewMode } | null = null;
  const findSession = (path: string | null) => path ? sessions.get(documentKey(path)) : undefined;
  const isLive = (session: DocumentSession) => findSession(session.note.path) === session;
  const isRecovering = (path: string) => {
    const key = documentKey(path);
    return get().recoveryPaths.some(root => key === root || key.startsWith(root + '/'));
  };
  const isWritable = (session?: DocumentSession) => !!session && isLive(session) &&
    get().closing !== 'destroying' && !isPdfPath(session.note.path) && !isRecovering(session.note.path) &&
    ![...pathGuards].some(g => g.sealed && inScope(session.note.path, g));
  const publishReadOnly = () => set({ activeDocumentReadOnly: !isWritable(findSession(get().activeTabPath)) });
  const waitForPathOperations = async () => {
    while (pathOperations.size) await Promise.allSettled([...pathOperations]);
  };
  const hasPending = (session: DocumentSession) => dirty(session) || !!session.savePromise || session.work.size > 0;
  const workError = (session: DocumentSession) => [...session.work.values()].find(work => work.error)?.error ?? null;
  const statusOf = (session: DocumentSession): DocumentSaveStatus => session.saveStatus === 'error' || workError(session)
    ? 'error' : session.saveStatus === 'saving' || [...session.work.values()].some(work => work.promise) ? 'saving' : 'idle';
  const errorOf = (session: DocumentSession) => session.saveError ?? workError(session);
  const asTab = (session: DocumentSession): OpenTab => ({
    path: session.note.path, note: session.note,
    get content() { return session.content; },
    isDirty: dirty(session) || session.work.size > 0, viewMode: session.viewMode,
    saveStatus: statusOf(session), saveError: errorOf(session),
  });
  const activeFields = (session?: DocumentSession): Partial<NotesState> => ({
    activeNote: session?.note ?? null,
    activeTabPath: session?.note.path ?? null,
    activeContent: session?.content ?? '',
    isDirty: session ? dirty(session) || session.work.size > 0 : false,
    activeEncryptionPassword: session?.password ?? null,
    isTemporaryFile: session?.temporary ?? false,
    activeDocumentReadOnly: !isWritable(session),
  });
  const publish = (session: DocumentSession) => {
    if (!isLive(session)) return;
    const state = get();
    const tab = state.openTabs.find(t => documentKey(t.path) === documentKey(session.note.path));
    const changes: Partial<NotesState> = {};
    // No array allocation for subsequent keystrokes while already dirty.
    if (tab && (tab.isDirty !== (dirty(session) || session.work.size > 0) || tab.note !== session.note ||
        tab.viewMode !== session.viewMode || tab.saveStatus !== statusOf(session) || tab.saveError !== errorOf(session))) {
      changes.openTabs = state.openTabs.map(t => t === tab ? asTab(session) : t);
    }
    if (findSession(state.activeTabPath) === session) Object.assign(changes, activeFields(session));
    if (Object.keys(changes).length) set(changes);
  };
  const activate = (session?: DocumentSession, openTabs = get().openTabs) => {
    set({ ...activeFields(session), openTabs, isLoading: false });
    if (session) useEditorStore.getState().setViewMode(session.viewMode);
  };
  const cancelTimer = (session: DocumentSession) => {
    if (session.timer !== null) clearTimeout(session.timer);
    session.timer = null;
  };
  const saveSession = (session: DocumentSession): Promise<boolean> => {
    cancelTimer(session);
    if (session.savePromise) return session.savePromise;
    if (!isLive(session) || !dirty(session)) return Promise.resolve(true);
    // Install the shared promise before any notification/bridge call can reenter.
    session.savePromise = Promise.resolve().then(async () => {
      try {
        while (isLive(session) && dirty(session)) {
          if (isRecovering(session.note.path)) throw new Error('文档待恢复，暂不可保存 / Document recovery is pending');
          cancelTimer(session);
          const { note, content, revision, pathGeneration, password } = session;
          if (isPdfPath(note.path)) throw new Error('PDF is read-only');
          if ((note.is_encrypted || encryptedPath(note.path)) && !password) {
            throw new Error('Encrypted document requires its password / 加密笔记缺少密码');
          }
          session.saveStatus = 'saving';
          session.saveError = null;
          publish(session);
          const { line_ending } = useSettingsStore.getState().config;
          const body = line_ending === 'crlf' ? content.replace(/(?<!\r)\n/g, '\r\n') : content.replace(/\r\n/g, '\n');
          const started = performance.now();
          const savedVersion = note.is_encrypted || encryptedPath(note.path)
            ? await saveEncryptedNote(note.path, body, password!, session.diskVersion)
            : await writeNote(note.path, body, session.diskVersion);
          const elapsed = performance.now() - started;
          if (elapsed > 100) perfReport('save-note', elapsed, `len=${body.length}`);
          // Only acknowledge this revision at this path, never the newer draft.
          if (session.pathGeneration === pathGeneration) { session.savedRevision = revision; session.diskVersion = savedVersion; }
          publish(session);
        }
        session.saveStatus = 'idle';
        session.saveError = null;
        return true;
      } catch (error) {
        session.saveStatus = 'error';
        session.saveError = String(error);
        warnDocument(`保存失败 / Save failed: ${session.note.title} — ${session.saveError}`);
        return false;
      } finally {
        session.savePromise = null;
        publish(session);
      }
    });
    return session.savePromise;
  };
  const startWork = (session: DocumentSession, work: DocumentWork): Promise<boolean> => {
    if (work.promise) return work.promise;
    work.error = null;
    work.promise = Promise.resolve().then(async () => {
      try {
        if (isRecovering(session.note.path)) throw new Error('Document recovery is pending');
        await work.run();
        if (session.work.get(work.key) === work) session.work.delete(work.key);
        if (isLive(session)) window.dispatchEvent(new CustomEvent('document-work-complete', {
          detail: { path: session.note.path, identity: session.identity, key: work.key },
        }));
        return true;
      } catch (error) {
        work.error = String(error);
        warnDocument(`附属内容保存失败 / Document operation failed: ${session.note.title} — ${work.error}`);
        return false;
      } finally {
        work.promise = null;
        publish(session);
      }
    });
    publish(session);
    return work.promise;
  };
  const saveDocument = (session: DocumentSession): Promise<boolean> => {
    if (session.drainPromise) return session.drainPromise;
    session.drainPromise = Promise.resolve().then(async () => {
      try {
        while (isLive(session)) {
          const results = await Promise.all([...session.work.values()].map(work => startWork(session, work)));
          if (results.some(ok => !ok) || !(await saveSession(session))) return false;
          if (!hasPending(session)) return true;
        }
        return true;
      } finally {
        session.drainPromise = null;
      }
    });
    return session.drainPromise;
  };
  const scheduleSave = (session: DocumentSession) => {
    cancelTimer(session);
    // Non-positive/invalid intervals disable debounce, not explicit/leave/exit saves.
    const interval = useSettingsStore.getState().config.auto_save_interval;
    if (!Number.isFinite(interval) || interval <= 0) return;
    session.timer = setTimeout(() => {
      session.timer = null;
      void saveSession(session);
    }, interval);
  };
  const editSession = (session: DocumentSession, content: string) => {
    if (!isWritable(session)) return false;
    if (session.content === content) return true;
    session.content = content;
    session.revision = ++revisionClock;
    scheduleSave(session);
    publish(session);
    return true;
  };
  const handOff = (targetPath: string) => {
    const current = findSession(get().activeTabPath);
    if (!current) return;
    current.viewMode = isPdfPath(current.note.path) ? 'preview' : useEditorStore.getState().viewMode;
    publish(current);
    if (documentKey(current.note.path) !== documentKey(targetPath) && dirty(current)) void saveSession(current);
  };
  const newSession = (note: NoteMetadata, content: string, diskVersion: string, temporary: boolean, viewMode?: ViewMode, password: string | null = null) => {
    const revision = ++revisionClock;
    const session: DocumentSession = {
      identity: revision, note, content, diskVersion, revision, savedRevision: revision, password, temporary,
      viewMode: isPdfPath(note.path) ? 'preview' : (viewMode ?? (content.trim() ? 'preview' : 'split')),
      saveStatus: 'idle', saveError: null, savePromise: null, drainPromise: null, work: new Map(), timer: null,
      reloadGeneration: 0, pathGeneration: 0,
    };
    sessions.set(documentKey(note.path), session);
    return session;
  };
  const invalidateOpen = (dismissDialog = true) => {
    ++navigationGeneration;
    // Reopening a cancelled target must start a new read, not reuse its old body.
    if (pendingOpen) openingReads.delete(documentKey(pendingOpen.note.path));
    pendingOpen = null;
    set({ isLoading: false, encryptionDialog: dismissDialog ? null : get().encryptionDialog });
  };
  const openDocument = async (note: NoteMetadata, temporary = false, viewMode?: ViewMode, intent?: number): Promise<number | null> => {
    if (get().closing || (intent !== undefined && !get().isCurrentOpen(intent)) || [...pathGuards].some(g => inScope(note.path, g))) return null;
    const requestId = intent ?? ++navigationGeneration;
    pendingOpen = { note, temporary, requestId, viewMode };
    set({ encryptionDialog: null });
    handOff(note.path);
    const existing = findSession(note.path);
    if (existing) {
      pendingOpen = null;
      activate(existing);
      return requestId;
    }
    if (note.is_encrypted || encryptedPath(note.path)) {
      set({ isLoading: false, encryptionDialog: { visible: true, mode: 'unlock', notePath: note.path, requestId } });
      return requestId;
    }
    set({ isLoading: true });
    const key = documentKey(note.path);
    let read = openingReads.get(key);
    if (!read) {
      read = isPdfPath(note.path) ? Promise.resolve({ id: note.path, content: '', disk_version: '' }) : readNote(note.path);
      openingReads.set(key, read);
    }
    try {
      const started = performance.now();
      const result = await read;
      if (!get().isCurrentOpen(requestId) || pendingOpen?.requestId !== requestId) return null;
      const elapsed = performance.now() - started;
      if (elapsed > 100) perfReport('read-note', elapsed, `len=${result.content.length}`);
      pendingOpen = null;
      // The outgoing document may have received more edits during this read.
      handOff(note.path);
      const session = newSession(note, result.content, result.disk_version, temporary, viewMode);
      activate(session, [...get().openTabs, asTab(session)]);
      return requestId;
    } catch (error) {
      if (!get().isCurrentOpen(requestId)) return null;
      pendingOpen = null;
      set({ isLoading: false });
      warnDocument(`打开失败 / Open failed: ${note.title} — ${String(error)}`);
      return null;
    } finally {
      if (openingReads.get(key) === read) openingReads.delete(key);
    }
  };
  const removeSession = (session: DocumentSession) => {
    if (!isLive(session)) return;
    const state = get();
    const index = state.openTabs.findIndex(t => documentKey(t.path) === documentKey(session.note.path));
    const wasActive = findSession(state.activeTabPath) === session;
    const tabs = state.openTabs.filter((_, i) => i !== index);
    cancelTimer(session);
    sessions.delete(documentKey(session.note.path));
    session.password = null;
    if (wasActive) activate(findSession(tabs[Math.min(index, tabs.length - 1)]?.path ?? null), tabs);
    else set({ openTabs: tabs });
  };
  const closeDocuments = async (paths: string[]) => {
    for (const path of paths) openingReads.delete(documentKey(path));
    const intentPath = pendingOpen?.note.path ?? get().activeTabPath;
    if (intentPath && paths.some(path => documentKey(path) === documentKey(intentPath))) invalidateOpen();
    // Capture identities, not a tab-array snapshot; newly opened sessions are untouched.
    const targets = paths.map(findSession).filter((s): s is DocumentSession => !!s);
    await waitForPathOperations();
    await Promise.all(targets.map(async session => {
      while (isLive(session)) {
        if (!(await saveDocument(session))) return;
        await waitForPathOperations();
        // Another edit can arrive between promise resolution and this continuation.
        if (pathOperations.size || hasPending(session)) continue;
        removeSession(session);
        return;
      }
    }));
  };
  const migrateSession = (session: DocumentSession, note: NoteMetadata) => {
    const wasDirty = dirty(session);
    sessions.delete(documentKey(session.note.path));
    session.note = note;
    ++session.pathGeneration;
    ++session.reloadGeneration;
    session.revision = ++revisionClock;
    if (!wasDirty) session.savedRevision = session.revision;
    sessions.set(documentKey(note.path), session);
  };

  return {
  projects: [],
  notes: [],
  activeNote: null,
  activeContent: '',
  activeFolder: null,
  searchQuery: '',
  searchResults: [],
  searchStatus: 'idle',
  searchError: null,
  searchScope: 'content',
  searchType: 'all',
  sortMode: 'modified',
  sortDirection: 'desc',
  isLoading: false,
  isDirty: false,
  activeDocumentReadOnly: true,
  recoveryPaths: [],
  setRecoveryPaths: (paths) => {
    set({ recoveryPaths: [...new Set(paths.map(documentKey))] });
    publishReadOnly();
  },
  isDocumentWritable: (path) => isWritable(findSession(path)),
  closing: null,
  setClosing: (phase) => {
    set({ closing: phase });
    publishReadOnly();
    if (phase === 'draining') {
      invalidateOpen();
      openingReads.clear();
      for (const session of sessions.values()) ++session.reloadGeneration;
    }
  },

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
    const generation = ++projectsGeneration;
    const { config, storageRevision } = useSettingsStore.getState();
    const pending = getProjects(rootPath, config.extra_folders);
    const scanId = getScanId(pending);
    const isCurrent = () => {
      const current = useSettingsStore.getState();
      return generation === projectsGeneration && storageRevision === current.storageRevision && isCurrentScan(scanId, 'projects', current.config.storage_path, current.config.extra_folders);
    };
    const roots = [config.storage_path, ...config.extra_folders].filter(Boolean);
    set(state => ({ projects: state.projects.filter(project => roots.some(root => isPathWithin(project.path, root))) }));
    // 扫描很慢（大库 + 额外文件夹可达十几秒）：先记下调用时已存在的目录，
    // 扫描期间本地新增的目录不能被晚到的权威结果抹掉
    const beforePaths = new Set<string>();
    collectProjectPaths(get().projects, beforePaths);
    try {
      const callFolders = config.extra_folders.map(pathIdentity);
      const projects = await pending;
      if (!isCurrent()) return;
      // 迟到保护：扫描期间配置变更时，权威结果须按当前配置裁剪——
      // 已移除文件夹的行过滤（避免移除行复活），增量导入的文件夹行按前缀保留（避免被晚到结果抹掉）
      set(s => {
        const now = useSettingsStore.getState().config.extra_folders || [];
        const nowNorm = now.map(p => p.replace(/\\/g, '/').toLowerCase());
        const added = nowNorm.filter(f => !callFolders.includes(f));
        const removed = callFolders.filter(f => !nowNorm.includes(f));
        let result = projects;
        if (removed.length > 0) {
          result = result.filter(p => {
            const pp = p.path.replace(/\\/g, '/').toLowerCase();
            return !removed.some(r => pp === r || pp.startsWith(r + '/'));
          });
        }
        if (added.length > 0) {
          const inResult = new Set(result.map(p => p.path.replace(/\\/g, '/').toLowerCase()));
          const late = s.projects.filter(p => {
            const pp = p.path.replace(/\\/g, '/').toLowerCase();
            return !inResult.has(pp) && added.some(a => pp === a || pp.startsWith(a + '/'));
          });
          result = [...result, ...late];
        }
        // 扫描期间本地新增的目录（新建/外部监听插行）插回结果，避免扫描收尾时整行消失
        const resultPaths = new Set<string>();
        collectProjectPaths(result, resultPaths);
        const lateEntries: Array<{ node: Project; depth: number }> = [];
        collectProjectNodes(s.projects, lateEntries);
        const roots = [rootPath, ...(useSettingsStore.getState().config.extra_folders || [])];
        for (const { node } of lateEntries.sort((a, b) => a.depth - b.depth)) {
          const key = projectKey(node.path);
          if (beforePaths.has(key) || resultPaths.has(key)) continue;
          result = insertProjectNode(result, roots, node);
          resultPaths.add(key);
        }
        return { projects: result };
      });
    } catch (e) {
      if (isCurrent()) warnDocument(`扫描未完成，已保留现有目录 / Scan incomplete; existing folders were kept: ${String(e)}`);
    }
  },

  loadNotes: async (rootPath) => {
    const generation = ++notesGeneration;
    const { config, storageRevision } = useSettingsStore.getState();
    const roots = [config.storage_path, ...config.extra_folders].filter(Boolean);
    const beforePaths = new Set(get().notes.map(note => pathIdentity(note.path)));
    set(state => ({
      isLoading: true,
      notes: state.notes.filter(note => roots.some(root => isPathWithin(note.path, root))),
      activeFolder: state.activeFolder && roots.some(root => isPathWithin(state.activeFolder!, root)) ? state.activeFolder : null,
    }));
    const pending = getAllNotes(rootPath, config.extra_folders);
    const scanId = getScanId(pending);
    const isCurrent = () => {
      const current = useSettingsStore.getState();
      return generation === notesGeneration && storageRevision === current.storageRevision && isCurrentScan(scanId, 'notes', current.config.storage_path, current.config.extra_folders);
    };
    const t0 = performance.now();
    try {
      const loaded = await pending;
      if (!isCurrent()) return;
      const current = useSettingsStore.getState().config;
      const currentRoots = [current.storage_path, ...current.extra_folders].filter(Boolean);
      const notes = loaded.filter(note => currentRoots.some(root => isPathWithin(note.path, root)));
      const incoming = new Set(notes.map(note => pathIdentity(note.path)));
      const added = current.extra_folders.filter(folder => !config.extra_folders.some(old => pathIdentity(old) === pathIdentity(folder)));
      const late = get().notes.filter(note => currentRoots.some(root => isPathWithin(note.path, root)) && !incoming.has(pathIdentity(note.path)) && (!beforePaths.has(pathIdentity(note.path)) || added.some(root => isPathWithin(note.path, root))));
      const merged = [...notes, ...late];
      const dt = performance.now() - t0;
      if (dt > 200) perfReport('scan-notes', dt, `count=${merged.length}`);
      get().setNotesFromCache(merged);
    } catch (e) {
      if (isCurrent()) warnDocument(`扫描未完成，已保留现有笔记 / Scan incomplete; existing notes were kept: ${String(e)}`);
    } finally {
      if (isCurrent()) set({ isLoading: false });
    }
  },

  loadNotesInFolder: async (folderPath, rootPath) => {
    const generation = ++folderGeneration;
    const revision = useSettingsStore.getState().storageRevision;
    const isCurrent = () => {
      const current = useSettingsStore.getState();
      return generation === folderGeneration && revision === current.storageRevision && pathIdentity(rootPath) === pathIdentity(current.config.storage_path) && get().activeFolder === folderPath;
    };
    set({ isLoading: true });
    try {
      const notes = await getNotesInFolder(folderPath, rootPath);
      if (isCurrent()) set({ notes });
    } catch (e) {
      if (isCurrent()) warnDocument(`文件夹刷新失败 / Folder refresh failed: ${String(e)}`);
    } finally {
      if (isCurrent()) set({ isLoading: false });
    }
  },

  selectNote: (note) => openDocument(note),
  isCurrentOpen: (requestId) => !get().closing && navigationGeneration === requestId,

  switchTab: async (path) => {
    const session = findSession(path);
    if (!session) return;
    await openDocument(session.note, session.temporary);
  },

  closeTab: (path) => closeDocuments([path]),

  closeAllTabs: async () => {
    invalidateOpen();
    openingReads.clear();
    await closeDocuments(get().openTabs.map(t => t.path));
  },

  closeOtherTabs: async (path) => {
    if (!findSession(path)) return;
    await closeDocuments(get().openTabs.filter(t => documentKey(t.path) !== documentKey(path)).map(t => t.path));
  },

  closeLeftTabs: async (path) => {
    const tabs = get().openTabs;
    const index = tabs.findIndex(t => documentKey(t.path) === documentKey(path));
    if (index > 0) await closeDocuments(tabs.slice(0, index).map(t => t.path));
  },

  closeRightTabs: async (path) => {
    const tabs = get().openTabs;
    const index = tabs.findIndex(t => documentKey(t.path) === documentKey(path));
    if (index >= 0) await closeDocuments(tabs.slice(index + 1).map(t => t.path));
  },

  reloadOpenTabs: async (changedPaths) => {
    if (get().closing) return;
    const changed = new Set(changedPaths.map(documentKey));
    await Promise.all([...sessions.values()].map(async session => {
      const { note, revision, password } = session;
      if (!changed.has(documentKey(note.path)) || dirty(session) || session.savePromise || isPdfPath(note.path) ||
          [...pathGuards].some(g => inScope(note.path, g))) return;
      const encrypted = note.is_encrypted || encryptedPath(note.path);
      if (encrypted && !password) return;
      const generation = ++session.reloadGeneration;
      try {
        const snapshot = encrypted ? await decryptNote(note.path, password!) : await readNote(note.path);
        if (!isLive(session) || session.revision !== revision || dirty(session) || session.savePromise || session.reloadGeneration !== generation) return;
        session.diskVersion = snapshot.disk_version;
        if (session.content === snapshot.content) return;
        session.content = snapshot.content;
        session.revision = ++revisionClock;
        session.savedRevision = session.revision;
        publish(session);
      } catch (error) {
        console.warn('Failed to reload tab:', note.path, error);
      }
    }));
  },

  runDocumentWork: (path, identity, key, run, draft) => {
    const session = findSession(path);
    if (!session || session.identity !== identity || get().closing || !isWritable(session)) return Promise.resolve(false);
    const existing = session.work.get(key);
    if (existing?.promise) return existing.promise;
    if (key.startsWith('annotation:') && [...session.work.values()].some(work => work.key.startsWith('annotation:') && work.key !== key && work.error)) {
      warnDocument('请先重试之前未保存的批注 / Retry the previous annotation change first');
      return Promise.resolve(false);
    }
    if (!existing && session.work.size >= 16) {
      warnDocument('待完成操作过多，请稍后再试 / Too many pending document operations');
      return Promise.resolve(false);
    }
    const work: DocumentWork = { key, run, draft, promise: null, error: null };
    session.work.set(key, work);
    return startWork(session, work);
  },

  getDocumentWork: (path, prefix) => {
    const matches = [...(findSession(path)?.work.values() ?? [])].filter(work => work.key.startsWith(prefix));
    const work = matches.find(work => work.error) ?? matches[0];
    return work ? { key: work.key, pending: matches.some(work => !!work.promise), error: work.error, draft: work.draft } : null;
  },

  waitDocumentWork: async (path, prefix) => {
    const session = findSession(path);
    if (!session) return false;
    for (;;) {
      const work = [...session.work.values()].filter(work => work.key.startsWith(prefix));
      const running = work.flatMap(work => work.promise ? [work.promise] : []);
      if (!running.length) return isLive(session) && work.every(work => !work.error);
      await Promise.all(running);
    }
  },

  retryDocumentWork: async (path, prefix) => {
    const session = findSession(path);
    if (!session) return false;
    const work = [...session.work.values()].filter(work => work.key.startsWith(prefix));
    return (await Promise.all(work.map(work => startWork(session, work)))).every(Boolean);
  },

  getDocumentSession: (path) => {
    const session = findSession(path);
    return session ? {
      identity: session.identity, path: session.note.path, content: session.content,
      revision: session.revision, savedRevision: session.savedRevision,
      isDirty: dirty(session) || session.work.size > 0, saveStatus: statusOf(session), saveError: errorOf(session),
      isTemporaryFile: session.temporary,
    } : null;
  },

  getDocumentRevision: (path) => findSession(path)?.revision ?? null,

  updateDocumentContent: (path, content, expectedRevision) => {
    const session = findSession(path);
    if (!session || session.revision !== expectedRevision) return false;
    return editSession(session, content);
  },

  updateContent: (content, _rootPath) => {
    const session = findSession(get().activeTabPath);
    if (session) editSession(session, content);
  },

  saveCurrentNote: () => {
    const session = findSession(get().activeTabPath);
    return session ? saveDocument(session) : Promise.resolve(true);
  },

  saveDocument: (path, identity) => {
    const session = findSession(path);
    return session?.identity === identity ? saveDocument(session) : Promise.resolve(false);
  },

  saveDocumentCopy: async (path, identity, targetPath) => {
    const session = findSession(path);
    if (!session || session.identity !== identity || get().closing) return false;
    await get().waitDocumentWork(path, '');
    if (!isLive(session)) return false;
    const { content, password, note } = session;
    const draft = [...session.work.values()].find(work => work.key.startsWith('annotation:'))?.draft;
    const intent = navigationGeneration;
    return get().withDocumentPathChange(targetPath, false, async () => {
      const snapshot = await saveDocumentCopy(note.path, targetPath, content, draft, password ?? undefined);
      const now = new Date().toISOString();
      const newNote = { ...note, id: snapshot.id, path: snapshot.id, title: snapshot.id.split(/[\\/]/).pop() ?? snapshot.id, folder: snapshot.id.slice(0, Math.max(snapshot.id.lastIndexOf('/'), snapshot.id.lastIndexOf('\\'))), created_at: now, modified_at: now, pinned: false };
      const copy = newSession(newNote, snapshot.content, snapshot.disk_version, true, session.viewMode, password);
      const tabs = [...get().openTabs, asTab(copy)];
      if (intent === navigationGeneration) activate(copy, tabs);
      else set({ openTabs: tabs });
      get().registerCreatedNote(newNote);
    });
  },

  discardDocument: (path, identity, expectedRevision) => {
    const session = findSession(path);
    if (!session || session.identity !== identity || (expectedRevision !== undefined && session.revision !== expectedRevision) ||
        get().closing || session.savePromise || session.drainPromise || [...session.work.values()].some(work => work.promise) ||
        [...pathGuards].some(guard => inScope(path, guard))) return false;
    session.work.clear();
    removeSession(session);
    return true;
  },

  withDocumentPathChange: (path, directory, change, destinations = [], options) => {
    const preserveOpenRequest = options?.preserveOpenRequest;
    if (preserveOpenRequest !== undefined && (pendingOpen?.requestId !== preserveOpenRequest || documentKey(pendingOpen.note.path) !== documentKey(path))) return Promise.resolve(false);
    const scopes = [{ path, directory }, ...destinations].map(s => ({ ...s, sealed: false }));
    if (get().closing || scopes.some(s => [...pathGuards].some(g => inScope(s.path, g) || inScope(g.path, s)))) return Promise.resolve(false);
    for (const scope of scopes) pathGuards.add(scope);
    const affected = (p: string) => scopes.some(s => inScope(p, s));
    const intentPath = pendingOpen?.note.path ?? get().activeTabPath;
    if (intentPath && affected(intentPath) && preserveOpenRequest === undefined) invalidateOpen(options?.preserveDialog !== true);
    for (const session of sessions.values()) if (affected(session.note.path)) ++session.reloadGeneration;
    const operation = Promise.resolve().then(async () => {
      try {
        for (;;) {
          const pending = [...sessions.values()].filter(s => affected(s.note.path) && hasPending(s));
          if (!pending.length) break;
          if ((await Promise.all(pending.map(saveDocument))).some(ok => !ok)) return false;
        }
        // Admission above rejects new work during close. Already accepted work
        // (notably create's supplied body) belongs to the close drain, not cancellation.
        for (const scope of scopes) scope.sealed = true;
        publishReadOnly();
        await change();
        return true;
      } finally {
        for (const scope of scopes) pathGuards.delete(scope);
        pathOperations.delete(operation);
        publishReadOnly();
      }
    });
    pathOperations.add(operation);
    return operation;
  },

  deleteDocument: (path, directory = false) => get().withDocumentPathChange(path, directory, async () => {
    if (directory) await deleteFolder(path);
    else await deleteNote(path);
    const scope = { path, directory };
    for (const key of openingReads.keys()) if (inScope(key, scope)) openingReads.delete(key);
    if (pendingOpen && inScope(pendingOpen.note.path, scope)) invalidateOpen();
    for (const session of [...sessions.values()]) if (inScope(session.note.path, scope)) removeSession(session);
  }),

  changeDocumentEncryption: (path, password, enabled) => {
    if (enabled === encryptedPath(path)) return Promise.resolve(false);
    const target = enabled ? `${path}.encrypted` : path.slice(0, -'.encrypted'.length);
    return get().withDocumentPathChange(path, false, async () => {
      const session = findSession(path);
      const snapshot = enabled ? await encryptNote(path, password, session?.diskVersion) : await removeEncryption(path, password, session?.diskVersion);
      if (session) {
        session.password = enabled ? password : null;
        session.diskVersion = snapshot.disk_version;
        session.note = { ...session.note, is_encrypted: enabled };
      }
      const newPath = snapshot.id;
      get().applyNotePathChange(path, newPath, newPath.split(/[\\/]/).pop() ?? newPath);
    }, [{ path: target, directory: false }], { preserveDialog: true });
  },

  createDocument: async (folder, title, content = '', shouldActivate = true) => {
    if (get().closing) return null;
    if (shouldActivate) invalidateOpen();
    const intent = navigationGeneration;
    const filename = /\.(md|markdown|txt|html|htm)$/.test(title) ? title : `${title}.md`;
    let created: NoteMetadata | null = null;
    const done = await get().withDocumentPathChange(`${folder}/${filename}`, false, async () => {
      const note = await createNote(folder, title);
      created = note;
      if (content) {
        const session = newSession(note, content, note.disk_version, false);
        session.savedRevision = 0;
        if (await saveSession(session)) sessions.delete(documentKey(note.path));
        else set({ openTabs: [...get().openTabs, asTab(session)] });
      }
      get().registerCreatedNote(note);
    });
    if (!done || !created) return null;
    const requestId = shouldActivate ? await openDocument(created, false, undefined, intent) : null;
    return { note: created, requestId };
  },

  flushPendingSaves: async () => {
    for (;;) {
      await waitForPathOperations();
      if (pathOperations.size) continue;
      const pending = [...sessions.values()].filter(hasPending);
      if (!pending.length) return true;
      const results = await Promise.all(pending.map(saveDocument));
      if (results.some(ok => !ok)) return false;
    }
  },

  setSearchQuery: (query, rootPath) => {
    const generation = ++searchGeneration;
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = null;
    queuedSearch?.resolve();
    queuedSearch = null;
    // Filename-only scope and PDF-only types have no text to scan: the tree
    // filters local names instead of paying for a native full-text pass.
    const wantsContent = query.trim() !== '' && get().searchScope === 'content' && get().searchType !== 'pdf';
    set({ searchQuery: query, searchResults: [], searchError: null, searchStatus: wantsContent ? 'loading' : 'idle' });
    if (searchSession !== null) {
      void searchSession.then(sessionId => invalidateSearch(sessionId, generation)).catch(error => {
        const current = get();
        if (generation === searchGeneration && (current.searchStatus === 'loading' || current.searchQuery.trim() === '')) {
          set({ searchStatus: 'error', searchError: String(error) });
        }
      });
    }
    if (!wantsContent) return Promise.resolve();
    return new Promise<void>(resolve => {
      queuedSearch = { generation, root: rootPath, query: query.trim(), extras: [...useSettingsStore.getState().config.extra_folders], resolve };
      searchTimer = setTimeout(() => { searchTimer = null; void runSearch(); }, 250);
    });
  },

  setSearchFilters: (filters) => {
    const scope = filters.scope ?? get().searchScope;
    const type = filters.type ?? get().searchType;
    if (scope === get().searchScope && type === get().searchType) return;
    set({ searchScope: scope, searchType: type });
    const query = get().searchQuery;
    if (query.trim()) void get().setSearchQuery(query, useSettingsStore.getState().config.storage_path);
  },

  setActiveFolder: async (folder, rootPath, requestId) => {
    const isCurrentOpen = () => requestId === undefined || get().isCurrentOpen(requestId);
    if (!isCurrentOpen()) return;
    const generation = ++folderGeneration;
    const revision = useSettingsStore.getState().storageRevision;
    const isCurrent = () => {
      const current = useSettingsStore.getState();
      return generation === folderGeneration && revision === current.storageRevision && pathIdentity(rootPath) === pathIdentity(current.config.storage_path) && isCurrentOpen();
    };
    void get().setSearchQuery('', rootPath);
    set({ activeFolder: folder, isLoading: true });
    try {
      const notes = folder ? await getNotesInFolder(folder, rootPath)
        : await getAllNotes(rootPath, useSettingsStore.getState().config.extra_folders || []);
      if (!isCurrent()) return;
      set({ notes, isLoading: false });
      if (get().sortMode === 'custom') {
        const order = await getSortOrder(rootPath, folder || '');
        if (isCurrent()) set({ customSortOrder: order });
      }
    } catch (error) {
      if (isCurrent()) set({ isLoading: false });
      console.error('Failed to select folder:', error);
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

  applyNotePathChange: (oldPath, newPath, newTitle) => {
    const state = get();
    const oldKey = oldPath.replace(/\\/g, '/');
    const active = findSession(state.activeTabPath);
    const session = findSession(oldPath);
    if (session) {
      migrateSession(session, { ...session.note, id: newPath, path: newPath, title: newTitle });
    }
    openingReads.delete(documentKey(oldPath));
    if (pendingOpen && documentKey(pendingOpen.note.path) === documentKey(oldPath)) invalidateOpen();
    const updatedTabs = state.openTabs.map(t =>
      session && documentKey(t.path) === documentKey(oldPath) ? asTab(session) : t
    );
    const updates: Partial<NotesState> = { openTabs: updatedTabs, ...activeFields(active) };
    const oldNote = state.notes.find(n => n.path.replace(/\\/g, '/') === oldKey);
    if (oldNote) {
      // 本地同步换行：全量刷新是渐进 chunk 合并，旧路径行要到扫描收尾才消失，期间会新旧标题并存闪现
      updates.notes = [
        ...state.notes.filter(n => n.path.replace(/\\/g, '/') !== oldKey),
        { ...oldNote, id: newPath, path: newPath, title: newTitle, is_encrypted: encryptedPath(newPath) },
      ].sort((a, b) => b.modified_at.localeCompare(a.modified_at));
    }
    set(updates);
    // 侧栏的 allNotes 是组件级缓存，store 改不到——广播给 UnifiedTree 自行换行
    window.dispatchEvent(new CustomEvent('note-path-changed', { detail: { oldPath, newPath, newTitle } }));
  },

  applyFolderPathChange: (fromPath, toPath) => {
    // 目录改名：所有落在该目录下的标签/活动笔记/展开状态按前缀换路径，
    // 与树侧保持一致，避免外部改名后旧路径残留在标签栏里
    const fromSlash = fromPath.replace(/\\/g, '/');
    const fromKey = fromSlash.toLowerCase();
    const toSlash = toPath.replace(/\\/g, '/');
    const isUnder = (p: string) => {
      const np = p.replace(/\\/g, '/').toLowerCase();
      return np === fromKey || np.startsWith(`${fromKey}/`);
    };
    const remap = (p: string) => toSlash + p.replace(/\\/g, '/').slice(fromSlash.length);
    const remapNote = (n: NoteMetadata): NoteMetadata => {
      if (!isUnder(n.path)) return n;
      const path = remap(n.path);
      return { ...n, id: path, path };
    };
    const active = findSession(get().activeTabPath);
    for (const session of [...sessions.values()]) {
      if (isUnder(session.note.path)) migrateSession(session, remapNote(session.note));
    }
    for (const key of openingReads.keys()) {
      if (isUnder(key)) openingReads.delete(key);
    }
    if (pendingOpen && isUnder(pendingOpen.note.path)) invalidateOpen();
    set(s => ({
      openTabs: s.openTabs.map(t => isUnder(t.path) ? asTab(findSession(remap(t.path))!) : t),
      ...activeFields(active),
      notes: s.notes.map(remapNote),
      activeFolder: s.activeFolder && isUnder(s.activeFolder) ? remap(s.activeFolder) : s.activeFolder,
      expandedFolders: s.expandedFolders.map(p => (isUnder(p) ? remap(p) : p)),
    }));
  },

  registerCreatedNote: (note) => {
    window.dispatchEvent(new CustomEvent('note-created', { detail: { note } }));
  },

  mergeProjectChunk: (project) => {
    // 发现阶段空壳只补新行，不能在扫描失败时抹掉已有子树；完整 chunk 才权威替换。
    // 在途扫描的 chunk 可能属于已移除文件夹：不在当前根之下的 chunk 忽略，避免移除行复活
    const cfg = useSettingsStore.getState().config;
    const pp = project.path.replace(/\\/g, '/').toLowerCase();
    const roots = [cfg.storage_path, ...(cfg.extra_folders || [])].filter(Boolean)
      .map(p => p.replace(/\\/g, '/').toLowerCase());
    if (!roots.some(r => pp === r || pp.startsWith(r + '/'))) return;
    set(s => {
      const existing = s.projects.some(p => projectKey(p.path) === projectKey(project.path));
      if (project.scanning && existing) return s;
      return {
        projects: existing
          ? s.projects.map(p => (projectKey(p.path) === projectKey(project.path) ? project : p))
          : [...s.projects, project],
      };
    });
  },

  setNotesFromCache: (loaded) => {
    // 用已扫描的全量笔记更新 store.notes，避免重复磁盘扫描
    const { activeFolder, searchQuery } = get();
    set({ notes: activeFolder ? loaded.filter(note => inScope(note.path, { path: activeFolder, directory: true })) : loaded });
    if (searchQuery.trim()) void get().setSearchQuery(searchQuery, useSettingsStore.getState().config.storage_path);
  },

  duplicateNote: async (rootPath) => {
    const { activeNote, activeFolder, activeContent } = get();
    if (!activeNote || isPdfPath(activeNote.path)) return;
    if (activeNote.is_encrypted || encryptedPath(activeNote.path)) {
      warnDocument('不能将加密草稿复制为明文 / Cannot duplicate an encrypted draft as plaintext');
      return;
    }
    try {
      const copyTitle = `${activeNote.title} copy`;
      const folder = activeFolder || rootPath;
      await get().createDocument(folder, copyTitle, activeContent, false);
    } catch (e) {
      console.error('Failed to duplicate note:', e);
    }
  },

  setEncryptionDialog: (dialog) => {
    if (get().closing) return;
    invalidateOpen();
    set({ encryptionDialog: dialog });
  },

  onNoteUnlocked: (notePath, snapshot, password, requestId) => {
    const target = pendingOpen;
    const dialog = get().encryptionDialog;
    if (get().closing || !password || !target || target.requestId !== requestId || navigationGeneration !== requestId ||
        documentKey(target.note.path) !== documentKey(notePath) || !dialog?.visible ||
        dialog.mode !== 'unlock' || dialog.requestId !== requestId || documentKey(dialog.notePath) !== documentKey(notePath)) return false;
    // Unlock creates the requested session, never writes into the old active tab.
    handOff(notePath);
    const session = findSession(notePath) ?? newSession(
      { ...target.note, is_encrypted: true }, snapshot.content, snapshot.disk_version, target.temporary, target.viewMode, password,
    );
    pendingOpen = null;
    set({ encryptionDialog: null });
    activate(session, get().openTabs.some(t => documentKey(t.path) === documentKey(notePath))
      ? get().openTabs : [...get().openTabs, asTab(session)]);
    return true;
  },

  clearEncryptionPassword: () => {
    const session = findSession(get().activeTabPath);
    if (!session) return;
    session.password = null;
    publish(session);
  },

  openTemporaryFile: (path, initialViewMode = 'split') => {
    const slash = path.replace(/\\/g, '/');
    const known = get().notes.find(n => documentKey(n.path) === documentKey(path));
    const meta: NoteMetadata = known ?? {
      id: path, path,
      title: slash.split('/').pop()?.replace(/\.(md|pdf)$/i, '') || 'Untitled',
      folder: slash.substring(0, slash.lastIndexOf('/')),
      created_at: new Date().toISOString(), modified_at: new Date().toISOString(),
      pinned: false, size: 0, is_encrypted: encryptedPath(path),
    };
    return openDocument(meta, true, initialViewMode);
  },
  };
});

/** Window-close transaction; inject only the native destroy operation, never call close() recursively. */
export function createDocumentCloseHandler(destroyWindow: () => Promise<void>) {
  let draining = false;
  return async (event: { preventDefault: () => void }): Promise<void> => {
    // Prevent Tauri's implicit destroy too, so native permission errors are caught below.
    event.preventDefault();
    if (draining) return;
    draining = true;
    const store = useNotesStore.getState();
    store.setClosing('draining');
    try {
      if (!(await store.flushPendingSaves())) {
        warnDocument('保存失败，窗口保持打开，草稿已保留 / Save failed; window and drafts retained');
        return;
      }
      store.setClosing('destroying');
      // Seal edits before the final drain, including edits queued with the first drain's completion.
      if (!(await store.flushPendingSaves())) return;
      await destroyWindow();
    } catch (error) {
      warnDocument(`窗口关闭失败 / Window close failed: ${String(error)}`);
    } finally {
      store.setClosing(null);
      draining = false;
    }
  };
}
