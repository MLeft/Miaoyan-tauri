import { useEffect, useRef, useState, useCallback } from 'react';
import DOMPurify from 'dompurify';
import { useNotesStore } from '../../stores/notes-store';
import { useEditorStore } from '../../stores/editor-store';
import { useSettingsStore } from '../../stores/settings-store';
import { parseMarkdown, readAnnotations, writeAnnotations, deleteAnnotations } from '../../services/tauri-bridge';
import { convertFileSrc } from '@tauri-apps/api/core';
import { openPath, openUrl } from '@tauri-apps/plugin-opener';
import type { Annotation } from '../../types';
import { AnnotationPanel } from './AnnotationPanel';
import { perfReport } from '../../services/perf';
import { currentPreviewDocument, samePreviewScope, validPreviewMessage, safeExternalUrl, togglePreviewTask } from '../../services/render-safety';
import type { PreviewScope, PreviewSnapshot } from '../../services/render-safety';

function resolveImagePaths(html: string, notePath: string): string {
  const root = DOMPurify.sanitize(html, {
    RETURN_DOM: true,
    // DOMPurify's standard URI policy plus Tauri's passive local asset scheme.
    ALLOWED_URI_REGEXP: /^(?:(?:asset|https?|ftp|ftps|mailto|tel|callto|sms|cid|xmpp):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    FORBID_TAGS: ['iframe', 'object', 'embed', 'base', 'meta', 'link', 'form'],
  });
  const lastSlash = Math.max(notePath.lastIndexOf('/'), notePath.lastIndexOf('\\'));
  const dir = notePath.slice(0, lastSlash);
  root.querySelectorAll('img').forEach(img => {
    for (const attr of ['src', 'data-src']) {
      const src = img.getAttribute(attr);
      if (src && !/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(src)) {
        img.setAttribute(attr, convertFileSrc(`${dir}/${src}`.replace(/\\/g, '/')));
      }
    }
  });
  return root.innerHTML;
}

type Selection = { id: string; quote: string; heading: string; paragraphIndex: number; scope: PreviewScope; epoch: number };
type Consent = { scope: PreviewScope; source: string; index: number } | { scope: PreviewScope; url: string };

export function Preview() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const activeContent = useNotesStore(s => s.activeContent);
  const activeNote = useNotesStore(s => s.activeNote);
  const revision = useNotesStore(s => s.activeNote ? s.getDocumentRevision(s.activeNote.path) : null);
  const identity = useNotesStore(s => s.activeNote ? s.getDocumentSession(s.activeNote.path)?.identity : undefined);
  const editorScrollLine = useEditorStore(s => s.editorScrollLine);
  const viewMode = useEditorStore(s => s.viewMode);
  const config = useSettingsStore(s => s.config);
  const path = activeNote?.path;
  const annotationWorkError = useNotesStore(s => s.getDocumentWork(path ?? '', 'annotation:')?.error ?? null);
  const isHtmlFile = !!path && /\.(html|htm)$/i.test(path);
  const isDark = config.theme === 'dark' || (config.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [channel] = useState(() => crypto.randomUUID());
  const [iframeReady, setIframeReady] = useState(false);
  const port = useRef<MessagePort | null>(null);
  const [snapshot, setSnapshot] = useState<PreviewSnapshot | null>(null);
  const sent = useRef<PreviewSnapshot | null>(null);
  const parseSeq = useRef(0);
  const sendSeq = useRef(0);
  const sentAt = useRef(0);
  const [retry, setRetry] = useState(0);
  const [renderError, setRenderError] = useState('');
  const [consent, setConsent] = useState<Consent | null>(null);
  const [annotationMode, setAnnotationMode] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [showPanel, setShowPanel] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<Selection | null>(null);
  const [annotationError, setAnnotationError] = useState('');
  const [annotationReady, setAnnotationReady] = useState(false);
  const [annotationBusy, setAnnotationBusy] = useState(false);
  const [annotationRetry, setAnnotationRetry] = useState(0);
  const annotationEpoch = useRef(0);
  const annotationState = useRef({ path: '', identity: -1, documentId: '', version: '', password: undefined as string | undefined, ready: false, busy: false, epoch: 0 });

  const isCurrent = useCallback((scope: PreviewScope) => {
    const store = useNotesStore.getState();
    return currentPreviewDocument(scope, store.getDocumentSession(scope.path), store.activeNote?.path);
  }, []);
  const post = useCallback((data: Record<string, unknown>, scope: PreviewScope | null = sent.current) => {
    if (scope && isCurrent(scope)) {
      const { path, identity, revision, generation } = scope;
      port.current?.postMessage({ ...data, version: 1, channel, scope: { path, identity, revision, generation } });
    }
  }, [channel, isCurrent]);

  // Parsing captures source, path, session and revision together, including ABA/reopen.
  useEffect(() => {
    const seq = ++parseSeq.current;
    if (!path || revision === null || identity === undefined) { setSnapshot(null); return; }
    const scope = { path, revision, identity, generation: seq };
    setConsent(null);
    setRenderError('');
    setSnapshot(previous => !previous || previous.path !== path || previous.identity !== identity || activeContent === ''
      ? { ...scope, html: '', raw: isHtmlFile } : previous);
    const timer = setTimeout(async () => {
      try {
        const start = performance.now();
        const html = isHtmlFile ? activeContent : await parseMarkdown(activeContent);
        if (seq !== parseSeq.current || !isCurrent(scope)) return;
        if (performance.now() - start > 100) perfReport('parse-md', performance.now() - start, `len=${activeContent.length}`);
        setSnapshot({ ...scope, html, raw: isHtmlFile });
      } catch {
        if (seq === parseSeq.current) setRenderError('预览解析失败，请重试。');
      }
    }, activeContent === '' ? 0 : activeContent.length > 100_000 ? 600 : 250);
    return () => { clearTimeout(timer); ++parseSeq.current; };
  }, [activeContent, path, revision, identity, isHtmlFile, retry, isCurrent]);

  useEffect(() => {
    if (!iframeReady || !snapshot || !isCurrent(snapshot)) return;
    const next = { ...snapshot, generation: ++sendSeq.current };
    try {
      const html = resolveImagePaths(next.html, next.path);
      sent.current = next;
      sentAt.current = performance.now();
      post({ type: 'setContent', html, raw: next.raw, isDark,
        previewWidth: viewMode === 'preview' ? 'full' : config.preview_width }, next);
      post({ type: 'setAnnotationMode', enabled: annotationMode }, next);
    } catch { setRenderError('安全预览不可用，请重试。'); }
  }, [snapshot, iframeReady, isDark, config.preview_width, viewMode, isCurrent, post]);

  useEffect(() => {
    if (!iframeReady) return;
    const scope = sent.current;
    const raf = requestAnimationFrame(() => post({ type: 'scrollToLine', line: editorScrollLine }, scope));
    return () => cancelAnimationFrame(raf);
  }, [editorScrollLine, iframeReady, post]);

  useEffect(() => { post({ type: 'setAnnotationMode', enabled: annotationMode }); }, [annotationMode, iframeReady, post]);
  useEffect(() => {
    const scope = sent.current;
    const state = annotationState.current;
    if (!scope || !state.ready || state.path !== scope.path || state.identity !== scope.identity) return;
    const timer = setTimeout(() => post({ type: 'renderAnnotations', annotations }, scope), 250);
    return () => clearTimeout(timer);
  }, [annotations, snapshot, iframeReady, isDark, config.preview_width, viewMode, post]);

  const annotationsCurrent = useCallback((state: typeof annotationState.current) => {
    const store = useNotesStore.getState();
    return annotationState.current === state && annotationEpoch.current === state.epoch &&
      store.activeNote?.path === state.path && store.getDocumentSession(state.path)?.identity === state.identity;
  }, []);

  // Errors are not an empty annotation list. Writes are disabled until a successful
  // read; reopening a path waits for its previous write before reading it again.
  useEffect(() => {
    const epoch = ++annotationEpoch.current;
    const state = { path: path || '', identity: identity ?? -1, documentId: '', version: '', password: undefined as string | undefined, ready: false, busy: false, epoch };
    annotationState.current = state;
    setAnnotations([]); setPendingSelection(null); setAnnotationError('');
    setAnnotationReady(false); setAnnotationBusy(false);
    if (!path) return;
    (async () => {
      try {
        const settled = await useNotesStore.getState().waitDocumentWork(path, 'annotation:');
        if (!annotationsCurrent(state)) return;
        if (!settled) {
          const work = useNotesStore.getState().getDocumentWork(path, 'annotation:');
          if (work?.draft) setAnnotations(JSON.parse(work.draft));
          setAnnotationError('批注尚未保存，草稿已保留，请重试保存。');
          return;
        }
        state.password = useNotesStore.getState().activeEncryptionPassword ?? undefined;
        const document = await readAnnotations(path, state.password);
        if (typeof document.document_id !== 'string' || !document.document_id) throw new Error('Missing document identity');
        const parsed: unknown = JSON.parse(document.json);
        if (!Array.isArray(parsed) || !parsed.every(a => a && typeof a.id === 'string' && typeof a.quote === 'string' && typeof a.comment === 'string' && typeof a.heading === 'string' && Number.isSafeInteger(a.paragraphIndex) && ['open', 'resolved'].includes(a.status))) throw new Error('Invalid annotations');
        if (!annotationsCurrent(state)) return;
        state.documentId = document.document_id;
        state.version = typeof document.disk_version === 'string' ? document.disk_version : '';
        state.ready = true; setAnnotationReady(true); setAnnotations(parsed);
      } catch {
        if (annotationsCurrent(state)) setAnnotationError('批注加载失败；请重试，现有批注未被覆盖。');
      }
    })();
    return () => { ++annotationEpoch.current; };
  }, [path, identity, annotationRetry, annotationsCurrent]);

  const handleMessage = useRef<(value: unknown) => void>(() => {});
  handleMessage.current = value => {
    if (!validPreviewMessage(value) || value.version !== 1 || value.channel !== channel ||
        !samePreviewScope(sent.current, value.scope) || !isCurrent(value.scope)) return;
    const scope = value.scope;
    switch (value.type) {
      case 'preview-rendered':
        if (sentAt.current && performance.now() - sentAt.current > 500) perfReport('preview-render', performance.now() - sentAt.current);
        sentAt.current = 0;
        if (annotationState.current.ready) post({ type: 'renderAnnotations', annotations }, scope);
        break;
      case 'preview-error': setRenderError(`安全预览渲染失败：${value.message}。请重试。`); break;
      case 'checkbox-toggle': {
        if (snapshot?.raw) break;
        const store = useNotesStore.getState();
        const content = store.getDocumentSession(scope.path)?.content;
        const updated = content === undefined ? null : togglePreviewTask(content, value.index as number);
        if (updated !== null) store.updateDocumentContent(scope.path, updated, scope.revision);
        break;
      }
      case 'previewScroll': window.dispatchEvent(new CustomEvent('preview-scroll-to-line', { detail: { line: value.line } })); break;
      case 'wikilink-navigate': window.dispatchEvent(new CustomEvent('wikilink-navigate', { detail: { title: value.title } })); break;
      case 'annotation-selection':
        if (!annotationState.current.ready || annotationState.current.busy || annotationWorkError) break;
        setPendingSelection({ id: `ann-${crypto.randomUUID()}`, quote: value.quote as string, heading: value.heading as string, paragraphIndex: value.paragraphIndex as number, scope, epoch: annotationEpoch.current });
        setShowPanel(true); break;
      case 'annotation-copy':
        navigator.clipboard.writeText(value.text as string).catch(() => setAnnotationError('复制失败，请重试。')); break;
      case 'plantuml-request': setConsent({ scope, source: value.source as string, index: value.index as number }); break;
      case 'open-link': setConsent({ scope, url: value.url as string }); break;
    }
  };

  const handleIframeLoad = useCallback(() => {
    // No body or token is sent to a newly navigated frame. It must prove it knows
    // the nonce from its original fragment via a dedicated transferred port.
    port.current?.close(); sent.current = null; setIframeReady(false);
    const connection = new MessageChannel();
    port.current = connection.port1;
    let connected = false;
    connection.port1.onmessage = event => {
      if (port.current !== connection.port1) return;
      const data = event.data;
      if (!connected) {
        if (data?.type !== 'connected' || data.version !== 1 || data.channel !== channel) return;
        connected = true; setIframeReady(true); return;
      }
      handleMessage.current(data);
    };
    // Opaque sandbox origin requires '*'; the port is not trusted until nonce proof.
    iframeRef.current?.contentWindow?.postMessage({ type: 'preview-connect', version: 1 }, '*', [connection.port2]);
  }, [channel]);
  useEffect(() => () => { port.current?.close(); port.current = null; ++parseSeq.current; }, []);

  const persistAnnotations = useCallback(async (updated: Annotation[], key: string) => {
    const state = annotationState.current;
    if (!state.ready || state.busy || !annotationsCurrent(state)) return false;
    state.busy = true; setAnnotationBusy(true); setAnnotationError('');
    const json = JSON.stringify(updated, null, 2);
    try {
      const saved = await useNotesStore.getState().runDocumentWork(state.path, state.identity, `annotation:${key}`,
        async () => {
          const version = updated.length
            ? await writeAnnotations(state.path, state.documentId, json, state.version, state.password)
            : await deleteAnnotations(state.path, state.documentId, state.version, state.password);
          if (annotationsCurrent(state) && typeof version === 'string') state.version = version;
        }, json);
      if (!annotationsCurrent(state)) return saved;
      if (!saved) { setAnnotationError('批注保存失败；草稿已保留，请重试保存。'); return false; }
      setAnnotations(updated);
      return true;
    } finally {
      if (annotationsCurrent(state)) { state.busy = false; setAnnotationBusy(false); }
    }
  }, [annotationsCurrent]);

  useEffect(() => {
    const complete = (event: Event) => {
      const detail = (event as CustomEvent<{ path: string; identity: number; key: string }>).detail;
      if (detail.path === path && detail.identity === identity && detail.key.startsWith('annotation:') && !annotationState.current.busy) {
        setAnnotationRetry(value => value + 1);
      }
    };
    window.addEventListener('document-work-complete', complete);
    return () => window.removeEventListener('document-work-complete', complete);
  }, [path, identity]);

  const retryAnnotations = async () => {
    const state = annotationState.current;
    if (state.busy) return;
    state.busy = true; setAnnotationBusy(true);
    try {
      // A failed write may have raced an external edit; refresh the sidecar
      // version so the retried draft is applied against what is on disk now.
      try {
        const refreshed = await readAnnotations(state.path, state.password);
        if (annotationsCurrent(state) && typeof refreshed.disk_version === 'string') state.version = refreshed.disk_version;
      } catch { /* retry surfaces its own failure */ }
      if (await useNotesStore.getState().retryDocumentWork(state.path, 'annotation:')) setAnnotationRetry(value => value + 1);
    } finally {
      if (annotationsCurrent(state)) { state.busy = false; setAnnotationBusy(false); }
    }
  };

  const handleAddAnnotation = async (comment: string) => {
    const selection = pendingSelection;
    if (!selection || selection.epoch !== annotationEpoch.current || !isCurrent(selection.scope)) {
      setAnnotationError('选区已过期，请在当前文档重新选择。'); return false;
    }
    const saved = await persistAnnotations([...annotations, {
      id: selection.id, quote: selection.quote, comment, heading: selection.heading,
      paragraphIndex: selection.paragraphIndex, status: 'open', createdAt: new Date().toISOString(),
    }], selection.id);
    if (saved) setPendingSelection(current => current === selection ? null : current);
    return saved;
  };
  const handleDeleteAnnotation = (id: string) => persistAnnotations(annotations.filter(a => a.id !== id), id);
  const handleResolve = (id: string) => persistAnnotations(annotations.map(a => a.id === id ? { ...a, status: 'resolved' as const } : a), id);
  const handleReopen = (id: string) => persistAnnotations(annotations.map(a => a.id === id ? { ...a, status: 'open' as const } : a), id);
  const handleEditAnnotation = (id: string, comment: string) => persistAnnotations(annotations.map(a => a.id === id ? { ...a, comment } : a), id);
  const handleClearResolved = async () => {
    if (await persistAnnotations(annotations.filter(a => a.status !== 'resolved'), 'clear-resolved')) { setShowPanel(false); setAnnotationMode(false); }
  };
  const handleCopyReport = () => {
    const report = annotations.map((a, i) => `### 批注 #${i + 1}\n章节: ${a.heading || '(无)'}\n> 引用: ${a.quote}\n批注: ${a.comment}\n状态: ${a.status === 'resolved' ? '已处理' : '待处理'}`).join('\n\n');
    navigator.clipboard.writeText(`# 文档批注报告\n\n文档: ${activeNote?.title || ''}\n\n${report}`).catch(() => setAnnotationError('复制失败，请重试。'));
  };
  const toggleAnnotationMode = () => { setAnnotationMode(!annotationMode); setShowPanel(!annotationMode); if (annotationMode) setPendingSelection(null); };
  const handleOpenInBrowser = useCallback(async () => {
    if (!activeNote) return;
    try {
      if (useNotesStore.getState().isDirty) {
        if (!(await useNotesStore.getState().saveCurrentNote())) return;
      }
      await openPath(activeNote.path);
    } catch { setRenderError('系统浏览器打开失败，请重试。'); }
  }, [activeNote]);
  const approve = async () => {
    if (!consent || !samePreviewScope(sent.current, consent.scope) || !isCurrent(consent.scope)) { setConsent(null); return; }
    if ('source' in consent) post({ type: 'plantuml-approve', source: consent.source, index: consent.index }, consent.scope);
    else {
      const url = safeExternalUrl(consent.url);
      if (url) try { await openUrl(url); } catch { setRenderError('链接打开失败，请重试。'); }
    }
    setConsent(null);
  };

  if (!activeNote) return null;
  return (
    <div className="h-full overflow-hidden flex" style={{ backgroundColor: 'var(--bg-secondary)' }}>
      <div className="relative flex-1 min-w-0 h-full flex flex-col">
        {renderError && <div role="alert">{renderError} <button onClick={() => setRetry(n => n + 1)}>重试预览</button></div>}
        {(annotationError || annotationWorkError) && <div role="alert">{annotationError || annotationWorkError}{annotationWorkError ? <button disabled={annotationBusy} onClick={() => { void retryAnnotations(); }}>重试批注保存</button> : !annotationReady && <button onClick={() => setAnnotationRetry(n => n + 1)}>重试批注加载</button>}</div>}
        {consent && <div data-preview-consent role="dialog" aria-label="外部访问确认" style={{ padding: 12, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', flexShrink: 0 }}>
          {'source' in consent ? <><p>是否将当前这张图的完整源码发送到 plantuml.com 渲染？仅授权当前文档、当前代码一次。取消则保持源码阅读。</p><pre style={{ maxHeight: 160, overflow: 'auto' }}>{consent.source}</pre></> : <p>是否用系统浏览器打开此链接？{consent.url}</p>}
          <button data-approve onClick={approve}>确认发送 / 打开</button> <button onClick={() => setConsent(null)}>取消</button>
        </div>}
        <div className="relative flex-1 min-h-0">
          <button onClick={toggleAnnotationMode} className="absolute top-2 z-40 rounded-md cursor-pointer flex items-center justify-center"
            style={{ right: isHtmlFile ? 44 : 16, width: 28, height: 28, background: annotationMode ? 'var(--accent-icon, #2b6cb0)' : 'var(--bg-tertiary)', color: annotationMode ? '#fff' : 'var(--text-secondary)', border: '1px solid var(--border)' }}
            title={annotationMode ? '关闭批注模式' : '开启批注模式'}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
            {annotations.length > 0 && <span className="absolute -top-1 -right-1 rounded-full flex items-center justify-center" style={{ width: 14, height: 14, background: '#d69e2e', color: '#fff', fontSize: 9, fontWeight: 700 }}>{annotations.length}</span>}
          </button>
          {isHtmlFile && <button onClick={handleOpenInBrowser} className="absolute top-2 right-4 z-40 rounded-md cursor-pointer flex items-center justify-center" style={{ width: 28, height: 28, background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }} title="用系统浏览器打开">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
          </button>}
          <iframe ref={iframeRef} src={`/preview.html#channel=${encodeURIComponent(channel)}&parentOrigin=${encodeURIComponent(window.location.origin)}`} sandbox="allow-scripts" referrerPolicy="no-referrer" className="w-full h-full border-none" title="preview" onLoad={handleIframeLoad} />
        </div>
      </div>
      {showPanel && <AnnotationPanel key={`${path}:${identity}:${annotationRetry}`} annotations={annotations} pendingSelection={pendingSelection}
        disabled={!annotationReady || annotationBusy || !!annotationWorkError} onAdd={handleAddAnnotation} onDelete={handleDeleteAnnotation}
        onResolve={handleResolve} onReopen={handleReopen} onEdit={handleEditAnnotation}
        onCancelPending={() => setPendingSelection(null)} onClearResolved={handleClearResolved}
        onScrollTo={id => post({ type: 'scrollToAnnotation', id })} onCopyReport={handleCopyReport}
        onClose={() => { setShowPanel(false); setPendingSelection(null); }} />}
    </div>
  );
}
