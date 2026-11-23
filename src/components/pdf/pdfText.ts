import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;

// 页面文本缓存：strs 与 TextLayer.textDivs 一一对齐（跳过无 str 的标记项）
export interface PageText {
  content: TextContent;
  strs: string[];
  starts: number[];
  text: string;
}

export interface SearchMatch {
  page: number;
  start: number;
  end: number;
}

export interface HighlightRect {
  x: number;
  y: number;
  w: number;
  h: number;
  active: boolean;
}

export function buildPageText(content: TextContent): PageText {
  const strs: string[] = [];
  const starts: number[] = [];
  let text = '';
  for (const item of content.items as Array<{ str?: string }>) {
    if (typeof item.str !== 'string') continue;
    strs.push(item.str);
    starts.push(text.length);
    text += item.str;
  }
  return { content, strs, starts, text };
}

export function findMatchesInText(page: number, text: string, queryLower: string): SearchMatch[] {
  const out: SearchMatch[] = [];
  if (!queryLower) return out;
  const haystack = text.toLowerCase();
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(queryLower, from);
    if (idx < 0) break;
    out.push({ page, start: idx, end: idx + queryLower.length });
    from = idx + Math.max(1, queryLower.length);
  }
  return out;
}

/**
 * 用已渲染文本层的 span 反推命中区域的设备像素矩形。
 * 比用 item.transform 推算更准：pdf.js 会通过 --scale-x 对 span 做视觉缩放，
 * offsetWidth 是缩放前的排版宽度，需要乘回 scaleX。
 */
export function computeHighlightRects(
  strs: string[],
  spans: HTMLElement[],
  matches: Array<{ start: number; end: number }>,
  activeStart: number | null
): HighlightRect[] {
  if (!matches.length) return [];
  const rects: HighlightRect[] = [];
  let offset = 0;
  for (let i = 0; i < strs.length; i++) {
    const s = strs[i];
    const itemStart = offset;
    const itemEnd = offset + s.length;
    offset = itemEnd;
    if (!s.length) continue;
    const overlapping = matches.filter((m) => m.start < itemEnd && m.end > itemStart);
    if (!overlapping.length) continue;
    const span = spans[i];
    if (!span) continue;
    const scaleX = parseFloat(span.style.getPropertyValue('--scale-x')) || 1;
    const width = span.offsetWidth * scaleX;
    const height = span.offsetHeight;
    const left = span.offsetLeft;
    const top = span.offsetTop;
    for (const m of overlapping) {
      const localStart = Math.max(m.start, itemStart) - itemStart;
      const localEnd = Math.min(m.end, itemEnd) - itemStart;
      rects.push({
        x: left + (localStart / s.length) * width,
        y: top,
        w: Math.max(2, ((localEnd - localStart) / s.length) * width),
        h: height,
        active: m.start === activeStart,
      });
    }
  }
  return rects;
}
