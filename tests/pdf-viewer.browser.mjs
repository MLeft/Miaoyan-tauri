import React from 'react';
import { createRoot } from 'react-dom/client';
import { PdfViewer } from '../src/components/pdf/PdfViewer';
import { fixturePdf, until } from './pdf-lifecycle.browser.mjs';
import '../src/i18n';
import '../src/styles/globals.css';

export async function testPdfViewerFirstFrameAndRestore() {
  const mount = document.createElement('div');
  mount.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px;z-index:99999';
  document.body.append(mount);
  const url = URL.createObjectURL(new Blob([fixturePdf({ pages: 40 })], { type: 'application/pdf' }));
  const path = `fixture-${crypto.randomUUID()}.pdf`;
  const previousTauri = window.__TAURI_INTERNALS__;
  window.__TAURI_INTERNALS__ = {
    ...previousTauri,
    convertFileSrc(file) {
      if (file !== path) throw new Error('Unexpected file access in PDF fixture');
      return url;
    },
  };
  let root = createRoot(mount);
  let readyWithoutPages = false;
  const observer = new MutationObserver(() => {
    const pageInput = mount.querySelector('input');
    if (pageInput && !pageInput.disabled && !mount.querySelector('canvas')) readyWithoutPages = true;
  });
  observer.observe(mount, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
  try {
    root.render(React.createElement(PdfViewer, { path }));
    await until(() => mount.querySelectorAll('canvas').length === 40 && mount.querySelector('.textLayer span'), 'PDF viewer did not render its pages');
    const scroller = mount.querySelector('.overflow-auto');
    scroller.scrollTop = 6000;
    await until(() => Number(mount.querySelector('input')?.value) > 1, 'PDF did not track the scrolled page');
    const savedScrollTop = scroller.scrollTop;
    root.unmount();
    root = createRoot(mount);
    root.render(React.createElement(PdfViewer, { path }));
    await until(() => mount.querySelectorAll('canvas').length === 40, 'Reopened PDF did not render page placeholders');
    let restored = true;
    try {
      await until(() => Math.abs(mount.querySelector('.overflow-auto').scrollTop - savedScrollTop) < 2, 'PDF restored scroll before page layout existed');
    } catch { restored = false; }
    if (readyWithoutPages || !restored) {
      throw new Error(JSON.stringify({ readyWithoutPages, restored, savedScrollTop, actualScrollTop: mount.querySelector('.overflow-auto').scrollTop }));
    }
    return { passed: true, readyWithoutPages, restored, scrollTop: savedScrollTop };
  } finally {
    observer.disconnect();
    root.unmount();
    mount.remove();
    URL.revokeObjectURL(url);
    if (previousTauri === undefined) delete window.__TAURI_INTERNALS__;
    else window.__TAURI_INTERNALS__ = previousTauri;
  }
}
