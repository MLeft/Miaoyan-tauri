import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { NoteMetadata, SortMode } from '../../types';
import { useNotesStore } from '../../stores/notes-store';
import { useSettingsStore } from '../../stores/settings-store';
import { createNote, deleteNote, renameNote, togglePin } from '../../services/tauri-bridge';
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

const IconSearch = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const IconPlus = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" />
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
    minHeight: '44px',
    padding: '6px 10px',
    borderRadius: '0',
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
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/note-path', note.path);
        e.dataTransfer.effectAllowed = 'move';
      }}
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
        minHeight: '44px',
        padding: '6px 10px',
        backgroundColor: 'var(--bg-secondary)',
        borderRadius: '0',
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

export function NoteListPane() {
  const { t } = useTranslation();
  const {
    notes, activeNote, activeFolder,
    selectNote, searchQuery, setSearchQuery,
    sortMode, sortDirection, setSortMode, toggleSortDirection,
    isLoading, refreshNotes,
    customSortOrder, loadCustomSortOrder, applyCustomSortOrder,
    encryptionDialog, setEncryptionDialog, onNoteUnlocked,
  } = useNotesStore();
  const { config } = useSettingsStore();
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

  const handleCreateNote = useCallback(async () => {
    const folder = activeFolder || config.storage_path;
    try {
      const note = await createNote(folder, `Untitled-${Date.now()}`);
      await refreshNotes(config.storage_path);
      await selectNote(note);
    } catch (e) { console.error('Failed to create note:', e); }
  }, [activeFolder, config.storage_path, refreshNotes, selectNote]);

  const handlePin = useCallback(async () => {
    if (!contextMenu) return;
    try { await togglePin(contextMenu.note.path); await refreshNotes(config.storage_path); }
    catch (e) { console.error('Failed to toggle pin:', e); }
    setContextMenu(null);
  }, [contextMenu, refreshNotes, config.storage_path]);

  const handleDelete = useCallback(async () => {
    if (!contextMenu) return;
    try { await deleteNote(contextMenu.note.path); await refreshNotes(config.storage_path); }
    catch (e) { console.error('Failed to delete note:', e); }
    setContextMenu(null);
  }, [contextMenu, refreshNotes, config.storage_path]);

  const handleStartRename = useCallback(() => {
    if (!contextMenu) return;
    setRenamingId(contextMenu.note.id);
    setRenameValue(contextMenu.note.title);
    setContextMenu(null);
  }, [contextMenu]);

  const handleRenameSubmit = useCallback(async (note: NoteMetadata) => {
    if (!renameValue.trim() || renameValue === note.title) { setRenamingId(null); return; }
    try { await renameNote(note.path, renameValue.trim()); await refreshNotes(config.storage_path); }
    catch (e) { console.error('Failed to rename note:', e); }
    setRenamingId(null);
  }, [renameValue, refreshNotes, config.storage_path]);

  const handleEncryptNote = useCallback(() => {
    if (!contextMenu) return;
    setEncryptionDialog({ visible: true, mode: 'encrypt', notePath: contextMenu.note.path });
    setContextMenu(null);
  }, [contextMenu, setEncryptionDialog]);

  const handleRemoveEncryption = useCallback(() => {
    if (!contextMenu) return;
    setEncryptionDialog({ visible: true, mode: 'remove', notePath: contextMenu.note.path });
    setContextMenu(null);
  }, [contextMenu, setEncryptionDialog]);

  const formatNoteDate = useCallback((dateStr: string) => {
    const d = new Date(dateStr);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hour = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${year}/${month}/${day} ${hour}:${min}`;
  }, []);

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

  return (
    <div
      className="h-full flex flex-col border-r sidebar-transition"
      style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border)' }}
    >
      {/* Search + New */}
      <div style={{ padding: '4px' }}>
        <div className="flex items-center gap-1 overflow-hidden">
          <div className="flex-1 min-w-0 flex items-center gap-1.5 px-2 py-2 rounded-md text-[18px]"
            style={{ backgroundColor: 'var(--bg-tertiary)' }}>
            <span style={{ color: 'var(--text-tertiary)' }}><IconSearch /></span>
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value, config.storage_path)}
              placeholder={t('notesList.search')}
              className="flex-1 bg-transparent outline-none text-[18px] h-5"
              style={{ color: 'var(--text-primary)' }}
            />
          </div>
          <button
            onClick={handleCreateNote}
            className="p-1 rounded transition-colors flex-shrink-0"
            style={{ color: 'var(--text-tertiary)' }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            title={t('notesList.newNote')}
          >
            <IconPlus />
          </button>
        </div>
      </div>

      {/* Sort controls */}
      <div className="px-3 py-1 flex items-center justify-between">
        <SyncStatusIndicator compact />
        <button
          className="text-[10px] transition-colors hover:opacity-80"
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
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/note-path', note.path);
                e.dataTransfer.effectAllowed = 'move';
              }}
              style={{
                minHeight: '44px',
                padding: '6px 10px',
                borderRadius: '0',
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
          className="fixed z-[9999] rounded-lg px-1 py-1 min-w-[140px] dialog-content"
          style={{ left: contextMenu.x, top: contextMenu.y, backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-md)' }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button onClick={handlePin} className="w-full text-left text-sm rounded-md btn-hover-transition"
            style={{ color: 'var(--text-primary)', padding: '6px 20px' }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
            {contextMenu.note.pinned ? t('contextMenu.unpin') : t('contextMenu.pin')}
          </button>
          <button onClick={handleStartRename} className="w-full text-left text-sm rounded-md btn-hover-transition"
            style={{ color: 'var(--text-primary)', padding: '6px 20px' }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
            {t('contextMenu.rename')}
          </button>
          <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
          {contextMenu.note.is_encrypted ? (
            <button onClick={handleRemoveEncryption} className="w-full text-left text-sm rounded-md btn-hover-transition"
              style={{ color: 'var(--text-primary)', padding: '6px 20px' }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
              {t('encryption.removeEncryption')}
            </button>
          ) : (
            <button onClick={handleEncryptNote} className="w-full text-left text-sm rounded-md btn-hover-transition"
              style={{ color: 'var(--text-primary)', padding: '6px 20px' }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
              {t('encryption.encrypt')}
            </button>
          )}
          <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
          <button onClick={handleDelete} className="w-full text-left text-sm rounded-md btn-hover-transition"
            style={{ color: 'var(--danger-color)', padding: '6px 20px' }}
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
