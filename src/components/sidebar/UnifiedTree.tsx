import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { Project, NoteMetadata } from '../../types';
import { useNotesStore } from '../../stores/notes-store';
import { useSettingsStore } from '../../stores/settings-store';
import {
  createNote, deleteNote, renameNote,
  createFolder, moveNote, renameFolder, deleteFolder,
  revealInFinder, openInTerminal, getAllNotes,
  startWatching,
} from '../../services/tauri-bridge';
import { useTranslation } from 'react-i18next';
import { SyncStatusIndicator } from '../shared/SyncStatus';
import { EncryptionDialog } from '../shared/EncryptionDialog';

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
    selectNote, searchQuery, setSearchQuery,
    isLoading, refreshNotes, loadProjects,
    encryptionDialog, setEncryptionDialog, onNoteUnlocked,
    expandedFolders, allNotesExpanded,
    toggleExpandedFolder, setAllNotesExpanded, clearExpandedFolders,
  } = useNotesStore();
  const { config } = useSettingsStore();

  const [contextMenu, setContextMenu] = useState<TreeContextMenu>(null);
  const [renamingNoteId, setRenamingNoteId] = useState<string | null>(null);
  const [renameNoteValue, setRenameNoteValue] = useState('');
  const [renamingFolderPath, setRenamingFolderPath] = useState<string | null>(null);
  const [renameFolderValue, setRenameFolderValue] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  /* ── Local cache of ALL notes (not filtered by active folder) ── */
  const [allNotes, setAllNotes] = useState<NoteMetadata[]>([]);

  const reloadAllNotes = useCallback(async () => {
    try {
      const cfg = useSettingsStore.getState().config;
      const loaded = await getAllNotes(cfg.storage_path, cfg.extra_folders || []);
      setAllNotes(loaded);
    } catch (e) { console.error('Failed to load all notes:', e); }
  }, []);

  // Load all notes on mount, when storage path changes, or when extra folders change
  useEffect(() => { reloadAllNotes(); }, [config.storage_path, config.extra_folders, reloadAllNotes]);

  /* ── Refresh both store notes and local all-notes cache ── */
  const handleRefreshAll = useCallback(async () => {
    await refreshNotes(config.storage_path);
    await reloadAllNotes();
  }, [refreshNotes, config.storage_path, reloadAllNotes]);

  /* ── Watch filesystem changes ── */
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    // Start watching storage path + extra folders
    const watchPaths = [config.storage_path, ...(config.extra_folders || [])].filter(Boolean);
    if (watchPaths.length > 0) {
      startWatching(watchPaths).catch(e => console.error('Failed to start watcher:', e));
    }

    const unlisten = listen<{ type: string; paths: string[] }>('fs-change', (event) => {
      // Debounce: wait 500ms after last event before refreshing
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        await refreshNotes(config.storage_path);
        await reloadAllNotes();
        await loadProjects(config.storage_path);
        // Reload content of open tabs if their files changed externally
        if (event.payload.paths.length > 0) {
          useNotesStore.getState().reloadOpenTabs(event.payload.paths);
        }
      }, 500);
    });

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      unlisten.then(fn => fn());
    };
  }, [config.storage_path, config.extra_folders, refreshNotes, reloadAllNotes, loadProjects]);

  /* ── Search filter (local, by title) ── */
  const filteredNotes = useMemo(() => {
    if (!searchQuery.trim()) return allNotes;
    const q = searchQuery.toLowerCase();
    return allNotes.filter(n => n.title.toLowerCase().includes(q));
  }, [allNotes, searchQuery]);

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

  const getNotesFor = useCallback((folderPath: string) =>
    notesByFolder[folderPath] || [], [notesByFolder]);

  /* ── Count notes in folder (including subfolders) ── */
  const countNotesIn = useCallback((folderPath: string): number => {
    let count = (notesByFolder[folderPath] || []).length;
    // Recursively count subfolders
    const sep = folderPath.includes('\\') ? '\\' : '/';
    const prefix = folderPath + sep;
    for (const key of Object.keys(notesByFolder)) {
      if (key.startsWith(prefix)) count += notesByFolder[key].length;
    }
    return count;
  }, [notesByFolder]);

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
        <span className="flex-shrink-0 opacity-40"><IconFile /></span>
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
  const prevSearchRef = useRef(searchQuery);
  useEffect(() => {
    const prev = prevSearchRef.current.trim();
    const curr = searchQuery.trim();
    prevSearchRef.current = searchQuery;
    if (prev && !curr) {
      // No folder selected → collapse all auto-expanded folders
        clearExpandedFolders();
    }
  }, [searchQuery, projects, folderMatchesSearch, clearExpandedFolders]);

  /* ── Render a folder row (recursive) ── */
  const renderFolderRow = (project: Project, depth: number) => {
    const query = searchQuery.trim();
    // During search, skip folders that don't match
    if (query && !folderMatchesSearch(project, query)) return null;

    const isExpanded = query ? true : expandedFolders.includes(project.path);
    const isActive = false;
    const isRenaming = renamingFolderPath === project.path;
    const folderNotes = getNotesFor(project.path);
    const noteCount = countNotesIn(project.path);

    return (
      <div key={`folder-${project.path}`}>
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
                loadProjects(config.storage_path);
                handleRefreshAll();
              }}
              title="Remove from tree (keeps local files)"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
        {isExpanded && (
          <>
            {project.children.map(child => renderFolderRow(child, depth + 1))}
            {folderNotes.map(note => renderNoteRow(note, depth + 1))}
          </>
        )}
      </div>
    );
  };

  /* ── Render All Notes expanded: projects + root notes ── */
  const renderAllNotesContent = () => {
    const rootNotes = getNotesFor(config.storage_path);
    return (
      <>
        {projects.map(p => renderFolderRow(p, 0))}
        {rootNotes.map(note => renderNoteRow(note, 0))}
      </>
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
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value, config.storage_path)}
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
      <div className="flex-1 overflow-y-auto py-0.5">
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
          <span className="ml-auto text-[10px] opacity-50">{allNotes.length}</span>
        </div>

        {/* Tree content */}
        {allNotesExpanded && renderAllNotesContent()}

        {/* Loading / Empty */}
        {isLoading && allNotes.length === 0 ? (
          <div className="flex items-center justify-center h-12 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>Loading...</div>
        ) : filteredNotes.length === 0 && searchQuery ? (
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
