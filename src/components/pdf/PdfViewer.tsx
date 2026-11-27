import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { convertFileSrc } from '@tauri-apps/api/core';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { log } from '../../services/logger';
import { PdfPage } from './PdfPage';
import { buildPageText, findMatchesInText, PdfTextCache } from './pdfText';
import type { PageText, SearchMatch } from './pdfText';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;
const ZOOM_STEP = 1.25;
const PAGE_GAP = 16;
const SIDE_PADDING = 48;

const clampScale = (s: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s));

interface PageDim { width: number; height: number }

interface SavedViewState {
  scale: number;
  scrollTop: number;
}

// 每个 PDF 的缩放/滚动位置，切标签或关标签后再次打开时恢复
const viewStates = new Map<string, SavedViewState>();

interface PdfViewerProps {
  path: string;
}

/* ── Toolbar icons ── */
const IconZoomIn = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <circle cx="7" cy="7" r="4.6" />
    <path d="M10.5 10.5L14 14M7 5v4M5 7h4" />
  </svg>
);
const IconZoomOut = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <circle cx="7" cy="7" r="4.6" />
    <path d="M10.5 10.5L14 14M5 7h4" />
  </svg>
);
const IconFitWidth = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 5.5v-2h2M14 5.5v-2h-2M2 10.5v2h2M14 10.5v2h-2M4.5 8h7M6 6.5L4.5 8 6 9.5M10 6.5L11.5 8 10 9.5" />
  </svg>
);
const IconSearch = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <circle cx="7" cy="7" r="4.4" />
    <path d="M10.4 10.4L14 14" />
  </svg>
);
const IconChevronUp = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 10l4-4 4 4" />
  </svg>
);
const IconChevronDown = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 6l4 4 4-4" />
  </svg>
);
const IconCloseSmall = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 8.7l3.65 3.65.7-.7L8.7 8l3.65-3.65-.7-.7L8 7.3 4.35 3.65l-.7.7L7.3 8l-3.65 3.65.7.7L8 8.7z" />
  </svg>
);

function ToolButton({ onClick, title, active, disabled, children }: {
  onClick: () => void;
  title: string;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      title={title}
      className="rounded flex items-center justify-center flex-shrink-0"
      style={{
        width: 26,
        height: 26,
        color: active ? 'var(--accent-icon)' : 'var(--text-secondary)',
        backgroundColor: active ? 'var(--accent-light)' : 'transparent',
        opacity: disabled ? 0.35 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
      onMouseEnter={(e) => {
        if (!disabled && !active) e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)';
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.backgroundColor = 'transparent';
      }}
    >
      {children}
    </button>
  );
}

const EMPTY_MATCHES: Array<{ start: number; end: number }> = [];

export function PdfViewer({ path }: PdfViewerProps) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef(new Map<number, HTMLDivElement>());
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const loadingTaskRef = useRef<pdfjsLib.PDFDocumentLoadingTask | null>(null);
  const dimsRef = useRef<PageDim[]>([]);
  const scaleRef = useRef(1);
  const currentPageRef = useRef(1);
  const fitModeRef = useRef(true);
  const scrollRafRef = useRef(0);
  const restoreInfoRef = useRef<SavedViewState | null>(null);
  const restoredRef = useRef(false);
  const anchorPageRef = useRef<number | null>(null);
  // 卸载时 ref 可能已被 React 置空，滚动位置改为滚动中持续记录
  const lastScrollTopRef = useRef(0);
  const textCacheRef = useRef(new PdfTextCache());
  const searchSeqRef = useRef(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [numPages, setNumPages] = useState(0);
  const [dims, setDims] = useState<PageDim[]>([]);
  const [scale, setScale] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [searchIndex, setSearchIndex] = useState(-1);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  const updateCurrentPage = useCallback((n: number) => {
    currentPageRef.current = n;
    setCurrentPage(n);
    setPageInput(String(n));
  }, []);

  const getPageText = useCallback((pageNumber: number): Promise<PageText> => {
    const doc = docRef.current;
    if (!doc) return Promise.reject(new Error('PDF not loaded'));
    return textCacheRef.current.get(pageNumber, async () => {
      const page = await doc.getPage(pageNumber);
      return buildPageText(await page.getTextContent());
    });
  }, []);

  const registerRef = useCallback((pageNumber: number, el: HTMLDivElement | null) => {
    if (el) pagesRef.current.set(pageNumber, el);
    else pagesRef.current.delete(pageNumber);
  }, []);

  /* ── Load document ── */
  useEffect(() => {
    let cancelled = false;
    const saved = viewStates.get(path) ?? null;
    restoreInfoRef.current = saved;
    restoredRef.current = false;
    lastScrollTopRef.current = saved?.scrollTop ?? 0;
    fitModeRef.current = !saved;

    setStatus('loading');
    setErrorMsg('');
    setNumPages(0);
    setDims([]);
    setScale(1);
    setCurrentPage(1);
    setPageInput('1');
    setSearchOpen(false);
    setSearchQuery('');
    setSearchMatches([]);
    setSearchIndex(-1);
    setSearching(false);
    dimsRef.current = [];
    pagesRef.current.clear();
    textCacheRef.current.clear();
    searchSeqRef.current++;

    (async () => {
      try {
        const url = convertFileSrc(path);
        const task = pdfjsLib.getDocument({
          url,
          cMapUrl: '/pdfjs/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: '/pdfjs/standard_fonts/',
          wasmUrl: '/pdfjs/wasm/',
          iccUrl: '/pdfjs/iccs/',
        });
        loadingTaskRef.current = task;
        const doc = await task.promise;
        if (cancelled) {
          doc.destroy();
          return;
        }
        docRef.current = doc;
        setNumPages(doc.numPages);

        const firstPage = await doc.getPage(1);
        if (cancelled) return;
        const firstViewport = firstPage.getViewport({ scale: 1 });
        const firstDim: PageDim = { width: firstViewport.width, height: firstViewport.height };
        const arr: PageDim[] = new Array(doc.numPages).fill(firstDim);
        dimsRef.current = arr;
        setDims(arr);

        const container = containerRef.current;
        if (saved) {
          setScale(clampScale(saved.scale));
        } else if (container) {
          const avail = Math.max(200, container.clientWidth - SIDE_PADDING);
          setScale(clampScale(avail / firstDim.width));
        }
        if (!cancelled) setStatus('ready');

        // 其余页尺寸后台补全（占位先用第 1 页尺寸）
        const rest: PageDim[] = new Array(doc.numPages);
        rest[0] = firstDim;
        for (let i = 2; i <= doc.numPages; i++) {
          if (cancelled) return;
          try {
            const page = await doc.getPage(i);
            const viewport = page.getViewport({ scale: 1 });
            rest[i - 1] = { width: viewport.width, height: viewport.height };
          } catch {
            rest[i - 1] = firstDim;
          }
          if (i % 20 === 0) {
            dimsRef.current = [...rest];
            setDims([...rest]);
          }
        }
        if (!cancelled) {
          dimsRef.current = [...rest];
          setDims([...rest]);
        }
      } catch (e) {
        if (cancelled) return;
        const name = (e as { name?: string })?.name;
        log(`PDF load failed: ${path} ${String(e)}`);
        setErrorMsg(
          name === 'PasswordException'
            ? tRef.current('pdf.passwordProtected')
            : `${tRef.current('pdf.loadFailed')}${(e as Error)?.message ? `: ${(e as Error).message}` : ''}`
        );
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      viewStates.set(path, {
        scale: scaleRef.current,
        scrollTop: lastScrollTopRef.current,
      });
      docRef.current = null;
      textCacheRef.current.clear();
      loadingTaskRef.current?.destroy();
      loadingTaskRef.current = null;
    };
  }, [path]);

  /* ── Restore scroll position once ready ── */
  useEffect(() => {
    if (status !== 'ready' || restoredRef.current || dims.length === 0) return;
    const info = restoreInfoRef.current;
    if (!info?.scrollTop) {
      restoredRef.current = true;
      return;
    }
    const frame = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) return;
      container.scrollTop = info.scrollTop;
      lastScrollTopRef.current = container.scrollTop;
      restoredRef.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [path, status, scale, dims]);

  /* ── Track current page while scrolling ── */
  const handleScroll = useCallback(() => {
    if (scrollRafRef.current) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0;
      const c = containerRef.current;
      if (!c) return;
      lastScrollTopRef.current = c.scrollTop;
      const y = c.scrollTop + 80;
      let page = 1;
      for (let i = 1; i <= numPages; i++) {
        const el = pagesRef.current.get(i);
        if (!el) continue;
        if (el.offsetTop <= y) page = i;
        else break;
      }
      if (page !== currentPageRef.current) updateCurrentPage(page);
    });
  }, [numPages, updateCurrentPage]);

  useEffect(() => () => {
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
  }, []);

  /* ── Zoom / fit width ── */
  const applyScale = useCallback((next: number) => {
    anchorPageRef.current = currentPageRef.current;
    setScale(clampScale(next));
  }, []);

  useEffect(() => {
    const anchor = anchorPageRef.current;
    if (anchor == null || status !== 'ready') return;
    anchorPageRef.current = null;
    const el = pagesRef.current.get(anchor);
    const c = containerRef.current;
    if (el && c) c.scrollTop = Math.max(0, el.offsetTop - 8);
  }, [scale, status]);

  // 手动缩放后关闭「跟随窗口适应宽度」，避免窗口/容器尺寸变化把手动缩放覆盖掉
  const zoomTo = useCallback((next: number) => {
    fitModeRef.current = false;
    applyScale(next);
  }, [applyScale]);

  const fitWidth = useCallback(() => {
    fitModeRef.current = true;
    const c = containerRef.current;
    const dim = dimsRef.current[currentPageRef.current - 1] ?? dimsRef.current[0];
    if (!c || !dim) return;
    const avail = Math.max(200, c.clientWidth - SIDE_PADDING);
    applyScale(avail / dim.width);
  }, [applyScale]);

  useEffect(() => {
    const c = containerRef.current;
    if (!c || status !== 'ready') return;
    const ro = new ResizeObserver(() => {
      if (!fitModeRef.current) return;
      const dim = dimsRef.current[currentPageRef.current - 1] ?? dimsRef.current[0];
      if (!dim) return;
      const avail = Math.max(200, c.clientWidth - SIDE_PADDING);
      const next = clampScale(avail / dim.width);
      if (Math.abs(next - scaleRef.current) > 0.01) applyScale(next);
    });
    ro.observe(c);
    return () => ro.disconnect();
  }, [status, applyScale]);

  const scrollToPage = useCallback((n: number) => {
    const total = numPages || 1;
    const target = Math.min(Math.max(1, n), total);
    const el = pagesRef.current.get(target);
    const c = containerRef.current;
    if (el && c) c.scrollTop = Math.max(0, el.offsetTop - 8);
    updateCurrentPage(target);
  }, [numPages, updateCurrentPage]);

  /* ── Search ── */
  const gotoMatch = useCallback((idx: number) => {
    if (!searchMatches.length) return;
    const len = searchMatches.length;
    const n = ((idx % len) + len) % len;
    setSearchIndex(n);
    const m = searchMatches[n];
    const el = pagesRef.current.get(m.page);
    const c = containerRef.current;
    if (el && c) c.scrollTop = Math.max(0, el.offsetTop - 60);
    updateCurrentPage(m.page);
  }, [searchMatches, updateCurrentPage]);

  const runSearch = useCallback(async (query: string) => {
    const seq = ++searchSeqRef.current;
    setSearching(true);
    const queryLower = query.toLowerCase();
    const found: SearchMatch[] = [];
    for (let n = 1; n <= numPages; n++) {
      if (seq !== searchSeqRef.current) return;
      try {
        const pt = await getPageText(n);
        const pageMatches = findMatchesInText(n, pt.text, queryLower);
        if (pageMatches.length) found.push(...pageMatches);
      } catch {
        // 单页文本解析失败不影响整体搜索
      }
      if (n % 25 === 0 && seq === searchSeqRef.current) {
        setSearchMatches([...found]);
      }
    }
    if (seq !== searchSeqRef.current) return;
    setSearchMatches(found);
    setSearching(false);
    if (found.length) {
      setSearchIndex(0);
      const el = pagesRef.current.get(found[0].page);
      const c = containerRef.current;
      if (el && c) c.scrollTop = Math.max(0, el.offsetTop - 60);
      updateCurrentPage(found[0].page);
    } else {
      setSearchIndex(-1);
    }
  }, [numPages, getPageText, updateCurrentPage]);

  useEffect(() => {
    if (!searchOpen || status !== 'ready') return;
    const q = searchQuery.trim();
    if (!q) {
      searchSeqRef.current++;
      setSearchMatches([]);
      setSearchIndex(-1);
      setSearching(false);
      return;
    }
    const timer = setTimeout(() => { void runSearch(q); }, 300);
    return () => {
      clearTimeout(timer);
      searchSeqRef.current++;
    };
  }, [searchQuery, searchOpen, status, runSearch]);

  useEffect(() => {
    const handler = () => {
      setSearchOpen(true);
      requestAnimationFrame(() => searchInputRef.current?.focus());
    };
    window.addEventListener('pdf-focus-search', handler);
    return () => window.removeEventListener('pdf-focus-search', handler);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    searchSeqRef.current++;
    setSearchMatches([]);
    setSearchIndex(-1);
    setSearching(false);
  }, []);

  const matchesByPage = useMemo(() => {
    const map = new Map<number, Array<{ start: number; end: number }>>();
    for (const m of searchMatches) {
      let arr = map.get(m.page);
      if (!arr) {
        arr = [];
        map.set(m.page, arr);
      }
      arr.push({ start: m.start, end: m.end });
    }
    return map;
  }, [searchMatches]);

  const activeMatch = searchIndex >= 0 ? searchMatches[searchIndex] : undefined;
  const baseDim = dims[0];
  const percent = Math.round(scale * 100);
  const ready = status === 'ready';

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: 'var(--bg-secondary)' }}>
      {/* Toolbar */}
      <div
        className="flex items-center gap-1 px-2 flex-shrink-0"
        style={{ height: '36px', borderBottom: '1px solid var(--border)', backgroundColor: 'var(--bg-primary)' }}
      >
        <ToolButton onClick={() => zoomTo(scale / ZOOM_STEP)} title={t('pdf.zoomOut')} disabled={!ready || scale <= ZOOM_MIN + 0.001}>
          <IconZoomOut />
        </ToolButton>
        <span className="text-[11px] text-center select-none" style={{ width: '42px', color: 'var(--text-secondary)' }}>
          {percent}%
        </span>
        <ToolButton onClick={() => zoomTo(scale * ZOOM_STEP)} title={t('pdf.zoomIn')} disabled={!ready || scale >= ZOOM_MAX - 0.001}>
          <IconZoomIn />
        </ToolButton>
        <ToolButton onClick={fitWidth} title={t('pdf.fitWidth')} disabled={!ready}>
          <IconFitWidth />
        </ToolButton>

        <span className="w-px h-4 mx-1" style={{ backgroundColor: 'var(--border)' }} />

        <input
          value={pageInput}
          onChange={(e) => setPageInput(e.target.value.replace(/[^\d]/g, ''))}
          onBlur={() => updateCurrentPage(currentPageRef.current)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const n = parseInt(pageInput, 10);
              if (!Number.isNaN(n)) scrollToPage(n);
              (e.target as HTMLInputElement).blur();
            }
          }}
          onFocus={(e) => e.currentTarget.select()}
          title={t('pdf.pageInput')}
          className="text-[11px] text-center rounded outline-none"
          style={{
            width: '38px',
            height: '20px',
            color: 'var(--text-primary)',
            backgroundColor: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
          }}
          disabled={!ready}
        />
        <span className="text-[11px] select-none" style={{ color: 'var(--text-tertiary)' }}>
          / {numPages || '–'}
        </span>

        <div className="flex-1" />

        {searchOpen ? (
          <div className="flex items-center gap-1">
            <div
              className="flex items-center gap-1 rounded px-2"
              style={{ height: '24px', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
            >
              <span style={{ color: 'var(--text-tertiary)', display: 'flex' }}><IconSearch /></span>
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (searchMatches.length) {
                      if (searching) return;
                      gotoMatch(searchIndex + (e.shiftKey ? -1 : 1));
                    }
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    closeSearch();
                  }
                }}
                placeholder={t('pdf.searchPlaceholder')}
                className="text-[11px] outline-none bg-transparent"
                style={{ width: '150px', color: 'var(--text-primary)' }}
              />
              <span className="text-[10px] select-none whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>
                {searching
                  ? t('pdf.searching')
                  : searchQuery.trim()
                    ? searchMatches.length
                      ? `${searchIndex + 1}/${searchMatches.length}`
                      : t('pdf.noMatches')
                    : ''}
              </span>
            </div>
            <ToolButton onClick={() => gotoMatch(searchIndex - 1)} title={t('pdf.prevMatch')} disabled={!searchMatches.length}>
              <IconChevronUp />
            </ToolButton>
            <ToolButton onClick={() => gotoMatch(searchIndex + 1)} title={t('pdf.nextMatch')} disabled={!searchMatches.length}>
              <IconChevronDown />
            </ToolButton>
            <ToolButton onClick={closeSearch} title={t('pdf.closeSearch')}>
              <IconCloseSmall />
            </ToolButton>
          </div>
        ) : (
          <ToolButton
            onClick={() => {
              setSearchOpen(true);
              requestAnimationFrame(() => searchInputRef.current?.focus());
            }}
            title={t('pdf.search')}
            disabled={!ready}
          >
            <IconSearch />
          </ToolButton>
        )}
      </div>

      {/* Pages */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        data-pdf-scroller=""
        className="flex-1 overflow-auto"
        style={{ position: 'relative', padding: `16px ${SIDE_PADDING / 2}px 32px` }}
      >
        {ready && baseDim && (
          <div
            style={{
              ['--total-scale-factor' as string]: String(scale),
              ['--scale-round-x' as string]: '1px',
              ['--scale-round-y' as string]: '1px',
            } as React.CSSProperties}
          >
            {Array.from({ length: numPages }, (_, i) => {
              const dim = dims[i] ?? baseDim;
              return (
                <div key={i} style={{ marginBottom: `${PAGE_GAP}px` }}>
                  <PdfPage
                    doc={docRef.current!}
                    pageNumber={i + 1}
                    scale={scale}
                    width={dim.width}
                    height={dim.height}
                    scrollRoot={containerRef}
                    getPageText={getPageText}
                    pageMatches={matchesByPage.get(i + 1) ?? EMPTY_MATCHES}
                    activeStart={
                      activeMatch && activeMatch.page === i + 1 ? activeMatch.start : null
                    }
                    registerRef={registerRef}
                  />
                </div>
              );
            })}
          </div>
        )}

        {status === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('pdf.loading')}</span>
          </div>
        )}
        {status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center px-8">
            <span className="text-xs text-center" style={{ color: 'var(--text-secondary)' }}>{errorMsg}</span>
          </div>
        )}
      </div>
    </div>
  );
}
