import { useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

export interface ContextMenuProps {
  x: number;
  y: number;
  visible: boolean;
  onClose: () => void;
  onAction: (action: string) => void;
}

interface MenuItem {
  action: string;
  shortcut?: string;
  divider?: boolean;
}

const menuItems: MenuItem[] = [
  { action: 'bold', shortcut: '⌘B' },
  { action: 'italic', shortcut: '⌘I' },
  { action: 'strikethrough' },
  { action: 'inlineCode', shortcut: '⌘E' },
  { divider: true, action: '' },
  { action: 'unorderedList', shortcut: '⌘U' },
  { action: 'orderedList', shortcut: '⇧⌘O' },
  { action: 'todo', shortcut: '⌘T' },
  { divider: true, action: '' },
  { action: 'link', shortcut: '⌘K' },
  { action: 'image' },
  { action: 'codeBlock' },
];

export function ContextMenu({ x, y, visible, onClose, onAction }: ContextMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);

  // Adjust position to keep menu within viewport
  const adjustedPos = useCallback(() => {
    const menuWidth = 200;
    const menuHeight = menuItems.length * 28 + 8; // approximate
    let adjustedX = x;
    let adjustedY = y;
    if (typeof window !== 'undefined') {
      if (x + menuWidth > window.innerWidth) {
        adjustedX = window.innerWidth - menuWidth - 8;
      }
      if (y + menuHeight > window.innerHeight) {
        adjustedY = window.innerHeight - menuHeight - 8;
      }
      adjustedX = Math.max(8, adjustedX);
      adjustedY = Math.max(8, adjustedY);
    }
    return { x: adjustedX, y: adjustedY };
  }, [x, y]);

  const pos = adjustedPos();

  useEffect(() => {
    if (!visible) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    // Delay adding mousedown to avoid immediate close from the same click that opened the menu
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [visible, onClose]);

  if (!visible) return null;

  const handleItemClick = (action: string) => {
    onAction(action);
    onClose();
  };

  return (
    <div
      ref={menuRef}
      className="fixed z-[9999] py-1 select-none dialog-content"
      style={{
        left: pos.x,
        top: pos.y,
        width: '200px',
        backgroundColor: 'var(--bg-secondary)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
        fontSize: '13px',
      }}
    >
      {menuItems.map((item, index) => {
        if (item.divider) {
          return (
            <div
              key={`divider-${index}`}
              style={{
                height: '0.5px',
                backgroundColor: 'var(--border)',
                margin: '4px 8px',
              }}
            />
          );
        }

        return (
          <button
            key={item.action}
            className="w-full flex items-center justify-between px-3 text-left transition-colors"
            style={{
              height: '28px',
              color: 'var(--text-primary)',
              backgroundColor: 'transparent',
              border: 'none',
              outline: 'none',
              cursor: 'pointer',
            }}
            onClick={() => handleItemClick(item.action)}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--accent)';
              e.currentTarget.style.color = 'var(--text-inverse)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
              e.currentTarget.style.color = 'var(--text-primary)';
            }}
          >
            <span>{t(`contextMenu.${item.action}`)}</span>
            {item.shortcut && (
              <span
                style={{
                  fontSize: '12px',
                  opacity: 0.6,
                  marginLeft: '8px',
                }}
              >
                {item.shortcut}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
