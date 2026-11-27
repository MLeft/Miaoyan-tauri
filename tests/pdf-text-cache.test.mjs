import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTypeScriptLoader } from './helpers/load-typescript.mjs';

const load = createTypeScriptLoader({ setTimeout, clearTimeout, window: {} });
const { PdfTextCache } = load(fileURLToPath(new URL('../src/components/pdf/pdfText.ts', import.meta.url)));
const pageText = (text) => ({ text, strs: [text], starts: [0], content: { items: [], styles: {}, lang: null } });

test('PDF page text cache evicts least recently used pages', async () => {
  const cache = new PdfTextCache();
  let reads = 0;
  const read = async () => pageText(String(++reads));
  for (let page = 1; page <= 32; page++) await cache.get(page, read);
  assert.equal((await cache.get(1, read)).text, '1');
  await cache.get(33, read);
  assert.equal((await cache.get(1, read)).text, '1');
  assert.equal((await cache.get(2, read)).text, '34');
});

test('PDF page text cache shares concurrent reads of the same page', async () => {
  const cache = new PdfTextCache();
  let reads = 0;
  const read = async () => pageText(String(++reads));
  const first = cache.get(1, read);
  const second = cache.get(1, read);
  assert.equal((await first).text, '1');
  assert.equal((await second).text, '1');
  assert.equal(reads, 1);
});

test('PDF text requests stay deduplicated while more than a cacheful are pending', async () => {
  const cache = new PdfTextCache();
  const resolvers = [];
  let reads = 0;
  const read = () => new Promise((resolve) => { reads++; resolvers.push(resolve); });
  const pending = Array.from({ length: 33 }, (_, i) => cache.get(i + 1, read));
  await Promise.resolve();
  const repeated = cache.get(1, read);
  try {
    assert.equal(repeated, pending[0]);
    assert.equal(reads, 33);
  } finally {
    for (const resolve of resolvers) resolve(pageText('loaded'));
  }
  assert.equal((await repeated).text, 'loaded');
});

test('PDF page text cache permits retry after a failed text read', async () => {
  const cache = new PdfTextCache();
  await assert.rejects(cache.get(1, async () => { throw new Error('read failed'); }), /read failed/);
  assert.equal((await cache.get(1, async () => pageText('recovered'))).text, 'recovered');
});

test('PDF page text cache evicts by total character budget as well as page count', async () => {
  const cache = new PdfTextCache();
  await cache.get(1, async () => pageText('a'.repeat(1_100_000)));
  await cache.get(2, async () => pageText('b'.repeat(1_100_000)));
  assert.equal((await cache.get(1, async () => pageText('reloaded'))).text, 'reloaded');
});

test('an oversized PDF page is returned without retaining it in the text cache', async () => {
  const cache = new PdfTextCache();
  await cache.get(1, async () => pageText('a'.repeat(2_000_001)));
  assert.equal((await cache.get(1, async () => pageText('reloaded'))).text, 'reloaded');
});

test('clearing a PDF text cache isolates late results from a new document', async () => {
  const cache = new PdfTextCache();
  let resolveOld;
  const old = cache.get(1, () => new Promise((resolve) => { resolveOld = resolve; }));
  await Promise.resolve();
  cache.clear();
  const current = await cache.get(1, async () => pageText('current'));
  resolveOld(pageText('old'));
  await old;
  assert.equal((await cache.get(1, async () => pageText('unexpected'))).text, current.text);
});
