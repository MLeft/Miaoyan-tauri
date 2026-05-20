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
      <div className="absolute right-0 top-0 w-64 h-full bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 p-4 shadow-lg z-10">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-semibold text-gray-500 uppercase">Contents</span>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-sm">&times;</button>
        </div>
        <p className="text-sm text-gray-400">No headings found</p>
      </div>
    );
  }

  const minLevel = Math.min(...headings.map(h => h.level));

  return (
    <div className="absolute right-0 top-0 w-64 h-full bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 shadow-lg z-10 flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <span className="text-xs font-semibold text-gray-500 uppercase">Contents</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-sm">&times;</button>
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {headings.map((heading, i) => (
          <button
            key={i}
            onClick={() => onNavigate(heading.line)}
            className="w-full text-left px-4 py-1 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 truncate transition-colors text-gray-700 dark:text-gray-300"
            style={{ paddingLeft: `${(heading.level - minLevel) * 16 + 16}px` }}
            title={heading.text}
          >
            {heading.text}
          </button>
        ))}
      </div>
    </div>
  );
}
