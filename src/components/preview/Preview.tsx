import { useEffect, useRef, useState } from 'react';
import { useNotesStore } from '../../stores/notes-store';
import { useEditorStore } from '../../stores/editor-store';
import { useSettingsStore } from '../../stores/settings-store';
import { parseMarkdown } from '../../services/tauri-bridge';

export function Preview() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { activeContent, activeNote } = useNotesStore();
  const { editorScrollLine } = useEditorStore();
  const { config } = useSettingsStore();
  const [renderedHtml, setRenderedHtml] = useState('');
  const [iframeReady, setIframeReady] = useState(false);
  const renderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // RAF throttle for editor→preview scroll sync
  const scrollSyncRafRef = useRef<number | null>(null);

  const isDark = config.theme === 'dark' ||
    (config.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  const handleIframeLoad = () => {
    setIframeReady(true);
  };

  // Parse markdown content -> HTML
  useEffect(() => {
    if (!activeNote) return;
    if (renderTimer.current) clearTimeout(renderTimer.current);
    renderTimer.current = setTimeout(async () => {
      try {
        const html = await parseMarkdown(activeContent);
        setRenderedHtml(html);
      } catch (e) {
        console.error('Failed to parse markdown:', e);
      }
    }, 150);
    return () => { if (renderTimer.current) clearTimeout(renderTimer.current); };
  }, [activeContent, activeNote?.id]);

  // Send HTML content + theme to iframe via postMessage
  useEffect(() => {
    if (!iframeReady || !renderedHtml) return;
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage({
      type: 'setContent',
      html: renderedHtml,
      isDark,
    }, '*');
  }, [renderedHtml, isDark, iframeReady]);

  // Send theme-only update when theme changes without content change
  useEffect(() => {
    if (!iframeReady) return;
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage({
      type: 'applyTheme',
      isDark,
    }, '*');
  }, [isDark, iframeReady]);

  // Scroll to line sync (RAF throttled to avoid flooding iframe)
  useEffect(() => {
    if (!iframeReady) return;
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    if (scrollSyncRafRef.current !== null) cancelAnimationFrame(scrollSyncRafRef.current);
    scrollSyncRafRef.current = requestAnimationFrame(() => {
      scrollSyncRafRef.current = null;
      iframe.contentWindow?.postMessage({
        type: 'scrollToLine',
        line: editorScrollLine,
      }, '*');
    });
  }, [editorScrollLine, iframeReady]);

  // Listen for messages from iframe
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!e.data) return;

      if (e.data.type === 'wikilink-navigate') {
        window.dispatchEvent(new CustomEvent('wikilink-navigate', { detail: { title: e.data.title } }));
      }

      if (e.data.type === 'checkbox-toggle') {
        const index = parseInt(e.data.index, 10);
        if (isNaN(index)) return;
        toggleCheckbox(index);
      }

      // Preview → Editor scroll sync
      if (e.data.type === 'previewScroll') {
        const line = e.data.line as number;
        if (typeof line === 'number' && !isNaN(line)) {
          window.dispatchEvent(new CustomEvent('preview-scroll-to-line', { detail: { line } }));
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [activeContent]);

  // Toggle checkbox in markdown source by index
  const toggleCheckbox = (index: number) => {
    const content = useNotesStore.getState().activeContent;
    if (content == null) return;

    const todoRegex = /- \[[ x]\] /g;
    let match: RegExpExecArray | null;
    let currentIndex = 0;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (todoRegex.test(lines[i])) {
        if (currentIndex === index) {
          if (lines[i].includes('- [x] ')) {
            lines[i] = lines[i].replace('- [x] ', '- [ ] ');
          } else {
            lines[i] = lines[i].replace('- [ ] ', '- [x] ');
          }
          const newContent = lines.join('\n');
          useNotesStore.getState().updateContent(newContent, '');
          return;
        }
        currentIndex++;
        todoRegex.lastIndex = 0; // reset for each line
      }
      todoRegex.lastIndex = 0; // reset for each line
    }
  };

  if (!activeNote) return null;

  return (
    <div className="h-full overflow-hidden" style={{ backgroundColor: isDark ? '#23282D' : '#FFFFFF' }}>
      <iframe
        ref={iframeRef}
        src="/preview.html"
        className="w-full h-full border-none"
        title="preview"
        onLoad={handleIframeLoad}
      />
    </div>
  );
}