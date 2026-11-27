import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTypeScriptLoader } from './helpers/load-typescript.mjs';

const source = fileURLToPath(new URL('../src/services/render-safety.ts', import.meta.url));
const load = createTypeScriptLoader({ window: {}, setTimeout, clearTimeout });
const safety = load.functions(source, ['samePreviewScope', 'currentPreviewDocument', 'validPreviewMessage', 'safeExternalUrl', 'togglePreviewTask'], { URL });
const scope = { path: 'C:/synthetic/a.md', identity: 1, revision: 2, generation: 3 };

test('preview scopes reject path, session, revision and generation ABA', () => {
  assert.equal(safety.samePreviewScope(scope, { ...scope }), true);
  for (const key of Object.keys(scope)) assert.equal(safety.samePreviewScope(scope, { ...scope, [key]: key === 'path' ? 'other' : 99 }), false);
  assert.equal(safety.currentPreviewDocument(scope, scope, scope.path), true);
  assert.equal(safety.currentPreviewDocument(scope, { ...scope, revision: 3 }, scope.path), false);
  assert.equal(safety.currentPreviewDocument(scope, { ...scope, identity: 2 }, scope.path), false);
  assert.equal(safety.currentPreviewDocument(scope, scope, 'other'), false);
});
test('renderer message schema rejects wrong types, unbounded text and unsafe links', () => {
  for (const value of [null, 'x', {}, { type: 'checkbox-toggle', index: '1' }, { type: 'checkbox-toggle', index: -1 },
    { type: 'previewScroll', line: Infinity }, { type: 'annotation-selection', quote: {}, heading: '', paragraphIndex: 0 },
    { type: 'plantuml-request', source: 'x'.repeat(100001), index: 0 }, { type: 'open-link', url: 'javascript:alert(1)' },
    { type: 'open-link', url: 'file:///C:/synthetic' }, { type: 'open-link', url: 'tauri://localhost' }]) {
    assert.equal(safety.validPreviewMessage(value), false, JSON.stringify(value)?.slice(0, 120));
  }
  assert.equal(safety.validPreviewMessage({ type: 'checkbox-toggle', index: 0 }), true);
  assert.equal(safety.validPreviewMessage({ type: 'open-link', url: 'https://example.invalid/a' }), true);
});
test('task updates ignore fenced examples and support ordinary task markers', () => {
  const body = '```md\n- [ ] example\n```\n- [ ] first\n+ [X] second\n1. [ ] third';
  assert.equal(safety.togglePreviewTask(body, 0), body.replace('- [ ] first', '- [x] first'));
  assert.equal(safety.togglePreviewTask(body, 1), body.replace('+ [X] second', '+ [ ] second'));
  assert.equal(safety.togglePreviewTask(body, 2), body.replace('1. [ ] third', '1. [x] third'));
  assert.equal(safety.togglePreviewTask(body, 3), null);
  assert.equal(safety.togglePreviewTask(body, NaN), null);
});
function diagrams() {
  const context = vm.createContext({ window: {}, console });
  vm.runInContext(readFileSync(new URL('../public/js/diagram-handler.js', import.meta.url), 'utf8'), context);
  return context.window.DiagramHandler;
}
test('Mermaid LRU uses complete keys and refreshes recency on hits', () => {
  const d = diagrams();
  // Aa and BB collide under the previous 32-bit rolling hash.
  d.cacheSvg(JSON.stringify([false, 'Aa']), 'one');
  d.cacheSvg(JSON.stringify([false, 'BB']), 'two');
  d.cacheSvg(JSON.stringify([true, 'Aa']), 'dark');
  assert.equal(d.cachedSvg(JSON.stringify([false, 'Aa'])), 'one');
  assert.equal(d.cachedSvg(JSON.stringify([false, 'BB'])), 'two');
  assert.equal(d.cachedSvg(JSON.stringify([true, 'Aa'])), 'dark');
  for (let i = 0; i < 125; i++) d.cacheSvg(`entry-${i}`, 'svg');
  d.cachedSvg(JSON.stringify([false, 'Aa']));
  d.cacheSvg('new', 'svg');
  assert.equal(d.cachedSvg(JSON.stringify([false, 'BB'])), undefined);
  assert.equal(d.cachedSvg(JSON.stringify([false, 'Aa'])), 'one');
  assert.equal(d._svgCache.size, 128);
});
test('Mermaid cache budgets count full source and SVG; oversized entries bypass it', () => {
  const d = diagrams();
  for (let i = 0; i < 100; i++) d.cacheSvg(String(i) + 's'.repeat(10000), 'v'.repeat(30000));
  assert.ok(d._cacheChars <= 2000000);
  assert.equal(d._cacheChars, [...d._svgCache].reduce((n, [k, v]) => n + k.length + v.length, 0));
  const size = d._svgCache.size;
  d.cacheSvg('giant', 'v'.repeat(250001));
  assert.equal(d._svgCache.size, size);
  assert.equal(d.cachedSvg('giant'), undefined);
});
