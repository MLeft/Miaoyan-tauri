import { useState, useRef, useEffect } from 'react';
import { useNotesStore } from '../../stores/notes-store';
import { parseMarkdown } from '../../services/tauri-bridge';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';

interface Props {
  onClose: () => void;
}

export function ExportMenu({ onClose }: Props) {
  const { activeNote, activeContent } = useNotesStore();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const exportHtml = async () => {
    if (!activeNote || !activeContent) return;
    try {
      const html = await parseMarkdown(activeContent);
      const fullHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${activeNote.title}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 800px; margin: 0 auto; padding: 40px 20px; line-height: 1.7; color: #1a1a1a; }
h1, h2, h3, h4, h5, h6 { margin-top: 24px; margin-bottom: 16px; font-weight: 600; }
h1 { font-size: 2em; border-bottom: 1px solid #e1e4e8; padding-bottom: 0.3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid #e1e4e8; padding-bottom: 0.3em; }
code { background: #f6f8fa; border-radius: 4px; padding: 0.2em 0.4em; font-size: 0.85em; }
pre { background: #f6f8fa; border-radius: 6px; padding: 16px; overflow-x: auto; }
pre code { background: transparent; padding: 0; }
blockquote { border-left: 4px solid #e1e4e8; padding: 0 16px; color: #656d76; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #e1e4e8; padding: 8px 12px; }
th { background: #f6f8fa; }
img { max-width: 100%; }
</style>
</head>
<body>${html}</body>
</html>`;

      const path = await save({
        filters: [{ name: 'HTML', extensions: ['html'] }],
        defaultPath: `${activeNote.title}.html`,
      });
      if (path) {
        await writeTextFile(path, fullHtml);
      }
    } catch (e) {
      console.error('Export HTML failed:', e);
    }
    onClose();
  };

  const exportMarkdown = async () => {
    if (!activeNote || !activeContent) return;
    try {
      const path = await save({
        filters: [{ name: 'Markdown', extensions: ['md'] }],
        defaultPath: `${activeNote.title}.md`,
      });
      if (path) {
        await writeTextFile(path, activeContent);
      }
    } catch (e) {
      console.error('Export Markdown failed:', e);
    }
    onClose();
  };

  return (
    <div
      ref={menuRef}
      className="absolute right-4 top-12 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-50 min-w-36"
    >
      <button
        onClick={exportHtml}
        className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300"
      >
        Export as HTML
      </button>
      <button
        onClick={exportMarkdown}
        className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300"
      >
        Export as Markdown
      </button>
    </div>
  );
}
