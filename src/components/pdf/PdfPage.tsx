import { memo, useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { computeHighlightRects } from './pdfText';
import type { HighlightRect, PageText } from './pdfText';

interface PdfPageProps {
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  width: number;  // viewport width at scale 1
  height: number;
  scrollRoot: React.RefObject<HTMLDivElement | null>;
  getPageText: (pageNumber: number) => Promise<PageText>;
  pageMatches: Array<{ start: number; end: number }>;
  activeStart: number | null;
  registerRef: (pageNumber: number, el: HTMLDivElement | null) => void;
}

function PdfPageInner({
  doc, pageNumber, scale, width, height, scrollRoot,
  getPageText, pageMatches, activeStart, registerRef,
}: PdfPageProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerContainerRef = useRef<HTMLDivElement | null>(null);
  const textLayerRef = useRef<pdfjsLib.TextLayer | null>(null);
  const strsRef = useRef<string[]>([]);
  const [visible, setVisible] = useState(false);
  const [renderedTick, setRenderedTick] = useState(0);
  const [rects, setRects] = useState<HighlightRect[]>([]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => setVisible(entries[0]?.isIntersecting ?? false),
      { root: scrollRoot.current, rootMargin: '1200px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [scrollRoot]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;
    let textLayer: pdfjsLib.TextLayer | null = null;

    (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
        renderTask = page.render({
          canvas,
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        await renderTask.promise;
        if (cancelled) return;

        const pt = await getPageText(pageNumber);
        if (cancelled) return;
        strsRef.current = pt.strs;
        const container = textLayerContainerRef.current;
        if (container) {
          container.style.setProperty('--total-scale-factor', String(scale));
          container.replaceChildren();
          textLayer = new pdfjsLib.TextLayer({
            textContentSource: pt.content,
            container,
            viewport,
          });
          textLayerRef.current = textLayer;
          await textLayer.render();
        }
        if (!cancelled) setRenderedTick((t) => t + 1);
      } catch (e) {
        const name = (e as { name?: string })?.name;
        if (!cancelled && name !== 'RenderingCancelledException' && name !== 'AbortException') {
          console.error(`PDF page ${pageNumber} render failed:`, e);
        }
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      textLayerRef.current = null;
      textLayerContainerRef.current?.replaceChildren();
      setRects([]);
    };
  }, [visible, doc, pageNumber, scale, getPageText]);

  useEffect(() => {
    const tl = textLayerRef.current;
    if (!renderedTick || !tl || !pageMatches.length) {
      setRects([]);
      return;
    }
    setRects(computeHighlightRects(strsRef.current, tl.textDivs, pageMatches, activeStart));
  }, [renderedTick, pageMatches, activeStart]);

  return (
    <div
      ref={(el) => {
        wrapRef.current = el;
        registerRef(pageNumber, el);
      }}
      style={{
        width: `${Math.max(1, Math.round(width * scale))}px`,
        height: `${Math.max(1, Math.round(height * scale))}px`,
        position: 'relative',
        margin: '0 auto',
        backgroundColor: '#ffffff',
        boxShadow: '0 1px 4px rgba(0, 0, 0, 0.18)',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' }}
      />
      {rects.map((r, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: `${r.x}px`,
            top: `${r.y}px`,
            width: `${r.w}px`,
            height: `${r.h}px`,
            backgroundColor: r.active ? 'rgba(255, 145, 0, 0.5)' : 'rgba(255, 214, 0, 0.38)',
            mixBlendMode: 'multiply',
            pointerEvents: 'none',
            zIndex: 0,
          }}
        />
      ))}
      <div ref={textLayerContainerRef} className="textLayer" style={{ zIndex: 1 }} />
    </div>
  );
}

export const PdfPage = memo(PdfPageInner, (a, b) =>
  a.doc === b.doc &&
  a.pageNumber === b.pageNumber &&
  a.scale === b.scale &&
  a.width === b.width &&
  a.height === b.height &&
  a.pageMatches === b.pageMatches &&
  a.activeStart === b.activeStart &&
  a.getPageText === b.getPageText &&
  a.registerRef === b.registerRef
);
