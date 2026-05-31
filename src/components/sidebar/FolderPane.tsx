import { useState, useCallback, useEffect } from 'react';
import type { Project } from '../../types';
import { useNotesStore } from '../../stores/notes-store';
import { useSettingsStore } from '../../stores/settings-store';
import { createFolder, moveNote, renameFolder, deleteFolder, revealInFinder, openInTerminal } from '../../services/tauri-bridge';
import { useTranslation } from 'react-i18next';

/* SVG icons */
const IconHome = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
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
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    <line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" />
  </svg>
);

/* Context menu SVG icons */
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
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
);

const IconTerminal = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
);

const IconTrash = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

export function FolderPane() {
  const { t } = useTranslation();
  const {
    projects,
    activeFolder,
    setActiveFolder,
    loadProjects,
    refreshNotes,
    notes,
  } = useNotesStore();
  const { config, updateConfig } = useSettingsStore();
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; project: Project } | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  /* Close context menu on outside click */
  useEffect(() => {
    const handler = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener('click', handler);
      return () => document.removeEventListener('click', handler);
    }
  }, [contextMenu]);

  const toggleFolderExpand = useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }, []);

  const handleSelectFolder = useCallback((path: string | null) => {
    setActiveFolder(path, config.storage_path);
  }, [setActiveFolder, config.storage_path]);

  const handleCreateFolder = useCallback(async () => {
    const name = prompt(t('sidebar.newFolder'));
    if (!name) return;
    const parent = activeFolder || config.storage_path;
    try {
      await createFolder(parent, name);
      await loadProjects(config.storage_path);
    } catch (e) {
      console.error('Failed to create folder:', e);
    }
  }, [activeFolder, config.storage_path, loadProjects, t]);

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
            height: '28px',
            color: isActive ? 'var(--accent-icon)' : 'var(--text-secondary)',
            backgroundColor: isActive ? 'var(--accent-light)' : 'transparent',
          }}
          onClick={() => handleSelectFolder(project.path)}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!isActive) e.currentTarget.style.backgroundColor = 'var(--accent-light)';
          }}
          onDragLeave={(e) => {
            if (!isActive) e.currentTarget.style.backgroundColor = 'transparent';
          }}
          onDrop={async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const notePath = e.dataTransfer.getData('application/note-path');
            if (notePath) {
              try {
                await moveNote(notePath, project.path);
                await refreshNotes(config.storage_path);
                await loadProjects(config.storage_path);
              } catch (err) {
                console.error('Failed to move note:', err);
              }
            }
            e.currentTarget.style.backgroundColor = isActive ? 'var(--accent-light)' : 'transparent';
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setContextMenu({ x: e.clientX, y: e.clientY, project });
          }}
          onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'; }}
          onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = 'transparent'; }}
        >
          {project.children.length > 0 ? (
            <span
              className="w-3 h-3 flex items-center justify-center flex-shrink-0 opacity-50"
              onClick={(e) => { e.stopPropagation(); toggleFolderExpand(project.path); }}
            >
              {isExpanded ? <IconChevronDown /> : <IconChevronRight />}
            </span>
          ) : <span className="w-3 flex-shrink-0" />}
          <span className="flex-shrink-0 opacity-60"><IconFolder /></span>
          {renamingPath === project.path ? (
            <input
              className="truncate outline-none"
              style={{
                background: 'var(--bg-tertiary)',
                color: 'var(--text-primary)',
                border: '1px solid var(--accent-icon)',
                borderRadius: '3px',
                padding: '0 4px',
                fontSize: 'inherit',
                lineHeight: 'inherit',
                width: '0',
                minWidth: '60px',
                flex: '1 1 auto',
              }}
              value={renameValue}
              autoFocus
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={async () => {
                if (renameValue.trim() && renameValue.trim() !== project.name) {
                  try {
                    await renameFolder(project.path, renameValue.trim());
                    await loadProjects(config.storage_path);
                  } catch (err) {
                    console.error('Failed to rename folder:', err);
                  }
                }
                setRenamingPath(null);
              }}
              onKeyDown={async (e) => {
                if (e.key === 'Enter') {
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === 'Escape') {
                  setRenamingPath(null);
                }
              }}
            />
          ) : (
            <span className="truncate">{project.name}</span>
          )}
          {config.extra_folders.includes(project.path) && (
            <button
              className="flex-shrink-0 opacity-40 hover:opacity-100 transition-opacity"
              style={{ marginLeft: 'auto', padding: '0 2px' }}
              onClick={(e) => {
                e.stopPropagation();
                const newFolders = config.extra_folders.filter(f => f !== project.path);
                useSettingsStore.getState().updateConfig({ extra_folders: newFolders });
                loadProjects(config.storage_path);
                refreshNotes(config.storage_path);
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
        {isExpanded && project.children.map((child) => renderProject(child, depth + 1))}
      </div>
    );
  };

  return (
    <div
      className="h-full flex flex-col border-r sidebar-transition"
      style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border)' }}
    >
      {/* Folder tree scroll area */}
      <div className="flex-1 overflow-y-auto">
        {/* All Notes entry */}
        <div
          className="flex items-center cursor-pointer text-[16px] transition-colors"
          style={{
            height: '28px',
            paddingLeft: '10px',
            paddingRight: '10px',
            color: activeFolder === null ? 'var(--accent-icon)' : 'var(--text-secondary)',
            backgroundColor: activeFolder === null ? 'var(--accent-light)' : 'transparent',
          }}
          onClick={() => handleSelectFolder(null)}
          onMouseEnter={(e) => { if (activeFolder !== null) e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'; }}
          onMouseLeave={(e) => { if (activeFolder !== null) e.currentTarget.style.backgroundColor = 'transparent'; }}
        >
          <span className="flex-shrink-0" style={{ marginRight: '6px' }}><IconHome /></span>
          <span>{t('sidebar.allNotes')}</span>
          <span className="text-[10px]" style={{ color: 'var(--text-tertiary)', marginLeft: '4px' }}>{notes.length}</span>
          <button
            onClick={(e) => { e.stopPropagation(); handleCreateFolder(); }}
            className="flex-shrink-0 rounded transition-colors"
            style={{ color: 'var(--text-tertiary)', marginLeft: 'auto' }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            title={t('sidebar.newFolder')}
          >
            <IconPlus />
          </button>
        </div>

        {/* Project tree */}
        {projects.map((project) => renderProject(project))}
      </div>

      {/* Context menu overlay */}
      {contextMenu && (
        <div
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 1000,
            backgroundColor: 'var(--bg-primary)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
            padding: '4px 0',
            minWidth: '180px',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* New Subfolder */}
          <div
            className="flex items-center gap-2 cursor-pointer text-xs"
            style={{
              padding: '6px 12px',
              color: 'var(--text-primary)',
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            onClick={async () => {
              const name = prompt(t('sidebar.newFolder'));
              if (!name) return;
              try {
                await createFolder(contextMenu.project.path, name);
                await loadProjects(config.storage_path);
              } catch (e) {
                console.error('Failed to create subfolder:', e);
              }
              setContextMenu(null);
            }}
          >
            <span style={{ opacity: 0.6 }}><IconFolderPlus /></span>
            <span>{t('folderMenu.newSubfolder')}</span>
          </div>

          {/* Rename */}
          <div
            className="flex items-center gap-2 cursor-pointer text-xs"
            style={{
              padding: '6px 12px',
              color: 'var(--text-primary)',
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            onClick={() => {
              setRenamingPath(contextMenu.project.path);
              setRenameValue(contextMenu.project.name);
              setContextMenu(null);
            }}
          >
            <span style={{ opacity: 0.6 }}><IconEdit /></span>
            <span>{t('folderMenu.rename')}</span>
          </div>

          {/* Reveal in Finder */}
          <div
            className="flex items-center gap-2 cursor-pointer text-xs"
            style={{
              padding: '6px 12px',
              color: 'var(--text-primary)',
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            onClick={async () => {
              try {
                await revealInFinder(contextMenu.project.path);
              } catch (e) {
                console.error('Failed to reveal in Finder:', e);
              }
              setContextMenu(null);
            }}
          >
            <span style={{ opacity: 0.6 }}><IconFinder /></span>
            <span>{t('folderMenu.revealInFinder')}</span>
          </div>

          {/* Open in Terminal */}
          <div
            className="flex items-center gap-2 cursor-pointer text-xs"
            style={{
              padding: '6px 12px',
              color: 'var(--text-primary)',
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            onClick={async () => {
              try {
                await openInTerminal(contextMenu.project.path);
              } catch (e) {
                console.error('Failed to open in Terminal:', e);
              }
              setContextMenu(null);
            }}
          >
            <span style={{ opacity: 0.6 }}><IconTerminal /></span>
            <span>{t('folderMenu.openInTerminal')}</span>
          </div>

          {/* Delete */}
          <div
            className="flex items-center gap-2 cursor-pointer text-xs"
            style={{
              padding: '6px 12px',
              color: '#e55',
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            onClick={async () => {
              try {
                await deleteFolder(contextMenu.project.path);
                await loadProjects(config.storage_path);
                await refreshNotes(config.storage_path);
              } catch (e) {
                console.error('Failed to delete folder:', e);
              }
              setContextMenu(null);
            }}
          >
            <span style={{ opacity: 0.8 }}><IconTrash /></span>
            <span>{t('folderMenu.delete')}</span>
          </div>
        </div>
      )}
    </div>
  );
}
