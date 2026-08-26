import { useEffect, useRef, useState, useCallback } from 'react';
import { useNotesStore } from '../../stores/notes-store';
import { useEditorStore } from '../../stores/editor-store';
import { useSettingsStore } from '../../stores/settings-store';
import { parseMarkdown, readAnnotations, writeAnnotations, deleteAnnotations } from '../../services/tauri-bridge';
import { convertFileSrc } from '@tauri-apps/api/core';
import { openPath } from '@tauri-apps/plugin-opener';
import type { Annotation } from '../../types';
import { AnnotationPanel } from './AnnotationPanel';
import { perfReport } from '../../services/perf';

function resolveImagePaths(html: string, notePath: string): string {
  // 获取笔记所在目录（处理 Windows 和 Unix 路径）
  const lastSlash = Math.max(notePath.lastIndexOf('/'), notePath.lastIndexOf('\\'));
  const noteDir = lastSlash >= 0 ? notePath.substring(0, lastSlash) : notePath;

  return html.replace(/(<img[^>]*\ssrc=["'])([^"']+)(["'])/gi, (match, prefix, src, suffix) => {
    // 跳过绝对 URL、data URI、已转换的 asset URL
    if (src.startsWith('http://') || src.startsWith('https://') ||
        src.startsWith('data:') || src.startsWith('asset://') ||
        src.startsWith('/')) {
      return match;
    }
    // 相对路径 -> 绝对路径 -> asset URL
    const absolutePath = `${noteDir}/${src}`.replace(/\\/g, '/');
    return `${prefix}${convertFileSrc(absolutePath)}${suffix}`;
  });
}

export function Preview() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // 窄订阅：避免 store 其他字段变化触发预览重渲染
  const activeContent = useNotesStore((s) => s.activeContent);
  const activeNote = useNotesStore((s) => s.activeNote);
  // 窄订阅：editorScrollLine 每个滚动帧都会变，全量订阅会让预览
  // 在滚动时逐帧重渲染（含全部 useCallback 重建）
  const editorScrollLine = useEditorStore((s) => s.editorScrollLine);
  const viewMode = useEditorStore((s) => s.viewMode);
  const config = useSettingsStore((s) => s.config);
  const [renderedHtml, setRenderedHtml] = useState('');
  const [iframeReady, setIframeReady] = useState(false);
  const renderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 解析序号：快速打字时可能有多个 parseMarkdown 同时在途，只采纳最新一次的结果
  const renderSeq = useRef(0);
  const annTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // RAF throttle for editor→preview scroll sync
  const scrollSyncRafRef = useRef<number | null>(null);
  // 性能埋点：setContent 发出时刻，收到 preview-rendered 时算端到端耗时
  const renderSentAtRef = useRef<number>(0);

  // ── Annotation state ──
  const [annotationMode, setAnnotationMode] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [showPanel, setShowPanel] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<{
    quote: string; heading: string; paragraphIndex: number;
  } | null>(null);

  const isDark = config.theme === 'dark' ||
    (config.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  const isHtmlFile = !!activeNote && /\.(html|htm)$/i.test(activeNote.path);

  const handleIframeLoad = () => {
    setIframeReady(true);
  };

  // Parse markdown content -> HTML
  useEffect(() => {
    if (!activeNote) return;
    if (renderTimer.current) clearTimeout(renderTimer.current);
    const seq = ++renderSeq.current;
    renderTimer.current = setTimeout(async () => {
      try {
        if (isHtmlFile) {
          // HTML 文件直接渲染源码，不走 Markdown 解析
          if (seq === renderSeq.current) setRenderedHtml(activeContent);
          return;
        }
        const t0 = performance.now();
        const html = await parseMarkdown(activeContent);
        // Markdown 解析 IPC 超过 100ms 记录（含序列化大文档的开销）
        const parseMs = performance.now() - t0;
        if (parseMs > 100) perfReport('parse-md', parseMs, `len=${activeContent.length}`);
        // 丢弃过期结果，避免旧内容覆盖新内容/多余的重渲染
        if (seq === renderSeq.current) setRenderedHtml(html);
      } catch (e) {
        console.error('Failed to parse markdown:', e);
      }
    // 自适应防抖：大文档每次渲染要重建数百 KB HTML，缩短间隔只会让预览
    // 永远在追赶；小文档保持 250ms 的跟手感
    }, activeContent.length > 100_000 ? 600 : 250);
    return () => { if (renderTimer.current) clearTimeout(renderTimer.current); };
  }, [activeContent, activeNote?.id, isHtmlFile]);

  // Send HTML content + theme + config to iframe via postMessage
  useEffect(() => {
    if (!iframeReady || !renderedHtml) return;
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    const processedHtml = activeNote ? resolveImagePaths(renderedHtml, activeNote.path) : renderedHtml;
    renderSentAtRef.current = performance.now();
    iframe.contentWindow.postMessage({
      type: 'setContent',
      html: processedHtml,
      isDark,
      previewWidth: viewMode === 'preview' ? 'full' : config.preview_width,
      // HTML 文件以原始模式渲染，跳过 Markdown 后处理
      raw: isHtmlFile,
    }, '*');
  }, [renderedHtml, isDark, iframeReady, config.preview_width, viewMode, isHtmlFile]);

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

  // Send preview width update to iframe
  useEffect(() => {
    if (!iframeReady) return;
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage({
      type: 'applyPreviewWidth',
      previewWidth: viewMode === 'preview' ? 'full' : config.preview_width,
    }, '*');
  }, [config.preview_width, viewMode, iframeReady]);

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

      // iframe 渲染完成：端到端（解析→postMessage→innerHTML→后处理）超过 500ms 记录
      if (e.data.type === 'preview-rendered') {
        if (renderSentAtRef.current > 0) {
          const total = performance.now() - renderSentAtRef.current;
          renderSentAtRef.current = 0;
          if (total > 500) perfReport('preview-render', total);
        }
        return;
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

      // Annotation selection from iframe
      if (e.data.type === 'annotation-selection') {
        setPendingSelection({
          quote: e.data.quote,
          heading: e.data.heading || '',
          paragraphIndex: e.data.paragraphIndex || 0,
        });
        setShowPanel(true);
      }

      // Annotation highlight clicked in iframe
      if (e.data.type === 'annotation-click') {
        // Scroll panel to the annotation (handled by panel)
      }

      // Copy from annotation popup in iframe
      if (e.data.type === 'annotation-copy') {
        window.dispatchEvent(new CustomEvent('show-toast', { detail: { message: '复制成功' } }));
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
    // 不依赖 activeContent：toggleCheckbox 内部通过 getState 取最新内容，
    // 避免每次按键都重新挂载全局 message 监听器
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load annotations when note changes ──
  useEffect(() => {
    if (!activeNote) { setAnnotations([]); return; }
    readAnnotations(activeNote.path).then((json) => {
      try {
        const parsed = JSON.parse(json) as Annotation[];
        setAnnotations(Array.isArray(parsed) ? parsed : []);
      } catch { setAnnotations([]); }
    }).catch(() => setAnnotations([]));
  }, [activeNote?.path]);

  // ── Send annotation mode to iframe ──
  useEffect(() => {
    if (!iframeReady) return;
    iframeRef.current?.contentWindow?.postMessage({
      type: 'setAnnotationMode', enabled: annotationMode,
    }, '*');
  }, [annotationMode, iframeReady]);

  // ── Render highlights when annotations or content changes ──
  useEffect(() => {
    if (!iframeReady) return;
    // 无批注时无需发送：setContent 的 innerHTML 整段替换已自动清除旧高亮，
    // 避免每次按键都触发 iframe 内全文本节点遍历
    if (annotations.length === 0) return;
    // 防抖：打字触发的连续内容更新只在停顿后重算一次高亮
    if (annTimer.current) clearTimeout(annTimer.current);
    annTimer.current = setTimeout(() => {
      annTimer.current = null;
      iframeRef.current?.contentWindow?.postMessage({
        type: 'renderAnnotations', annotations,
      }, '*');
    }, 250);
  }, [annotations, iframeReady, renderedHtml]);

  // ── Persist annotations to disk ──
  const persistAnnotations = useCallback(async (updated: Annotation[]) => {
    if (!activeNote) return;
    setAnnotations(updated);
    if (updated.length === 0) {
      await deleteAnnotations(activeNote.path).catch(() => {});
    } else {
      await writeAnnotations(activeNote.path, JSON.stringify(updated, null, 2)).catch(() => {});
    }
  }, [activeNote]);

  // ── Annotation CRUD handlers ──
  const handleAddAnnotation = useCallback((comment: string) => {
    if (!pendingSelection) return;
    const newAnn: Annotation = {
      id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      quote: pendingSelection.quote,
      comment,
      heading: pendingSelection.heading,
      paragraphIndex: pendingSelection.paragraphIndex,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    persistAnnotations([...annotations, newAnn]);
    setPendingSelection(null);
  }, [pendingSelection, annotations, persistAnnotations]);

  const handleDeleteAnnotation = useCallback((id: string) => {
    persistAnnotations(annotations.filter(a => a.id !== id));
  }, [annotations, persistAnnotations]);

  const handleResolve = useCallback((id: string) => {
    persistAnnotations(annotations.map(a => a.id === id ? { ...a, status: 'resolved' as const } : a));
  }, [annotations, persistAnnotations]);

  const handleReopen = useCallback((id: string) => {
    persistAnnotations(annotations.map(a => a.id === id ? { ...a, status: 'open' as const } : a));
  }, [annotations, persistAnnotations]);

  const handleEditAnnotation = useCallback((id: string, newComment: string) => {
    persistAnnotations(annotations.map(a => a.id === id ? { ...a, comment: newComment } : a));
  }, [annotations, persistAnnotations]);

  const handleClearResolved = useCallback(() => {
    persistAnnotations([]);
    setShowPanel(false);
    setAnnotationMode(false);
  }, [persistAnnotations]);

  const handleScrollTo = useCallback((id: string) => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'scrollToAnnotation', id }, '*');
  }, []);

  const handleCopyReport = useCallback(() => {
    const lines = annotations.map((a, i) =>
      `### 批注 #${i + 1}\n章节: ${a.heading || '(无)'}\n> 引用: ${a.quote}\n批注: ${a.comment}\n状态: ${a.status === 'resolved' ? '已处理' : '待处理'}`
    );
    const report = `# 文档批注报告\n\n文档: ${activeNote?.title || ''}\n批注数: ${annotations.length}\n\n---\n\n${lines.join('\n\n')}`;
    navigator.clipboard.writeText(report).then(() => {
      window.dispatchEvent(new CustomEvent('show-toast', { detail: { message: '复制成功' } }));
    }).catch(() => {});
  }, [annotations, activeNote]);

  const toggleAnnotationMode = useCallback(() => {
    const next = !annotationMode;
    setAnnotationMode(next);
    if (next) setShowPanel(true);
    if (!next) setPendingSelection(null);
  }, [annotationMode]);

  // Open HTML file in system default browser
  const handleOpenInBrowser = useCallback(async () => {
    if (!activeNote) return;
    try {
      // 打开前先保存未保存的修改，确保浏览器看到最新内容
      if (useNotesStore.getState().isDirty) {
        await useNotesStore.getState().saveCurrentNote();
      }
      await openPath(activeNote.path);
    } catch (e) {
      console.error('Failed to open in browser:', e);
    }
  }, [activeNote]);

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
    <div className="h-full overflow-hidden flex" style={{ backgroundColor: 'var(--bg-secondary)' }}>
      {/* 左侧预览区：批注侧边栏打开时让出宽度，不再遮挡内容 */}
      <div className="relative flex-1 min-w-0 h-full">
      {/* Annotation mode toggle button */}
      <button
        onClick={toggleAnnotationMode}
        className="absolute top-2 z-40 rounded-md cursor-pointer flex items-center justify-center"
        style={{
          // HTML 文件时右侧还需放“用系统浏览器打开”按钮，向左让位
          right: isHtmlFile ? '44px' : '16px',
          width: '28px',
          height: '28px',
          backgroundColor: annotationMode ? 'var(--accent-icon, #2b6cb0)' : 'var(--bg-tertiary)',
          color: annotationMode ? '#fff' : 'var(--text-secondary)',
          border: '1px solid var(--border)',
          fontSize: '14px',
        }}
        title={annotationMode ? '关闭批注模式' : '开启批注模式'}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        {annotations.length > 0 && (
          <span
            className="absolute -top-1 -right-1 rounded-full flex items-center justify-center"
            style={{
              width: '14px', height: '14px',
              backgroundColor: '#d69e2e',
              color: '#fff',
              fontSize: '9px',
              fontWeight: 700,
            }}
          >
            {annotations.length}
          </span>
        )}
      </button>

      {/* HTML 文件：用系统浏览器打开 */}
      {isHtmlFile && (
        <button
          onClick={handleOpenInBrowser}
          className="absolute top-2 right-4 z-40 rounded-md cursor-pointer flex items-center justify-center"
          style={{
            width: '28px',
            height: '28px',
            backgroundColor: 'var(--bg-tertiary)',
            color: 'var(--text-secondary)',
            border: '1px solid var(--border)',
          }}
          title="用系统浏览器打开"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </button>
      )}

      <iframe
        ref={iframeRef}
        src="/preview.html"
        className="w-full h-full border-none"
        title="preview"
        onLoad={handleIframeLoad}
      />
      </div>

      {/* Annotation sidebar（flex 兄弟列，不遮挡预览） */}
      {showPanel && (
        <AnnotationPanel
          annotations={annotations}
          pendingSelection={pendingSelection}
          onAdd={handleAddAnnotation}
          onDelete={handleDeleteAnnotation}
          onResolve={handleResolve}
          onReopen={handleReopen}
          onEdit={handleEditAnnotation}
          onCancelPending={() => setPendingSelection(null)}
          onClearResolved={handleClearResolved}
          onScrollTo={handleScrollTo}
          onCopyReport={handleCopyReport}
          onClose={() => { setShowPanel(false); setPendingSelection(null); }}
        />
      )}
    </div>
  );
}