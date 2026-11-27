import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));

test('production PDF assets are available at the viewer runtime URLs', async (t) => {
  const output = await mkdtemp(path.join(tmpdir(), 'miaoyan-pdf-assets-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  await build({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    logLevel: 'silent',
    plugins: [{
      name: 'pdf-asset-test-entry',
      resolveId(id) { if (id === 'virtual:pdf-asset-test') return '\0pdf-asset-test'; },
      load(id) { if (id === '\0pdf-asset-test') return 'export const fixture = true;'; },
    }],
    build: {
      outDir: output,
      emptyOutDir: false,
      rollupOptions: { input: 'virtual:pdf-asset-test' },
    },
  });

  for (const resource of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    const directory = path.join(output, 'pdfjs', resource);
    const files = await readdir(directory);
    assert.ok(files.length > 0, `${resource} must contain runtime resources`);
    assert.ok((await stat(path.join(directory, files[0]))).size > 0);
  }
});
