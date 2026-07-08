import { useCallback, useRef, useState } from 'react';
import { useNotesStore } from '../../stores/notes-store';
import type { OpenTab } from '../../stores/notes-store';

const IconClose = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 8.707l3.646 3.647.708-.708L8.707 8l3.647-3.646-.708-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708L8 8.707z" />
  </svg>
);

const IconModified = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <circle cx="8" cy="8" r="3" />
  </svg>
);

function Tab({ tab, isActive, onSwitch, onClose }: {
  tab: OpenTab;
  isActive: boolean;
  onSwitch: () => void;
  onClose: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="group flex items-center gap-1.5 px-3 h-[35px] cursor-pointer select-none flex-shrink-0"
      style={{
        backgroundColor: isActive ? 'var(--bg-primary)' : 'transparent',
        color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
        borderRight: '1px solid var(--border)',
        maxWidth: '200px',
      }}
      onClick={onSwitch}
      onMouseDown={(e) => {
        // Middle click to close
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Title */}
      <span className="truncate text-[13px] leading-tight" style={{ textIndent: '5px' }}>
        {tab.note.title}
      </span>

      {/* Close / dirty indicator */}
      <button
        className="flex-shrink-0 rounded flex items-center justify-center"
        style={{
          width: '18px',
          height: '18px',
          color: tab.isDirty ? 'var(--accent-icon)' : 'var(--text-tertiary)',
          backgroundColor: hovered && !tab.isDirty ? 'var(--bg-tertiary)' : 'transparent',
          opacity: (isActive || hovered || tab.isDirty) ? 1 : 0,
        }}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title="Close"
      >
        {tab.isDirty ? <IconModified /> : <IconClose />}
      </button>
    </div>
  );
}

export function TabBar() {
  const { openTabs, activeTabPath, switchTab, closeTab } = useNotesStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleSwitch = useCallback((path: string) => {
    switchTab(path);
  }, [switchTab]);

  const handleClose = useCallback((path: string) => {
    closeTab(path);
  }, [closeTab]);

  if (openTabs.length === 0) return null;

  return (
    <div
      ref={scrollRef}
      className="flex overflow-x-auto flex-shrink-0 pl-2"
      style={{
        height: '35px',
        backgroundColor: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      {openTabs.map((tab) => (
        <Tab
          key={tab.path}
          tab={tab}
          isActive={tab.path === activeTabPath}
          onSwitch={() => handleSwitch(tab.path)}
          onClose={() => handleClose(tab.path)}
        />
      ))}
    </div>
  );
}
