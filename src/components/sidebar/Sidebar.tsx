import { useEffect, useCallback, useRef, useState } from 'react';
import type { Project } from '../../types';
import { useNotesStore } from '../../stores/notes-store';
import { useSettingsStore } from '../../stores/settings-store';
import { createFolder } from '../../services/tauri-bridge';
import { useTranslation } from 'react-i18next';

/* SVG icons for sidebar */
const IconHome = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <polyline points="9 22 9 12 15 12 15 22" />
  </svg>
);

const IconFolder = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
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

export function Sidebar() {
  const { t } = useTranslation();
  const { projects, activeFolder, setActiveFolder, loadProjects } = useNotesStore();
  const { config } = useSettingsStore();
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const handleSelectFolder = (path: string | null) => {
    setActiveFolder(path, config.storage_path);
  };

  const handleCreateFolder = async () => {
    const name = prompt(t('sidebar.newFolder'));
    if (!name) return;
    const parent = activeFolder || config.storage_path;
    try {
      await createFolder(parent, name);
      await loadProjects(config.storage_path);
    } catch (e) {
      console.error('Failed to create folder:', e);
    }
  };

  const renderProject = (project: Project, depth = 0) => {
    const isExpanded = expandedFolders.has(project.path);
    const isActive = activeFolder === project.path;

    return (
      <div key={project.path}>
        <div
          className={`flex items-center gap-1.5 px-2 py-1 cursor-pointer rounded text-sm transition-colors
            ${isActive
              ? 'text-[var(--accent-icon)]'
              : 'text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'}
          `}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => handleSelectFolder(project.path)}
        >
          {project.children.length > 0 ? (
            <span
              className="w-4 h-4 flex items-center justify-center opacity-50 flex-shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                toggleFolder(project.path);
              }}
            >
              {isExpanded ? <IconChevronDown /> : <IconChevronRight />}
            </span>
          ) : (
            <span className="w-4 flex-shrink-0" />
          )}
          <span className="flex-shrink-0 opacity-60"><IconFolder /></span>
          <span className="truncate">{project.name}</span>
        </div>
        {isExpanded && project.children.map((child) => renderProject(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col border-r border-[var(--border)]" style={{ backgroundColor: 'var(--bg-sidebar)' }}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
        <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
          {t('sidebar.folders')}
        </span>
        <button
          onClick={handleCreateFolder}
          className="p-0.5 rounded transition-colors hover:bg-[var(--bg-tertiary)]"
          style={{ color: 'var(--text-tertiary)' }}
          title={t('sidebar.newFolder')}
        >
          <IconPlus />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        <div
          className={`flex items-center gap-1.5 px-3 py-2 cursor-pointer rounded mx-1 text-sm transition-colors
            ${activeFolder === null
              ? 'text-[var(--accent-icon)]'
              : 'text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'}
          `}
          onClick={() => handleSelectFolder(null)}
        >
          <span className="flex-shrink-0"><IconHome /></span>
          <span>{t('sidebar.allNotes')}</span>
        </div>
        {projects.map((project) => renderProject(project))}
      </div>
    </div>
  );
}
