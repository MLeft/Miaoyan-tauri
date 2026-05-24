import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { Project, NoteMetadata, SortMode } from '../../types';
import { useNotesStore } from '../../stores/notes-store';
import { useSettingsStore } from '../../stores/settings-store';
import { createNote, deleteNote, renameNote, togglePin, createFolder } from '../../services/tauri-bridge';
import { useTranslation } from 'react-i18next';
import { SyncStatusIndicator } from '../shared/SyncStatus';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  DragOverlay,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { EncryptionDialog } from '../shared/EncryptionDialog';

/* SVG icons */
const IconLockSmall = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

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
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const IconSearch = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

/* Sortable Note Item */
interface SortableNoteItemProps {
  note: NoteMetadata;
  isActive: boolean;
  showFolder: boolean;
  isRenaming: boolean;
  renameValue: string;
  onRenameValueChange: (v: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  formatDate: (dateStr: string) => string;
}

function SortableNoteItem({
  note, isActive, showFolder, isRenaming, renameValue,
  onRenameValueChange, onRenameSubmit, onRenameCancel,
  onSelect, onContextMenu, formatDate,
}: SortableNoteItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: note.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    minHeight: '52px',
    padding: '8px 12px',
    borderRadius: '6px',
    backgroundColor: isActive ? 'var(--accent-light)' : 'transparent',
    opacity: isDragging ? 0.5 : 1,
    cursor: isDragging ? 'grabbing' : 'pointer',
    position: 'relative' as const,
    zIndex: isDragging ? 50 : 'auto' as unknown as number,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="transition-colors"
      onClick={onSelect}
      onContextMenu={onContextMenu}
      {...attributes}
      {...listeners}
    >
      <div className="flex items-center gap-1">
        {note.pinned && <span className="text-[10px]" style={{ color: 'var(--pin-color)' }}>&#9733;</span>}
        {note.is_encrypted && <span style={{ color: 'var(--text-tertiary)', opacity: 0.7 }}><IconLockSmall /></span>}
        {isRenaming ? (
          <input
            autoFocus value={renameValue}
            onChange={(e) => onRenameValueChange(e.target.value)}
            onBlur={onRenameSubmit}
            onKeyDown={(e) => { if (e.key === 'Enter') onRenameSubmit(); if (e.key === 'Escape') onRenameCancel(); }}
            className="flex-1 px-1 py-0 text-xs font-medium rounded outline-none"
            style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--accent)' }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
            {note.title}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 mt-0.5">
        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{formatDate(note.modified_at)}</span>
        {showFolder && note.folder && <span className="text-[11px] truncate" style={{ color: 'var(--text-tertiary)' }}>{note.folder}</span>}
      </div>
    </div>
  );
}

/* Drag overlay for the item being dragged */
function DragOverlayNoteItem({ note, formatDate }: { note: NoteMetadata; formatDate: (d: string) => string }) {
  return (
    <div
      style={{
        minHeight: '52px',
        padding: '8px 12px',
        backgroundColor: 'var(--bg-secondary)',
        borderRadius: '6px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        transform: 'scale(1.02)',
        transition: 'transform 150ms ease',
        cursor: 'grabbing',
      }}
    >
      <div className="flex items-center gap-1">
        {note.pinned && <span className="text-[10px]" style={{ color: 'var(--pin-color)' }}>&#9733;</span>}
        <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{note.title}</span>
      </div>
      <div className="flex items-center gap-1.5 mt-0.5">
        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{formatDate(note.modified_at)}</span>
      </div>
    </div>
  );
}

export function CombinedSidebar() {
  const { t } = useTranslation();
  const {
    projects, notes, activeNote, activeFolder,
    selectNote, searchQuery, setSearchQuery,
    sortMode, sortDirection, setSortMode, toggleSortDirection,
    isLoading, refreshNotes, setActiveFolder, loadProjects,
    customSortOrder, loadCustomSortOrder, applyCustomSortOrder,
    encryptionDialog, setEncryptionDialog, onNoteUnlocked,
  } = useNotesStore();
  const { config } = useSettingsStore();
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; note: NoteMetadata } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [dragActiveId, setDragActiveId] = useState<string | null>(null);

  // DnD sensors (only active in custom sort mode)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Sort notes: pinned first, then by sort mode
  const sortedNotes = useMemo(() => {
    const sorted = [...notes].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;

      if (sortMode === 'custom') {
        const orderA = customSortOrder.indexOf(a.id);
        const orderB = customSortOrder.indexOf(b.id);
        // Notes not in custom order go to the end
        if (orderA === -1 && orderB === -1) return 0;
        if (orderA === -1) return 1;
        if (orderB === -1) return -1;
        return orderA - orderB;
      }

      let cmp = 0;
      switch (sortMode) {
        case 'modified': cmp = new Date(a.modified_at).getTime() - new Date(b.modified_at).getTime(); break;
        case 'created': cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime(); break;
        case 'title': cmp = a.title.localeCompare(b.title); break;
      }
      return sortDirection === 'desc' ? -cmp : cmp;
    });
    return sorted;
  }, [notes, sortMode, sortDirection, customSortOrder]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setDragActiveId(null);
    if (!over || active.id === over.id) return;

    const currentNotes = sortedNotes;
    const oldIndex = currentNotes.findIndex((n) => n.id === active.id);
    const newIndex = currentNotes.findIndex((n) => n.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    // Reorder
    const reordered = [...currentNotes];
    const [moved] = reordered.splice(oldIndex, 1);
    reordered.splice(newIndex, 0, moved);

    // Update notes array in store and persist
    const noteIds = reordered.map((n) => n.id);
    applyCustomSortOrder(config.storage_path, activeFolder, noteIds);
    // Also update the notes array order in the store
    useNotesStore.setState({ notes: reordered });
  }, [sortedNotes, config.storage_path, activeFolder, applyCustomSortOrder]);

  const toggleFolderExpand = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  };

  const handleSelectFolder = (path: string | null) => {
    setActiveFolder(path, config.storage_path);
  };

  const handleCreateNote = async () => {
    const folder = activeFolder || config.storage_path;
    try {
      const note = await createNote(folder, `Untitled-${Date.now()}`);
      await refreshNotes(config.storage_path);
      await selectNote(note);
    } catch (e) { console.error('Failed to create note:', e); }
  };

  const handleCreateFolder = async () => {
    const name = prompt(t('sidebar.newFolder'));
    if (!name) return;
    const parent = activeFolder || config.storage_path;
    try {
      await createFolder(parent, name);
      await loadProjects(config.storage_path);
    } catch (e) { console.error('Failed to create folder:', e); }
  };

  const handlePin = async () => {
    if (!contextMenu) return;
    try { await togglePin(contextMenu.note.path); await refreshNotes(config.storage_path); }
    catch (e) { console.error('Failed to toggle pin:', e); }
    setContextMenu(null);
  };

  const handleDelete = async () => {
    if (!contextMenu) return;
    try { await deleteNote(contextMenu.note.path); await refreshNotes(config.storage_path); }
    catch (e) { console.error('Failed to delete note:', e); }
    setContextMenu(null);
  };

  const handleStartRename = () => {
    if (!contextMenu) return;
    setRenamingId(contextMenu.note.id);
    setRenameValue(contextMenu.note.title);
    setContextMenu(null);
  };

  const handleRenameSubmit = async (note: NoteMetadata) => {
    if (!renameValue.trim() || renameValue === note.title) { setRenamingId(null); return; }
    try { await renameNote(note.path, renameValue.trim()); await refreshNotes(config.storage_path); }
    catch (e) { console.error('Failed to rename note:', e); }
    setRenamingId(null);
  };

  const handleEncryptNote = () => {
    if (!contextMenu) return;
    setEncryptionDialog({ visible: true, mode: 'encrypt', notePath: contextMenu.note.path });
    setContextMenu(null);
  };

  const handleRemoveEncryption = () => {
    if (!contextMenu) return;
    setEncryptionDialog({ visible: true, mode: 'remove', notePath: contextMenu.note.path });
    setContextMenu(null);
  };

  const formatNoteDate = (dateStr: string) => {
    const d = new Date(dateStr);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hour = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${year}/${month}/${day} ${hour}:${min}`;
  };

  // Close context menu on click outside
  useEffect(() => {
    const handler = () => { if (contextMenu) setContextMenu(null); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [contextMenu]);

  // Global: focus search input via custom event (Cmd+F)
  useEffect(() => {
    const handler = () => { searchRef.current?.focus(); searchRef.current?.select(); };
    window.addEventListener('sidebar-focus-search', handler);
    return () => window.removeEventListener('sidebar-focus-search', handler);
  }, []);

  // Global: trigger rename on active note via custom event (Cmd+R)
  useEffect(() => {
    const handler = () => {
      const activeNote = useNotesStore.getState().activeNote;
      if (!activeNote) return;
      setRenamingId(activeNote.id);
      setRenameValue(activeNote.title);
    };
    window.addEventListener('sidebar-rename-note', handler);
    return () => window.removeEventListener('sidebar-rename-note', handler);
  }, []);

  const renderProject = (project: Project, depth = 0) => {
    const isExpanded = expandedFolders.has(project.path);
    const isActive = activeFolder === project.path;
    return (
      <div key={project.path}>
        <div
          className="flex items-center gap-1.5 cursor-pointer text-xs transition-colors"
          style={{
            paddingLeft: `${depth * 14 + 10}px`,
            paddingRight: '10px',
            height: '32px',
            color: isActive ? 'var(--accent-icon)' : 'var(--text-secondary)',
            backgroundColor: isActive ? 'var(--accent-light)' : 'transparent',
            borderRadius: isActive ? '8px' : '0',
            margin: isActive ? '1px 6px' : '0',
          }}
          onClick={() => handleSelectFolder(project.path)}
          onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'; }}
          onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = 'transparent'; }}
        >
          {project.children.length > 0 ? (
            <span className="w-3 h-3 flex items-center justify-center flex-shrink-0 opacity-50"
              onClick={(e) => { e.stopPropagation(); toggleFolderExpand(project.path); }}>
              {isExpanded ? <IconChevronDown /> : <IconChevronRight />}
            </span>
          ) : <span className="w-3 flex-shrink-0" />}
          <span className="flex-shrink-0 opacity-60"><IconFolder /></span>
          <span className="truncate">{project.name}</span>
        </div>
        {isExpanded && project.children.map((child) => renderProject(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col border-r sidebar-transition" style={{ backgroundColor: 'var(--bg-sidebar)', borderColor: 'var(--border)' }}>
      {/* Search + New */}
      <div className="px-2 pt-2 pb-1">
        <div className="flex items-center gap-1">
          <div className="flex-1 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm"
            style={{ backgroundColor: 'var(--bg-tertiary)' }}>
            <span style={{ color: 'var(--text-tertiary)' }}><IconSearch /></span>
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value, config.storage_path)}
              placeholder={t('notesList.search')}
              className="flex-1 bg-transparent outline-none text-sm"
              style={{ color: 'var(--text-primary)' }}
            />
          </div>
          <button
            onClick={handleCreateNote}
            className="p-1 rounded transition-colors"
            style={{ color: 'var(--text-tertiary)' }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            title={t('notesList.newNote')}
          >
            <IconPlus />
          </button>
        </div>
      </div>

      {/* Folders section */}
      <div className="px-2 py-1">
        <div className="flex items-center justify-between px-1 mb-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
            {t('sidebar.folders')}
          </span>
          <button
            onClick={handleCreateFolder}
            className="p-0.5 rounded transition-colors"
            style={{ color: 'var(--text-tertiary)' }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
          >
            <IconPlus />
          </button>
        </div>
        <div
          className="flex items-center gap-1.5 cursor-pointer text-xs transition-colors"
          style={{
            height: '40px',
            paddingLeft: '12px',
            paddingRight: '10px',
            color: activeFolder === null ? 'var(--accent-icon)' : 'var(--text-secondary)',
            backgroundColor: activeFolder === null ? 'var(--accent-light)' : 'transparent',
            borderRadius: activeFolder === null ? '8px' : '0',
            margin: activeFolder === null ? '1px 6px' : '0',
          }}
          onClick={() => handleSelectFolder(null)}
          onMouseEnter={(e) => { if (activeFolder !== null) e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'; }}
          onMouseLeave={(e) => { if (activeFolder !== null) e.currentTarget.style.backgroundColor = 'transparent'; }}
        >
          <span className="flex-shrink-0"><IconHome /></span>
          <span>{t('sidebar.allNotes')}</span>
          <span className="ml-auto text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{notes.length}</span>
        </div>
        {projects.map((project) => renderProject(project))}
      </div>

      {/* Divider */}
      <div className="mx-3 my-1" style={{ borderTop: '1px solid var(--border-light)' }} />

      {/* Sort controls */}
      <div className="px-3 py-0.5 flex items-center justify-end">
        <SyncStatusIndicator compact />
        <button
          className="text-[10px] transition-colors"
          style={{ color: 'var(--text-tertiary)' }}
          onClick={() => {
            const modes: SortMode[] = ['modified', 'created', 'title', 'custom'];
            const idx = modes.indexOf(sortMode);
            const nextMode = modes[(idx + 1) % modes.length];
            if (sortDirection === 'desc' && nextMode !== 'custom') toggleSortDirection();
            else {
              setSortMode(nextMode);
              if (nextMode === 'custom') {
                loadCustomSortOrder(config.storage_path, activeFolder);
              }
            }
          }}
        >
          {sortMode === 'modified' ? t('sort.modified') : sortMode === 'created' ? t('sort.created') : sortMode === 'custom' ? t('sort.custom', 'Custom') : t('sort.title')} {sortMode !== 'custom' && (sortDirection === 'desc' ? '↓' : '↑')}
        </button>
      </div>

      {/* Notes list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && notes.length === 0 ? (
          <div className="flex items-center justify-center h-20 text-xs" style={{ color: 'var(--text-tertiary)' }}>Loading...</div>
        ) : sortedNotes.length === 0 ? (
          <div className="flex items-center justify-center h-20 text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {searchQuery ? t('notesList.noResults') : t('notesList.empty')}
          </div>
        ) : sortMode === 'custom' ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={({ active }) => setDragActiveId(active.id as string)}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setDragActiveId(null)}
          >
            <SortableContext items={sortedNotes.map((n) => n.id)} strategy={verticalListSortingStrategy}>
              {sortedNotes.map((note) => (
                <SortableNoteItem
                  key={note.id}
                  note={note}
                  isActive={activeNote?.id === note.id}
                  showFolder={activeFolder === null}
                  isRenaming={renamingId === note.id}
                  renameValue={renameValue}
                  onRenameValueChange={setRenameValue}
                  onRenameSubmit={() => handleRenameSubmit(note)}
                  onRenameCancel={() => setRenamingId(null)}
                  onSelect={() => selectNote(note)}
                  onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, note }); }}
                  formatDate={formatNoteDate}
                />
              ))}
            </SortableContext>
            <DragOverlay>
              {dragActiveId ? (
                <DragOverlayNoteItem
                  note={sortedNotes.find((n) => n.id === dragActiveId)!}
                  formatDate={formatNoteDate}
                />
              ) : null}
            </DragOverlay>
          </DndContext>
        ) : (
          sortedNotes.map((note) => (
            <div
              key={note.id}
              className="cursor-pointer transition-colors"
              style={{
                minHeight: '52px',
                padding: '8px 12px',
                borderRadius: '6px',
                backgroundColor: activeNote?.id === note.id ? 'var(--accent-light)' : 'transparent',
              }}
              onClick={() => selectNote(note)}
              onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, note }); }}
              onMouseEnter={(e) => { if (activeNote?.id !== note.id) e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'; }}
              onMouseLeave={(e) => { if (activeNote?.id !== note.id) e.currentTarget.style.backgroundColor = 'transparent'; }}
            >
              <div className="flex items-center gap-1">
                {note.pinned && <span className="text-[10px]" style={{ color: 'var(--pin-color)' }}>&#9733;</span>}
                {note.is_encrypted && <span style={{ color: 'var(--text-tertiary)', opacity: 0.7 }}><IconLockSmall /></span>}
                {renamingId === note.id ? (
                  <input
                    autoFocus value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => handleRenameSubmit(note)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleRenameSubmit(note); if (e.key === 'Escape') setRenamingId(null); }}
                    className="flex-1 px-1 py-0 text-xs font-medium rounded outline-none"
                    style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--accent)' }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {note.title}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{formatNoteDate(note.modified_at)}</span>
                {activeFolder === null && note.folder && <span className="text-[11px] truncate" style={{ color: 'var(--text-tertiary)' }}>{note.folder}</span>}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="fixed z-[9999] border rounded-lg shadow-lg py-1 min-w-[130px] dialog-content"
          style={{ left: contextMenu.x, top: contextMenu.y, backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border)' }}
        >
          <button onClick={handlePin} className="w-full text-left px-3 py-1 text-xs transition-colors"
            style={{ color: 'var(--text-primary)' }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
            {contextMenu.note.pinned ? t('contextMenu.unpin') : t('contextMenu.pin')}
          </button>
          <button onClick={handleStartRename} className="w-full text-left px-3 py-1 text-xs transition-colors"
            style={{ color: 'var(--text-primary)' }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
            {t('contextMenu.rename')}
          </button>
          <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
          {contextMenu.note.is_encrypted ? (
            <button onClick={handleRemoveEncryption} className="w-full text-left px-3 py-1 text-xs transition-colors"
              style={{ color: 'var(--text-primary)' }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
              {t('encryption.removeEncryption')}
            </button>
          ) : (
            <button onClick={handleEncryptNote} className="w-full text-left px-3 py-1 text-xs transition-colors"
              style={{ color: 'var(--text-primary)' }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
              {t('encryption.encrypt')}
            </button>
          )}
          <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
          <button onClick={handleDelete} className="w-full text-left px-3 py-1 text-xs transition-colors"
            style={{ color: 'var(--danger-color)' }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
            {t('contextMenu.delete')}
          </button>
        </div>
      )}

      {/* Encryption Dialog */}
      {encryptionDialog && (
        <EncryptionDialog
          mode={encryptionDialog.mode}
          notePath={encryptionDialog.notePath}
          visible={encryptionDialog.visible}
          onClose={() => setEncryptionDialog(null)}
          onUnlocked={(content, password) => {
            onNoteUnlocked(content, password);
          }}
          onEncrypted={() => refreshNotes(config.storage_path)}
          onRemoved={() => refreshNotes(config.storage_path)}
        />
      )}
    </div>
  );
}
