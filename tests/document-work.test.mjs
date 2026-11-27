import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTypeScriptLoader } from './helpers/load-typescript.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function harness() {
  const writes = [];
  const load = createTypeScriptLoader({ window: new EventTarget(), setTimeout: () => 1, clearTimeout() {}, invoke: async (command, args) => {
    if (command === 'read_note') return { id: args.path, content: 'body', disk_version: 'body' };
    if (command === 'write_note') { writes.push(args.content); return args.content; }
    if (command === 'write_log' || command === 'write_logs') return;
    throw new Error(command);
  } });
  const { useNotesStore: store, createDocumentCloseHandler } = load(fileURLToPath(new URL('../src/stores/notes-store.ts', import.meta.url)));
  await store.getState().openTemporaryFile('C:/work/a.md');
  return { store, closeHandler: createDocumentCloseHandler, writes, identity: store.getState().getDocumentSession('C:/work/a.md').identity };
}

test('window close waits for an accepted image task and saves its resulting body', async () => {
  const h = await harness(), gate = deferred();
  const work = h.store.getState().runDocumentWork('C:/work/a.md', h.identity, 'image:1', async () => {
    await gate.promise;
    h.store.getState().updateContent('body with image', '');
  });
  let destroyed = false;
  const closing = h.closeHandler(async () => { destroyed = true; })({ preventDefault() {} });
  await tick();
  assert.equal(destroyed, false);
  gate.resolve();
  assert.equal(await work, true);
  await closing;
  assert.equal(h.writes.at(-1), 'body with image');
  assert.equal(destroyed, true);
});

test('failed annotation work keeps its draft and prevents close until a successful retry', async () => {
  const h = await harness();
  let fail = true, attempts = 0;
  assert.equal(await h.store.getState().runDocumentWork('C:/work/a.md', h.identity, 'annotation:1', async () => {
    attempts++;
    if (fail) throw new Error('annotation write failed');
  }, '[{"comment":"retained"}]'), false);
  assert.equal(h.store.getState().getDocumentWork('C:/work/a.md', 'annotation:').draft, '[{"comment":"retained"}]');
  assert.equal(h.store.getState().isDirty, true);
  await h.store.getState().closeTab('C:/work/a.md');
  assert.equal(h.store.getState().openTabs.length, 1);
  assert.equal(attempts, 2);
  fail = false;
  await h.store.getState().closeTab('C:/work/a.md');
  assert.equal(h.store.getState().openTabs.length, 0);
  assert.equal(attempts, 3);
});

test('path mutation waits for annotation persistence and cancellation preserves the document', async () => {
  const h = await harness(), gate = deferred();
  const work = h.store.getState().runDocumentWork('C:/work/a.md', h.identity, 'annotation:1', () => gate.promise);
  let moved = false;
  const move = h.store.getState().withDocumentPathChange('C:/work/a.md', false, async () => { moved = true; });
  await tick();
  assert.equal(moved, false);
  gate.reject(new Error('disk full'));
  assert.equal(await work, false);
  assert.equal(await move, false);
  assert.equal(moved, false);
  assert.equal(h.store.getState().activeContent, 'body');
});

test('new document work is rejected after close or when its identity is stale', async () => {
  const h = await harness();
  let ran = false;
  assert.equal(await h.store.getState().runDocumentWork('C:/work/a.md', h.identity + 1, 'image:1', async () => { ran = true; }), false);
  h.store.getState().setClosing('draining');
  assert.equal(await h.store.getState().runDocumentWork('C:/work/a.md', h.identity, 'image:2', async () => { ran = true; }), false);
  assert.equal(ran, false);
  h.store.getState().setClosing(null);
});

test('a different annotation action cannot discard an earlier failed accepted change', async () => {
  const h = await harness();
  await h.store.getState().runDocumentWork('C:/work/a.md', h.identity, 'annotation:add', async () => { throw new Error('failed'); }, 'original draft');
  let ran = false;
  assert.equal(await h.store.getState().runDocumentWork('C:/work/a.md', h.identity, 'annotation:delete', async () => { ran = true; }, 'other draft'), false);
  assert.equal(ran, false);
  assert.equal(h.store.getState().getDocumentWork('C:/work/a.md', 'annotation:').draft, 'original draft');
});
