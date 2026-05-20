import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useNotesStore } from '../../stores/notes-store';
import { useSettingsStore } from '../../stores/settings-store';
import { createNote, deleteNote, renameNote, togglePin } from '../../services/tauri-bridge';
import type { NoteMetadata, SortMode } from '../../types';
import { useTranslation } from 'react-i18next';

export function NotesList() {
  const { t } = useTranslation();
  const {
    notes,
    activeNote,
    selectNote,
    searchQuery,
    setSearchQuery,
    sortMode,
    sortDirection,
    setSortMode,
    toggleSortDirection,
    isLoading,
    refreshNotes,
  } = useNotesStore();
  const { config } = useSettingsStore();
  const searchRef = useRef<HTMLInputElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; note: NoteMetadata } | null>(null);
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const sortMenuRef = useRef<HTMLDivElement>(null);

  const handleSearch = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearchQuery(e.target.value, config.storage_path);
    },
    [config.storage_path, setSearchQuery]
  );

  const handleCreateNote = async () => {
    const folder = useNotesStore.getState().activeFolder || config.storage_path;
    try {
      const note = await createNote(folder, `Untitled-${Date.now()}`);
      await refreshNotes(config.storage_path);
      await selectNote(note);
    } catch (e) {
      console.error('Failed to create note:', e);
    }
  };

  // Sort notes: pinned first, then by sort mode
  const sortedNotes = useMemo(() => {
    const sorted = [...notes].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      let cmp = 0;
      switch (sortMode) {
        case 'modified':
          cmp = new Date(a.modified_at).getTime() - new Date(b.modified_at).getTime();
          break;
        case 'created':
          cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
          break;
        case 'title':
          cmp = a.title.localeCompare(b.title);
          break;
      }
      return sortDirection === 'desc' ? -cmp : cmp;
    });
    return sorted;
  }, [notes, sortMode, sortDirection]);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays === 0) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (diffDays < 7) {
      return `${diffDays}d ago`;
    } else {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
  };

  const handleContextMenu = (e: React.MouseEvent, note: NoteMetadata) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, note });
  };

  const handlePin = async () => {
    if (!contextMenu) return;
    try {
      await togglePin(contextMenu.note.path);
      await refreshNotes(config.storage_path);
    } catch (e) {
      console.error('Failed to toggle pin:', e);
    }
    setContextMenu(null);
  };

  const handleDelete = async () => {
    if (!contextMenu) return;
    try {
      await deleteNote(contextMenu.note.path);
      await refreshNotes(config.storage_path);
    } catch (e) {
      console.error('Failed to delete note:', e);
    }
    setContextMenu(null);
  };

  const handleStartRename = () => {
    if (!contextMenu) return;
    setRenamingId(contextMenu.note.id);
    setRenameValue(contextMenu.note.title);
    setContextMenu(null);
  };

  const handleRenameSubmit = async (note: NoteMetadata) => {
    if (!renameValue.trim() || renameValue === note.title) {
      setRenamingId(null);
      return;
    }
    try {
      await renameNote(note.path, renameValue.trim());
      await refreshNotes(config.storage_path);
    } catch (e) {
      console.error('Failed to rename note:', e);
    }
    setRenamingId(null);
  };

  const handleSortChange = (mode: SortMode) => {
    if (sortMode === mode) {
      toggleSortDirection();
    } else {
      setSortMode(mode);
    }
    setShowSortMenu(false);
  };

  // Close menus on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (contextMenu) setContextMenu(null);
      if (showSortMenu && sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) {
        setShowSortMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [contextMenu, showSortMenu]);

  // Keyboard shortcut: Cmd+N for new note, Cmd+F for search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        handleCreateNote();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const sortLabel = sortMode === 'modified' ? t('sort.modified') : sortMode === 'created' ? t('sort.created') : t('sort.title');
  const sortArrow = sortDirection === 'desc' ? '↓' : '↑';

  return (
    <div className="h-full flex flex-col border-r border-[var(--border)]" style={{ backgroundColor: 'var(--bg-secondary)' }}>
      {/* Search bar */}
      <div className="px-3 py-2 border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          <input
            ref={searchRef}
            type="text"
            value={searchQuery}
            onChange={handleSearch}
            placeholder={t('notesList.search')}
            className="flex-1 px-2 py-1 text-sm rounded outline-none transition-colors"
            style={{
              backgroundColor: 'var(--bg-tertiary)',
              color: 'var(--text-primary)',
            }}
          />
          <button
            onClick={handleCreateNote}
            className="p-1 rounded transition-colors hover:bg-[var(--bg-tertiary)]"
            style={{ color: 'var(--text-tertiary)' }}
            title={t('notesList.newNote')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Sort bar */}
      <div className="px-3 py-1.5 border-b border-[var(--border-light)] flex items-center justify-between relative">
        <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{notes.length} {t('notesList.notes')}</span>
        <div ref={sortMenuRef} className="relative">
          <button
            onClick={() => setShowSortMenu(!showSortMenu)}
            className="text-xs flex items-center gap-0.5 transition-colors"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {sortLabel} {sortArrow}
          </button>
          {showSortMenu && (
            <div className="absolute right-0 top-full mt-1 z-50 border rounded shadow-lg py-1 min-w-[120px]"
              style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border)' }}>
              {(['modified', 'created', 'title'] as SortMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => handleSortChange(mode)}
                  className="w-full text-left px-3 py-1.5 text-xs transition-colors"
                  style={{
                    color: sortMode === mode ? 'var(--accent)' : 'var(--text-primary)',
                    fontWeight: sortMode === mode ? 600 : 400,
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                >
                  {t(`sort.${mode}`)} {sortMode === mode && sortArrow}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Notes list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && notes.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-sm" style={{ color: 'var(--text-tertiary)' }}>
            Loading...
          </div>
        ) : sortedNotes.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-sm" style={{ color: 'var(--text-tertiary)' }}>
            {searchQuery ? t('notesList.noResults') : t('notesList.empty')}
          </div>
        ) : (
          sortedNotes.map((note) => (
            <div
              key={note.id}
              className={`px-3 py-2.5 cursor-pointer border-b transition-colors border-l-2
                ${activeNote?.id === note.id
                  ? 'border-l-[var(--accent)]'
                  : 'border-l-transparent hover:bg-[var(--bg-tertiary)]'}
              `}
              style={{
                backgroundColor: activeNote?.id === note.id ? 'var(--accent-light)' : 'transparent',
                borderColor: activeNote?.id === note.id ? 'var(--accent)' : 'transparent',
                borderBottomColor: 'var(--border-light)',
              }}
              onClick={() => selectNote(note)}
              onContextMenu={(e) => handleContextMenu(e, note)}
            >
              <div className="flex items-center gap-1">
                {note.pinned && <span style={{ color: 'var(--pin-color)' }} className="text-xs">&#9733;</span>}
                {renamingId === note.id ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => handleRenameSubmit(note)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRenameSubmit(note);
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    className="flex-1 px-1 py-0 text-sm font-medium rounded outline-none"
                    style={{
                      backgroundColor: 'var(--bg-primary)',
                      color: 'var(--text-primary)',
                      border: '1px solid var(--accent)',
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {note.title}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{formatDate(note.modified_at)}</span>
                {note.folder && (
                  <span className="text-xs truncate" style={{ color: 'var(--text-tertiary)', opacity: 0.6 }}>
                    {note.folder}
                  </span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="fixed z-[9999] border rounded-lg shadow-lg py-1 min-w-[140px]"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
            backgroundColor: 'var(--bg-secondary)',
            borderColor: 'var(--border)',
          }}
        >
          <button
            onClick={handlePin}
            className="w-full text-left px-3 py-1.5 text-sm transition-colors"
            style={{ color: 'var(--text-primary)' }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
          >
            {contextMenu.note.pinned ? t('contextMenu.unpin') : t('contextMenu.pin')}
          </button>
          <button
            onClick={handleStartRename}
            className="w-full text-left px-3 py-1.5 text-sm transition-colors"
            style={{ color: 'var(--text-primary)' }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
          >
            {t('contextMenu.rename')}
          </button>
          <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
          <button
            onClick={handleDelete}
            className="w-full text-left px-3 py-1.5 text-sm transition-colors"
            style={{ color: '#ef4444' }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
          >
            {t('contextMenu.delete')}
          </button>
        </div>
      )}
    </div>
  );
}
