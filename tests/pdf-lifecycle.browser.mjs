import React from 'react';
import { createRoot } from 'react-dom/client';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { PdfPage } from '../src/components/pdf/PdfPage';
import { buildPageText } from '../src/components/pdf/pdfText';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export function fixturePdf({ pages = 1, width = 612, height = 792 } = {}) {
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (let i = 0; i < pages; i++) {
    const stream = `BT /F1 14 Tf 4 ${height - 32} Td (PDF lifecycle test page ${i + 1}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }
  let source = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(source.length);
    source += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(source);
}

export async function until(predicate, message) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(requestAnimationFrame);
  }
  throw new Error(message);
}

export async function testPdfPageLifecycle(scale = 1) {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0 auto auto 0;width:400px;height:360px;overflow:auto;background:white;z-index:99999';
  const mount = document.createElement('div');
  host.append(mount);
  document.body.append(host);
  const root = createRoot(mount);
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: fixturePdf(), standardFontDataUrl: '/pdfjs/standard_fonts/' }).promise;
    const page = await doc.getPage(1);
    const text = buildPageText(await page.getTextContent());
    root.render(React.createElement(React.Fragment, null,
      React.createElement(PdfPage, {
        doc, pageNumber: 1, scale, width: 612, height: 792,
        scrollRoot: { current: host }, getPageText: async () => text,
        pageMatches: [], activeStart: null, registerRef() {},
      }),
      React.createElement('div', { style: { height: '5000px' } }),
    ));
    await until(() => mount.querySelector('.textLayer span'), 'PDF text layer did not render');
    const canvas = mount.querySelector('canvas');
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    if (!pixels.some((value, i) => i % 4 !== 3 && value < 128)) throw new Error('PDF canvas contains no rendered text');
    const renderedPixels = canvas.width * canvas.height;
    if (renderedPixels > 8_000_000) throw new Error(`PDF canvas exceeded its pixel budget: ${renderedPixels}`);
    host.scrollTop = host.scrollHeight;
    await until(() => canvas.width === 0 && canvas.height === 0, 'Offscreen PDF page retained its bitmap');
    host.scrollTop = 0;
    await until(() => canvas.width > 0 && mount.querySelector('.textLayer span'), 'PDF page did not rerender after returning onscreen');
    return { passed: true, renderedPixels, offscreenBitmapReleased: true, restoredOnReturn: true };
  } finally {
    root.unmount();
    await doc?.destroy();
    host.remove();
  }
}
