import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTypeScriptLoader } from './helpers/load-typescript.mjs';

const source = (file) => fileURLToPath(new URL(`../src/${file}`, import.meta.url));
async function harness() {
  const window = new EventTarget();
  const toasts = [];
  let release, reject, calls = 0;
  const pending = new Promise((yes, no) => { release = yes; reject = no; });
  const load = createTypeScriptLoader({ window, setTimeout: () => 1, clearTimeout() {}, invoke: async (command, args) => {
    if (command === 'read_note') return { id: args.path, content: args.path === 'A.md' ? 'alpha' : 'bravo', disk_version: 'fixture' };
    if (command === 'write_note' || command === 'write_log') return;
    throw new Error(`Unexpected command: ${command}`);
  } });
  const store = load(source('stores/notes-store.ts')).useNotesStore;
  const settings = load(source('stores/settings-store.ts')).useSettingsStore;
  settings.setState(state => ({ config: { ...state.config, auto_save_interval: 0 } }));
  const { handleFormat } = load.functions(source('App.tsx'), ['handleFormat'], {
    useNotesStore: store, useSettingsStore: settings,
    formatMarkdown: () => { calls++; return pending; },
    formatInFlight: { current: new Set() },
    formatMessages: { en: { busy: 'Formatting', done: 'Formatted', changed: 'Changed', failed: 'Format failed' } },
    isPdfPath: path => path.endsWith('.pdf'),
    showToastEvent: (message, busy = false, type = 'success') => toasts.push({ message, busy, type }),
    setToastMessage() {}, setToastType: type => toasts.push({ type }), setToastVisible() {},
  });
  await store.getState().openTemporaryFile('A.md');
  return { store, format: handleFormat, release, reject, calls: () => calls, toasts };
}

test('formatting applies to its original document without overwriting a newer active tab', async () => {
  const h = await harness();
  const formatting = h.format();
  await h.store.getState().openTemporaryFile('B.md');
  h.release('formatted alpha');
  await formatting;
  assert.equal(h.store.getState().activeContent, 'bravo');
  assert.equal(h.store.getState().getDocumentSession('A.md').content, 'formatted alpha');
});

test('formatting cannot overwrite edits made while the formatter is running', async () => {
  const h = await harness();
  const formatting = h.format();
  h.store.getState().updateContent('new user edits', '');
  h.release('formatted alpha');
  await formatting;
  assert.equal(h.store.getState().activeContent, 'new user edits');
  assert.equal(h.toasts.at(-1).type, 'warning');
});

test('repeated format commands share the existing work for the document', async () => {
  const h = await harness();
  const first = h.format(), second = h.format();
  try { assert.equal(h.calls(), 1); }
  finally { h.release('formatted alpha'); await Promise.all([first, second]); }
});

test('formatter failures are visible and do not leave a busy notification', async () => {
  const h = await harness();
  const formatting = h.format();
  h.reject(new Error('parser unavailable'));
  await formatting;
  assert.equal(h.toasts.at(-1)?.type, 'warning');
  assert.equal(h.toasts.at(-1)?.busy, false);
  assert.equal(h.store.getState().activeContent, 'alpha');
});
