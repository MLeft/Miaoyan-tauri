import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTypeScriptLoader } from './helpers/load-typescript.mjs';

async function harness() {
  const writes = [];
  const load = createTypeScriptLoader({ window: new EventTarget(), setTimeout: () => 1, clearTimeout() {}, invoke: async (command, args) => {
    if (command === 'read_note') return { id: args.path, content: 'original', disk_version: 'original' };
    if (command === 'write_note') { writes.push(args); return args.content; }
    if (command === 'write_log' || command === 'write_logs') return;
    throw new Error(command);
  } });
  const store = load(fileURLToPath(new URL('../src/stores/notes-store.ts', import.meta.url))).useNotesStore;
  await store.getState().openTemporaryFile('C:/library/a.md');
  return { store, writes };
}

test('pending recovery seals edits and saves until explicitly cleared', async () => {
  const { store, writes } = await harness();
  store.getState().updateContent('recoverable draft', '');
  store.getState().setRecoveryPaths(['C:/library/a.md']);
  assert.equal(store.getState().activeDocumentReadOnly, true);
  assert.equal(store.getState().isDocumentWritable('C:/library/a.md'), false);
  store.getState().updateContent('must not enter', '');
  assert.equal(store.getState().activeContent, 'recoverable draft');
  assert.equal(await store.getState().saveCurrentNote(), false);
  await store.getState().closeTab('C:/library/a.md');
  assert.equal(store.getState().openTabs.length, 1);
  assert.equal(writes.length, 0);
  store.getState().setRecoveryPaths([]);
  assert.equal(store.getState().activeDocumentReadOnly, false);
  assert.equal(await store.getState().saveCurrentNote(), true);
  assert.equal(writes[0].content, 'recoverable draft');
});

test('recovery scope is component-aware and understands Windows extended paths', async () => {
  const { store } = await harness();
  store.getState().setRecoveryPaths(['C:/library/ab.md']);
  assert.equal(store.getState().activeDocumentReadOnly, false);
  store.getState().setRecoveryPaths(['\\\\?\\C:\\library']);
  assert.equal(store.getState().activeDocumentReadOnly, true);
});
