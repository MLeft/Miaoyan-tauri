import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNotesStore } from '../../stores/notes-store';
import { parseMarkdown } from '../../services/tauri-bridge';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';

interface Props {
  onClose: () => void;
  showToast: (message: string) => void;
}

export function ExportMenu({ onClose, showToast }: Props) {
  const { t } = useTranslation();
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

  const getExportFilename = (title: string, ext: string) => {
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}-${String(now.getSeconds()).padStart(2,'0')}`;
    return `${title}_${ts}.${ext}`;
  };

  const exportHtml = async () => {
    if (!activeNote || !activeContent) return;
    try {
      const html = await parseMarkdown(activeContent);
      const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="initial-scale=1.0" />
  <meta name="color-scheme" content="light dark" />
  <style>
    :root { --bg-color: #FFFFFF; --text-color: #262626; --code-bg: #f7f7f7; --diagram-bg: #f7f7f7; }
    @media (prefers-color-scheme: dark) {
      :root { --bg-color: #23282D; --text-color: #E7E9EA; --code-bg: #282e33; --diagram-bg: #282e33; }
    }
    html, body { background: var(--bg-color); color: var(--text-color); margin: 0; padding: 0; }
    img { max-width: 100%; height: auto; image-rendering: auto; color-scheme: only light; }
  </style>
  <base href="https://cdn.miaoyan.app/Resources/DownView.bundle/">
  <link rel="stylesheet" href="css/typography.css" />
  <link rel="stylesheet" href="css/katex.min.css" />
  <link rel="stylesheet" href="css/tocbot.css" />
  <link rel="stylesheet" href="css/theme-light.css" />
  <link rel="stylesheet" href="css/theme-dark.css" />
  <link rel="stylesheet" href="css/base.css" />
  <link rel="stylesheet" href="css/diagrams.css" />
  <script defer src="js/highlight.min.js"></script>
  <script defer src="js/mermaid.min.js"></script>
  <script defer src="js/plantuml-encoder.min.js"></script>
  <script defer src="js/katex.min.js"></script>
  <script defer src="js/auto-render.min.js"></script>
  <script defer src="js/emoji.min.js"></script>
  <script defer src="js/d3.min.js"></script>
  <script>this.markmap = this.markmap || {}; this.markmap.autoLoader = { manual: true };</script>
  <script defer src="js/markmap.min.js"></script>
  <script defer src="js/markmap-view.min.js"></script>
  <script defer src="js/lightense.min.js"></script>
  <script defer src="js/tocbot.min.js"></script>
  <script defer src="js/theme-config.js"></script>
  <script defer src="js/common.js"></script>
  <script defer src="js/theme-manager.js"></script>
  <script defer src="js/diagram-handler.js"></script>
  <script defer src="js/app.js"></script>
  <title>${activeNote.title}</title>
  <style>
    @font-face {
      font-family: 'TsangerJinKai02-W04';
      font-display: fallback;
      src: url('https://cdn.miaoyan.app/Resources/Fonts/TsangerJinKai02-W04.ttf') format('truetype');
    }
    html { font-size: 16px; padding-top: 24px; }
    :root { --text-font: "TsangerJinKai02-W04", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif; --code-text-font: "Menlo", SFMono-Regular, Menlo, Consolas, "Liberation Mono", "Courier New", monospace; }
    #write { max-width: 760px; margin: 0 auto; }
  </style>
</head>
<body>
  <div class="markdown-body heti" id="write">
    <h1>${activeNote.title}</h1>
    ${html}
  </div>
  <script>
    document.addEventListener('DOMContentLoaded', function() {
      if (window.MiaoYanCommon) {
        MiaoYanCommon.initializeCore();
        MiaoYanCommon.onDOMReady(function() {
          MiaoYanCommon.setupHeaderAnchors();
          MiaoYanCommon.optimizeImages();
          MiaoYanCommon.setupImageZoom();
          if (window.DiagramHandler) {
            DiagramHandler.initializeAll();
          }
          if (window.renderMathInElement) {
            var renderMath = function() {
              renderMathInElement(document.body, {
                delimiters: [
                  { left: "$$", right: "$$", display: true },
                  { left: "$", right: "$", display: false }
                ],
                processEscapes: true
              });
            };
            if ('requestIdleCallback' in window) {
              requestIdleCallback(renderMath, { timeout: 200 });
            } else {
              setTimeout(renderMath, 0);
            }
          }
        });
      }
    });
  </script>
</body>
</html>`;

      const path = await save({
        filters: [{ name: 'HTML', extensions: ['html'] }],
        defaultPath: getExportFilename(activeNote.title, 'html'),
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
        defaultPath: getExportFilename(activeNote.title, 'md'),
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
      className="absolute right-4 top-12 rounded-lg px-1 py-1 z-50 min-w-40 dialog-content"
      style={{
        backgroundColor: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-md)',
      }}
    >
      <button
        onClick={exportHtml}
        className="w-full text-left text-sm rounded-md btn-hover-transition"
        style={{ color: 'var(--text-primary)', padding: '6px 20px' }}
        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
      >
        {t('export.html')}
      </button>
      <button
        onClick={exportMarkdown}
        className="w-full text-left text-sm rounded-md btn-hover-transition"
        style={{ color: 'var(--text-primary)', padding: '6px 20px' }}
        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'}
        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
      >
        {t('export.markdown')}
      </button>
    </div>
  );
}
