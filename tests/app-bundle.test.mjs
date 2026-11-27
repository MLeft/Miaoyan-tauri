import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the application entry does not load editor or PDF bundles before they are needed', async (t) => {
  const output = await mkdtemp(path.join(tmpdir(), 'miaoyan-app-bundle-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const warnings = [];
  await build({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'silent', build: {
    outDir: output, emptyOutDir: false, manifest: true,
    rollupOptions: {
      onwarn: warning => warnings.push(warning),
      plugins: [{ name: 'verify-eager-modules', generateBundle(_options, bundle) {
        const seen = new Set();
        const visit = chunk => {
          if (seen.has(chunk.fileName)) return;
          seen.add(chunk.fileName);
          for (const id of Object.keys(chunk.modules)) assert.doesNotMatch(id, /node_modules\/(?:@codemirror|@lezer|pdfjs-dist)\//, `Eager editor/PDF module: ${id}`);
          for (const name of chunk.imports) if (bundle[name]?.type === 'chunk') visit(bundle[name]);
        };
        for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk' && chunk.isEntry) visit(chunk);
      } }],
    },
  } });
  assert.deepEqual(warnings.filter(warning => warning.code === 'CIRCULAR_CHUNK').map(warning => warning.message), []);
  const manifest = JSON.parse(await readFile(path.join(output, '.vite/manifest.json'), 'utf8'));
  const seen = new Set();
  const visit = (key) => {
    if (seen.has(key)) return;
    seen.add(key);
    const entry = manifest[key];
    assert.ok(entry, `Missing build manifest entry: ${key}`);
    assert.doesNotMatch(entry.file, /vendor-(?:pdfjs|codemirror)/);
    for (const css of entry.css ?? []) assert.doesNotMatch(css, /vendor-pdfjs/);
    for (const imported of entry.imports ?? []) visit(imported);
  };
  visit('index.html');
  const deferred = manifest['index.html'].dynamicImports.map(key => manifest[key]);
  assert.ok(deferred.some(entry => entry.name === 'PdfViewer' && entry.isDynamicEntry));
  assert.ok(deferred.some(entry => entry.name === 'Editor' && entry.isDynamicEntry));
});
