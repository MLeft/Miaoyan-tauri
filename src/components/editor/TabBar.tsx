import { useCallback, useEffect, useRef, useState } from 'react';
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

interface ContextMenu {
  visible: boolean;
  x: number;
  y: number;
  tabPath: string;
}

function Tab({ tab, isActive, onSwitch, onClose, onContextMenu }: {
  tab: OpenTab;
  isActive: boolean;
  onSwitch: () => void;
  onClose: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
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
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      onContextMenu={onContextMenu}
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

function TabContextMenu({ menu, onClose, onAction }: {
  menu: ContextMenu;
  onClose: () => void;
  onAction: (action: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu.visible) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menu.visible, onClose]);

  if (!menu.visible) return null;

  const items = [
    { key: 'close', label: '关闭当前文件' },
    { key: 'closeOthers', label: '关闭其他文件' },
    { key: 'closeLeft', label: '关闭左侧文件' },
    { key: 'closeRight', label: '关闭右侧文件' },
    { key: 'divider', label: '' },
    { key: 'closeAll', label: '关闭全部文件' },
  ];

  return (
    <div
      ref={ref}
      className="fixed z-[9999] py-1 rounded-lg px-1 min-w-[160px]"
      style={{
        left: menu.x,
        top: menu.y,
        backgroundColor: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
      }}
    >
      {items.map((item) =>
        item.key === 'divider' ? (
          <div key="divider" className="my-1" style={{ borderTop: '1px solid var(--border)' }} />
        ) : (
          <div
            key={item.key}
            className="text-xs rounded-md cursor-pointer"
            style={{ padding: '5px 12px', color: 'var(--text-primary)' }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--bg-tertiary)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent';
            }}
            onClick={() => onAction(item.key)}
          >
            {item.label}
          </div>
        )
      )}
    </div>
  );
}

export function TabBar() {
  const { openTabs, activeTabPath, switchTab, closeTab, closeAllTabs, closeOtherTabs, closeLeftTabs, closeRightTabs } = useNotesStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu>({ visible: false, x: 0, y: 0, tabPath: '' });

  const handleSwitch = useCallback((path: string) => {
    switchTab(path);
  }, [switchTab]);

  const handleClose = useCallback((path: string) => {
    closeTab(path);
  }, [closeTab]);

  const handleContextMenu = useCallback((e: React.MouseEvent, tabPath: string) => {
    e.preventDefault();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, tabPath });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(prev => ({ ...prev, visible: false }));
  }, []);

  const handleMenuAction = useCallback((action: string) => {
    const path = contextMenu.tabPath;
    switch (action) {
      case 'close': closeTab(path); break;
      case 'closeOthers': closeOtherTabs(path); break;
      case 'closeLeft': closeLeftTabs(path); break;
      case 'closeRight': closeRightTabs(path); break;
      case 'closeAll': closeAllTabs(); break;
    }
    closeContextMenu();
  }, [contextMenu.tabPath, closeTab, closeOtherTabs, closeLeftTabs, closeRightTabs, closeAllTabs, closeContextMenu]);

  if (openTabs.length === 0) return null;

  return (
    <>
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
            onContextMenu={(e) => handleContextMenu(e, tab.path)}
          />
        ))}
      </div>
      <TabContextMenu
        menu={contextMenu}
        onClose={closeContextMenu}
        onAction={handleMenuAction}
      />
    </>
  );
}
