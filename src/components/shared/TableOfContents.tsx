import { useMemo } from 'react';
import { useNotesStore } from '../../stores/notes-store';

interface TocItem {
  level: number;
  text: string;
  line: number;
}

interface Props {
  onNavigate: (line: number) => void;
  onClose: () => void;
}

export function TableOfContents({ onNavigate, onClose }: Props) {
  const { activeContent } = useNotesStore();

  const headings = useMemo(() => {
    if (!activeContent) return [];
    const lines = activeContent.split('\n');
    const items: TocItem[] = [];
    let inCodeBlock = false;

    lines.forEach((line, index) => {
      if (line.startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        return;
      }
      if (inCodeBlock) return;

      const match = line.match(/^(#{1,6})\s+(.+)$/);
      if (match) {
        items.push({
          level: match[1].length,
          text: match[2].replace(/[#*_`\[\]]/g, '').trim(),
          line: index + 1,
        });
      }
    });
    return items;
  }, [activeContent]);

  if (headings.length === 0) {
    return (
      <div
        className="absolute right-0 top-0 w-64 h-full p-4 z-10"
        style={{
          backgroundColor: 'var(--bg-secondary)',
          borderLeft: '1px solid var(--border)',
          boxShadow: 'var(--shadow-md)',
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-semibold uppercase" style={{ color: 'var(--text-tertiary)' }}>Contents</span>
          <button onClick={onClose} className="text-sm btn-hover-transition" style={{ color: 'var(--text-tertiary)' }}>&times;</button>
        </div>
        <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>No headings found</p>
      </div>
    );
  }

  const minLevel = Math.min(...headings.map(h => h.level));

  return (
    <div
      className="absolute right-0 top-0 w-64 h-full z-10 flex flex-col"
      style={{
        backgroundColor: 'var(--bg-secondary)',
        borderLeft: '1px solid var(--border)',
        boxShadow: 'var(--shadow-md)',
      }}
    >
      <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
        <span className="text-xs font-semibold uppercase" style={{ color: 'var(--text-tertiary)' }}>Contents</span>
        <button onClick={onClose} className="text-sm btn-hover-transition" style={{ color: 'var(--text-tertiary)' }}>&times;</button>
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {headings.map((heading, i) => (
          <button
            key={i}
            onClick={() => onNavigate(heading.line)}
            className="w-full text-left px-4 py-1 text-sm truncate btn-hover-transition"
            style={{
              paddingLeft: `${(heading.level - minLevel) * 16 + 16}px`,
              color: 'var(--text-primary)',
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            title={heading.text}
          >
            {heading.text}
          </button>
        ))}
      </div>
    </div>
  );
}
