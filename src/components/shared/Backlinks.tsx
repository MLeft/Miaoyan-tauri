import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { getBacklinks, type BacklinkItem } from '../../services/tauri-bridge';

interface BacklinksProps {
  noteTitle: string;
  rootPath: string;
  onNavigate: (path: string) => void;
  visible: boolean;
}

export function Backlinks({ noteTitle, rootPath, onNavigate, visible }: BacklinksProps) {
  const { t } = useTranslation();
  const [backlinks, setBacklinks] = useState<BacklinkItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const fetchBacklinks = useCallback(async () => {
    if (!noteTitle || !rootPath) {
      setBacklinks([]);
      return;
    }
    setLoading(true);
    try {
      const results = await getBacklinks(rootPath, noteTitle);
      setBacklinks(results);
    } catch (e) {
      console.error('Failed to fetch backlinks:', e);
      setBacklinks([]);
    } finally {
      setLoading(false);
    }
  }, [noteTitle, rootPath]);

  useEffect(() => {
    fetchBacklinks();
  }, [fetchBacklinks]);

  if (!visible) {
    return null;
  }

  const handleToggle = () => {
    setExpanded((prev) => !prev);
  };

  const handleItemClick = (path: string) => {
    onNavigate(path);
  };

  const highlightContext = (context: string, target: string) => {
    const re = new RegExp(`(\\[\\[${escapeRegExp(target)}(?:\\|[^\\]]*)?\\]\\])`, 'gi');
    const parts = context.split(re);
    return parts.map((part, i) => {
      if (part.toLowerCase().startsWith(`[[${target.toLowerCase()}`)) {
        return (
          <span key={i} style={{ color: 'var(--accent)', fontWeight: 500 }}>
            {part}
          </span>
        );
      }
      return <span key={i}>{part}</span>;
    });
  };

  return (
    <div
      className="shrink-0 select-none"
      style={{
        borderTop: '1px solid var(--border)',
        backgroundColor: 'var(--bg-secondary)',
        maxHeight: expanded ? '280px' : 'auto',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <button
        onClick={handleToggle}
        className="w-full flex items-center justify-between px-4 py-2 text-sm"
        style={{ color: 'var(--text-secondary)' }}
        title={expanded ? t('backlinks.collapse') || 'Collapse' : t('backlinks.expand') || 'Expand'}
      >
        <span className="flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 14L4 9l5-5" />
            <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" />
          </svg>
          <span style={{ fontWeight: 500 }}>
            {t('backlinks.title')} ({backlinks.length})
          </span>
        </span>
        <span
          className="transition-transform duration-200"
          style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>

      {expanded && (
        <div
          className="overflow-y-auto"
          style={{
            maxHeight: '240px',
            borderTop: '1px solid var(--border)',
          }}
        >
          {loading ? (
            <div className="px-4 py-3 text-sm" style={{ color: 'var(--text-tertiary)' }}>
              Loading...
            </div>
          ) : backlinks.length === 0 ? (
            <div className="px-4 py-3 text-sm" style={{ color: 'var(--text-tertiary)' }}>
              {t('backlinks.empty')}
            </div>
          ) : (
            <ul className="py-1">
              {backlinks.map((item, index) => (
                <li key={index}>
                  <button
                    onClick={() => handleItemClick(item.path)}
                    className="w-full text-left px-4 py-2 transition-colors"
                    style={{
                      color: 'var(--text-primary)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                  >
                    <div className="text-sm font-medium mb-0.5" style={{ color: 'var(--text-primary)' }}>
                      {item.title}
                    </div>
                    <div className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>
                      {highlightContext(item.context, noteTitle)}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
