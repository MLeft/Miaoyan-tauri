import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createTypeScriptLoader } from './helpers/load-typescript.mjs';

const A = 'C:/isolated/A.md';
const B = 'C:/isolated/B.md';
const C = 'C:/isolated/C.md';
const E = 'C:/isolated/secret.md.encrypted';
const key = (path) => path.replace(/\\/g, '/').toLowerCase();
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function note(path) {
  return { id: path, path, title: path.split('/').pop(), folder: 'C:/isolated',
    created_at: '2026-01-01T00:00:00Z', modified_at: '2026-01-01T00:00:00Z',
    pinned: false, size: 4, is_encrypted: path.endsWith('.encrypted') };
}
function harness() {
  const disk = new Map([[key(A), 'alpha'], [key(B), 'bravo'], [key(C), 'charlie']]);
  const reads = new Map(), writes = new Map(), failures = new Set(), calls = [];
  const timers = new Map();
  let now = 0, timerId = 0;
  const window = new EventTarget();
  const toasts = [];
  window.addEventListener('show-toast', e => toasts.push(e.detail));
  const invoke = async (command, args = {}) => {
    calls.push({ command, ...args });
    if (command === 'write_log' || command === 'save_config') return;
    if (command === 'read_note' || command === 'decrypt_note') {
      const held = reads.get(key(args.path))?.shift();
      if (held) return held.promise;
      if (!disk.has(key(args.path))) throw new Error('isolated file missing');
      return { id: args.path, content: disk.get(key(args.path)), disk_version: disk.get(key(args.path)) };
    }
    if (command === 'save_document_copy') {
      if (disk.has(key(args.targetPath))) throw new Error('Destination exists');
      disk.set(key(args.targetPath), args.content);
      return { id: args.targetPath, content: args.content, disk_version: args.content };
    }
    if (command === 'write_note' || command === 'save_encrypted_note') {
      const held = writes.get(key(args.path))?.shift();
      if (held) await held.promise;
      if (failures.has(key(args.path))) throw new Error('isolated disk full');
      if (args.expectedVersion !== disk.get(key(args.path))) throw { code: 'DiskConflict', message: 'File changed on disk', paths: [args.path] };
      disk.set(key(args.path), args.content);
      return args.content;
    }
    throw new Error(`Unexpected Tauri command: ${command}`);
  };
  const load = createTypeScriptLoader({ invoke, window,
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const notesModule = load(fileURLToPath(new URL('../src/stores/notes-store.ts', import.meta.url)));
  const store = notesModule.useNotesStore;
  const settings = load(fileURLToPath(new URL('../src/stores/settings-store.ts', import.meta.url))).useSettingsStore;
  const editor = load(fileURLToPath(new URL('../src/stores/editor-store.ts', import.meta.url))).useEditorStore;
  const hold = (map, path) => { const d = deferred(); const k = key(path); map.set(k, [...(map.get(k) || []), d]); return d; };
  return { store, settings, editor, disk, calls, toasts,
    createCloseHandler: notesModule.createDocumentCloseHandler,
    s: () => store.getState(),
    open: path => store.getState().selectNote(note(path)),
    edit: content => store.getState().updateContent(content, ''),
    holdRead: path => hold(reads, path), holdWrite: path => hold(writes, path),
    fail: path => failures.add(key(path)), recover: path => failures.delete(key(path)),
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now && timers.delete(id)) timer.fn();
      }
      await tick();
    },
  };
}
function tab(h, path) { return h.s().openTabs.find(t => key(t.path) === key(path)); }
function assertActive(h, path, content) {
  assert.equal(h.s().activeTabPath, path);
  assert.equal(h.s().activeNote?.path ?? null, path);
  assert.equal(h.s().activeContent, content);
}
function session(h, path) {
  assert.equal(typeof h.s().getDocumentSession, 'function', 'typed session snapshot action must exist');
  return h.s().getDocumentSession(path);
}
function unlock(h, path, content = 'secret', password = 'test-only-password', requestId = h.s().encryptionDialog?.requestId) {
  return h.s().onNoteUnlocked(path, { id: path, content, disk_version: h.disk.get(key(path)) }, password, requestId);
}

test('late A read cannot steal the active B document', async () => {
  const h = harness(), read = h.holdRead(A);
  const opening = h.open(A);
  await h.open(B);
  read.resolve({ id: A, content: 'late alpha' });
  await opening;
  assertActive(h, B, 'bravo');
  assert.equal(h.s().isLoading, false);
});

test('overlapping opens of the same path create only one tab', async () => {
  const h = harness(), first = h.holdRead(A), second = h.holdRead(A);
  const one = h.open(A), two = h.open(A);
  first.resolve({ id: A, content: 'alpha' }); second.resolve({ id: A, content: 'alpha' });
  await Promise.all([one, two]);
  assert.equal(h.s().openTabs.length, 1);
  assertActive(h, A, 'alpha');
});

test('switch keeps draft immediately and does not wait for the disk', async () => {
  const h = harness(); await h.open(A); await h.open(B); await h.s().switchTab(A);
  h.edit('alpha draft'); const write = h.holdWrite(A);
  const switching = h.s().switchTab(B);
  await tick();
  assertActive(h, B, 'bravo');
  assert.equal(tab(h, A).content, 'alpha draft');
  assert.equal(tab(h, A).isDirty, true);
  await h.s().switchTab(A);
  assertActive(h, A, 'alpha draft');
  write.resolve(); await switching; await tick();
});

test('external changes keep the local draft dirty and prevent close or repeated save from overwriting disk', async () => {
  const h = harness(); await h.open(A); h.edit('local draft');
  h.disk.set(key(A), 'external content');
  assert.equal(await h.s().saveCurrentNote(), false);
  await h.s().closeTab(A);
  assert.equal(h.s().activeContent, 'local draft');
  assert.equal(h.s().isDirty, true);
  assert.equal(h.disk.get(key(A)), 'external content');
});

test('a recovery copy preserves a failed original draft and permits explicit discard without writing it', async () => {
  const h = harness(); await h.open(A); h.edit('local recovery draft');
  h.disk.set(key(A), 'external body'); await h.s().saveCurrentNote();
  const original = session(h, A), target = 'C:/isolated/recovered.md';
  assert.equal(await h.s().saveDocumentCopy(A, original.identity, target), true);
  assert.equal(h.disk.get(key(target)), 'local recovery draft');
  assert.equal(h.disk.get(key(A)), 'external body');
  assert.equal(session(h, A).isDirty, true);
  assert.equal(session(h, target).isDirty, false);
  assert.equal(h.s().discardDocument(A, original.identity + 1), false);
  const before = h.calls.filter(call => call.command === 'write_note').length;
  assert.equal(h.s().discardDocument(A, original.identity), true);
  assert.equal(h.calls.filter(call => call.command === 'write_note').length, before);
  await h.open(A); assert.equal(h.s().activeContent, 'external body');
});

test('explicit discard rejects pending accepted writes and later edits', async () => {
  const h = harness(); await h.open(A); h.edit('first');
  const snapshot = session(h, A), held = h.holdWrite(A), saving = h.s().saveCurrentNote(); await tick();
  assert.equal(h.s().discardDocument(A, snapshot.identity, snapshot.revision), false);
  held.resolve(); await saving;
  h.edit('second');
  assert.equal(h.s().discardDocument(A, snapshot.identity, snapshot.revision), false);
  assert.equal(h.s().activeContent, 'second');
});

test('first edit updates dirty dot, later keystrokes keep the tab array stable', async () => {
  const h = harness(); await h.open(A);
  const clean = h.s().openTabs;
  h.edit('one');
  assert.equal(tab(h, A).isDirty, true);
  assert.notEqual(h.s().openTabs, clean);
  const dirty = h.s().openTabs;
  h.edit('two');
  assert.equal(h.s().openTabs, dirty);
  assertActive(h, A, 'two');
  assert.equal(tab(h, A).content, 'two');
});

test('older save completion cannot clear newer edits and writes drain serially', async () => {
  const h = harness(); await h.open(A); h.edit('revision one');
  const first = h.holdWrite(A), second = h.holdWrite(A);
  const saving = h.s().saveCurrentNote(); await tick();
  h.edit('revision two');
  const sameDrain = h.s().saveCurrentNote(); await tick();
  first.resolve(); await tick();
  assertActive(h, A, 'revision two');
  assert.equal(h.s().isDirty, true);
  assert.equal(tab(h, A).isDirty, true);
  assert.equal(h.disk.get(key(A)), 'revision one');
  const state = session(h, A);
  assert.ok(state.savedRevision < state.revision);
  second.resolve(); await Promise.all([saving, sameDrain]);
  assert.equal(h.disk.get(key(A)), 'revision two');
  assert.equal(h.s().isDirty, false);
  assert.equal(session(h, A).savedRevision, session(h, A).revision);
});

test('background save completion does not mark the newly active document clean', async () => {
  const h = harness(); await h.open(A); await h.open(B); await h.s().switchTab(A);
  h.edit('A draft'); const write = h.holdWrite(A);
  const saving = h.s().saveCurrentNote();
  h.s().switchTab(B); await tick();
  assertActive(h, B, 'bravo');
  h.edit('B draft'); write.resolve(); await saving; await tick();
  assertActive(h, B, 'B draft'); assert.equal(h.s().isDirty, true);
  assert.equal(tab(h, B).isDirty, true);
});

test('external open hands off draft and reopening it does not replace the session', async () => {
  const h = harness(); await h.open(A); h.edit('unsaved alpha');
  h.fail(A);
  await h.s().openTemporaryFile(B); await tick();
  assertActive(h, B, 'bravo'); assert.equal(h.s().isDirty, false);
  await h.s().switchTab(A);
  assertActive(h, A, 'unsaved alpha'); assert.equal(h.s().isDirty, true);
  await h.s().openTemporaryFile(A);
  assertActive(h, A, 'unsaved alpha'); assert.equal(h.s().openTabs.length, 2);
  assert.equal(session(h, A).saveStatus, 'error');
  assert.ok(h.toasts.some(t => t.type === 'warning'));
});

test('encrypted selection never mixes the previous tab with plaintext on unlock', async () => {
  const h = harness(); await h.open(A); await h.open(E);
  assertActive(h, A, 'alpha');
  assert.equal(unlock(h, E), true);
  assertActive(h, E, 'secret');
  assert.equal(tab(h, A).content, 'alpha');
  assert.equal(tab(h, E).isDirty, false);
  h.edit('edited secret'); await h.s().saveCurrentNote();
  assert.equal(h.disk.get(key(E)), 'edited secret');
  assert.equal(h.calls.filter(c => c.command === 'write_note' && c.path === E).length, 0);
});

test('cancelled, wrong-target and older same-path unlocks are rejected', async () => {
  const h = harness(); await h.open(A); await h.open(E);
  const old = h.s().encryptionDialog?.requestId;
  h.s().setEncryptionDialog(null);
  assert.equal(unlock(h, E, 'cancelled', 'test-password', old), false);
  await h.open(E);
  assert.equal(unlock(h, E, 'stale', 'test-password', old), false);
  assert.equal(unlock(h, B), false);
  await h.open(B);
  assert.equal(unlock(h, E), false);
  assertActive(h, B, 'bravo');
  assert.equal(tab(h, E), undefined);
});

test('encrypted document without password refuses saving and stays open', async () => {
  const h = harness(); await h.open(E); unlock(h, E);
  h.edit('must stay secret'); h.s().clearEncryptionPassword();
  assert.equal(await h.s().saveCurrentNote(), false);
  await h.s().closeTab(E);
  assertActive(h, E, 'must stay secret'); assert.equal(h.s().isDirty, true);
  assert.equal(session(h, E).saveStatus, 'error');
  assert.equal(h.disk.has(key(E)), false);
  assert.equal(h.calls.some(c => c.command === 'write_note' && c.path === E), false);
});

test('external encrypted extension requests unlock instead of reading as plain text', async () => {
  const h = harness(); await h.s().openTemporaryFile(E);
  assert.equal(h.s().encryptionDialog?.notePath, E);
  assert.equal(unlock(h, E), true);
  assertActive(h, E, 'secret'); assert.equal(h.s().isTemporaryFile, true);
});

for (const [method, target, remaining] of [
  ['closeTab', A, [A, B, C]],
  ['closeAllTabs', undefined, [A]],
  ['closeOtherTabs', B, [A, B]],
  ['closeLeftTabs', C, [A, C]],
  ['closeRightTabs', B, [A, B, C]],
]) {
  test(`${method} retains failed documents and only removes saved targets`, async () => {
    const h = harness(); await h.open(A); await h.open(B); await h.open(C);
    const failed = method === 'closeRightTabs' ? C : A;
    await h.s().switchTab(failed); h.edit('recoverable draft'); h.fail(failed);
    await h.s()[method](target);
    assert.deepEqual(Array.from(h.s().openTabs, t => t.path), remaining);
    assert.equal(tab(h, failed).content, 'recoverable draft'); assert.equal(tab(h, failed).isDirty, true);
    assert.equal(session(h, failed).saveStatus, 'error');
    assert.equal(h.s().activeNote.path, h.s().activeTabPath);
    h.recover(failed); await h.s().closeAllTabs();
    assert.equal(h.disk.get(key(failed)), 'recoverable draft');
    assertActive(h, null, ''); assert.equal(h.s().isDirty, false);
  });
}

test('closing drains edits arriving during the pending write before removal', async () => {
  const h = harness(); await h.open(A); h.edit('first');
  const write = h.holdWrite(A), later = h.holdWrite(A);
  const closing = h.s().closeTab(A); await tick(); h.edit('last');
  write.resolve(); await tick();
  assertActive(h, A, 'last'); assert.equal(h.s().isDirty, true);
  later.resolve(); await closing;
  assert.equal(h.disk.get(key(A)), 'last'); assert.equal(h.s().openTabs.length, 0);
});

test('close does not resurrect or remove unrelated tabs opened during save', async () => {
  const h = harness(); await h.open(A); await h.open(B); h.edit('B last');
  const write = h.holdWrite(B); const closing = h.s().closeTab(B); await tick();
  const opening = h.open(C); await tick();
  write.resolve(); await Promise.all([closing, opening]);
  assertActive(h, C, 'charlie');
  assert.deepEqual(Array.from(h.s().openTabs, t => t.path), [A, C]);
});

test('reload cannot overwrite a draft edited after read began', async () => {
  const h = harness(); await h.open(A); const read = h.holdRead(A);
  const reloading = h.s().reloadOpenTabs([A]); h.edit('new local draft');
  read.resolve({ id: A, content: 'stale disk' }); await reloading;
  assertActive(h, A, 'new local draft'); assert.equal(tab(h, A).isDirty, true);
});

test('reload uses current active session and never resurrects closed tabs', async () => {
  const h = harness(); await h.open(A); const read = h.holdRead(A);
  const reloading = h.s().reloadOpenTabs([A]); await h.s().closeTab(A); await h.open(B);
  read.resolve({ id: A, content: 'late reload' }); await reloading;
  assertActive(h, B, 'bravo');
  assert.deepEqual(Array.from(h.s().openTabs, t => t.path), [B]);
});

test('newest reload wins without changing another active document', async () => {
  const h = harness(); await h.open(A);
  const older = h.holdRead(A), newer = h.holdRead(A);
  const one = h.s().reloadOpenTabs([A]), two = h.s().reloadOpenTabs([A]);
  await h.open(B); newer.resolve({ id: A, content: 'newest' }); await two;
  older.resolve({ id: A, content: 'older' }); await one;
  assertActive(h, B, 'bravo'); await h.s().switchTab(A); assertActive(h, A, 'newest');
});

test('PDF stays read-only through edit, save and reload actions', async () => {
  const h = harness(), path = 'C:/isolated/read-only.pdf'; await h.open(path);
  h.edit('must not save'); await h.s().saveCurrentNote(); await h.s().reloadOpenTabs([path]);
  assertActive(h, path, ''); assert.equal(h.s().isDirty, false);
  assert.equal(h.editor.getState().viewMode, 'preview'); assert.equal(h.disk.has(key(path)), false);
});

test('auto-save uses current configured interval; zero disables debounce only', async () => {
  const h = harness(); await h.open(A);
  await h.settings.getState().updateConfig({ auto_save_interval: 40 });
  h.edit('forty'); await h.advance(39); assert.equal(h.s().isDirty, true);
  await h.advance(1); assert.equal(h.disk.get(key(A)), 'forty'); assert.equal(h.s().isDirty, false);
  await h.settings.getState().updateConfig({ auto_save_interval: 90 });
  h.edit('ninety'); await h.advance(40); assert.equal(h.s().isDirty, true);
  await h.advance(50); assert.equal(h.s().isDirty, false);
  await h.settings.getState().updateConfig({ auto_save_interval: 0 });
  h.edit('manual'); await h.advance(10000); assert.equal(h.s().isDirty, true);
  await h.s().saveCurrentNote(); assert.equal(h.disk.get(key(A)), 'manual');
});

test('flush reports failure, retains drafts, and a retry drains every document', async () => {
  const h = harness(); await h.open(A); h.edit('A pending'); h.fail(A);
  await h.open(B); h.edit('B pending'); await tick();
  assert.equal(typeof h.s().flushPendingSaves, 'function', 'window close needs a flush action');
  assert.equal(await h.s().flushPendingSaves(), false);
  assert.equal(tab(h, A).isDirty, true); assert.equal(tab(h, B).isDirty, false);
  assert.equal(h.disk.get(key(B)), 'B pending');
  h.recover(A); assert.equal(await h.s().flushPendingSaves(), true);
  assert.equal(h.disk.get(key(A)), 'A pending'); assert.equal(tab(h, A).isDirty, false);
});

test('flush waits for in-flight writes and rechecks newly edited documents', async () => {
  const h = harness(); await h.open(A); await h.open(B); h.edit('B pending');
  const write = h.holdWrite(B); let done = false;
  assert.equal(typeof h.s().flushPendingSaves, 'function');
  const flushing = h.s().flushPendingSaves().then(result => { done = true; return result; });
  await tick(); assert.equal(done, false);
  await h.s().switchTab(A); h.edit('A edited during flush'); write.resolve();
  assert.equal(await flushing, true);
  assert.equal(h.disk.get(key(A)), 'A edited during flush');
  assert.equal(h.disk.get(key(B)), 'B pending'); assert.equal(h.s().isDirty, false);
});

test('session identity survives edits and path migration but changes on reopen', async () => {
  const h = harness(); await h.open(A);
  const identity = session(h, A).identity;
  assert.equal(typeof identity, 'number');
  h.edit('continued body'); await h.s().saveCurrentNote();
  assert.equal(session(h, A).identity, identity);
  h.s().applyNotePathChange(A, B, 'B');
  assert.equal(session(h, B).identity, identity);
  await h.s().closeTab(B); await h.open(B);
  assert.notEqual(session(h, B).identity, identity);
});

test('revision guard rejects stale formatting even after a close and reopen', async () => {
  const h = harness(); await h.open(A);
  assert.equal(typeof h.s().getDocumentRevision, 'function');
  assert.equal(typeof h.s().updateDocumentContent, 'function');
  const rev = h.s().getDocumentRevision(A);
  h.edit('newer');
  assert.equal(h.s().updateDocumentContent(A, 'stale format', rev), false);
  assertActive(h, A, 'newer');
  const current = h.s().getDocumentRevision(A);
  assert.equal(h.s().updateDocumentContent(A, 'formatted', current), true);
  await h.s().closeTab(A); await h.open(A);
  assert.equal(h.s().updateDocumentContent(A, 'old session', current), false);
  assertActive(h, A, 'formatted');
});

test('note/folder renames migrate draft, revision, timer and local sidebar state', async () => {
  const h = harness(); await h.open(A); h.edit('renamed draft');
  h.store.setState({ notes: [note(A)], expandedFolders: ['C:/isolated'], activeFolder: 'C:/isolated' });
  assert.equal(typeof h.s().getDocumentRevision, 'function');
  const revision = h.s().getDocumentRevision(A);
  const renamed = 'C:/isolated/renamed.md', moved = 'C:/moved/renamed.md';
  h.s().applyNotePathChange(A, renamed, 'renamed');
  assert.equal(h.s().getDocumentRevision(A), null);
  assert.equal(h.s().updateDocumentContent(renamed, 'stale', revision), false);
  h.s().applyFolderPathChange('C:/isolated', 'C:/moved');
  h.disk.set(key(moved), h.disk.get(key(A))); h.disk.delete(key(A));
  assertActive(h, moved, 'renamed draft'); assert.equal(tab(h, moved).isDirty, true);
  assert.equal(h.s().notes[0].path, moved); assert.equal(h.s().expandedFolders[0], 'C:/moved');
  await h.advance(1500);
  assert.equal(h.disk.get(key(moved)), 'renamed draft'); assert.equal(h.disk.has(key(A)), false);
  assert.equal(session(h, moved).isDirty, false);
});

test('an external path change during save cannot overwrite different destination content', async () => {
  const h = harness(); await h.open(A); h.edit('rename in flight');
  const write = h.holdWrite(A); const saving = h.s().saveCurrentNote(); await tick();
  h.s().applyNotePathChange(A, B, 'B'); write.resolve(); await saving;
  assertActive(h, B, 'rename in flight');
  assert.equal(h.disk.get(key(B)), 'bravo'); assert.equal(h.s().isDirty, true);
  assert.match(session(h, B).saveError, /changed on disk/);
  assert.equal(session(h, A), null);
});

test('same Windows path via external spelling preserves the existing draft and temporary flag', async () => {
  const h = harness(); await h.s().openTemporaryFile(A); h.edit('temporary draft');
  await h.s().openTemporaryFile('c:\\isolated\\a.md');
  assert.equal(h.s().openTabs.length, 1); assertActive(h, A, 'temporary draft');
  await h.open(B); await h.s().switchTab(A);
  assert.equal(h.s().isTemporaryFile, true);
});

test('edits made while the next file loads are handed off when it activates', async () => {
  const h = harness(); await h.open(A);
  await h.settings.getState().updateConfig({ auto_save_interval: 0 });
  const read = h.holdRead(B); const opening = h.open(B);
  h.edit('typed during read'); read.resolve({ id: B, content: 'bravo' });
  await opening; await tick();
  assertActive(h, B, 'bravo'); assert.equal(tab(h, A).content, 'typed during read');
  assert.equal(h.disk.get(key(A)), 'typed during read'); assert.equal(tab(h, A).isDirty, false);
});

test('closing an in-flight open invalidates its read before reopening the same path', async () => {
  const h = harness(), old = h.holdRead(A), fresh = h.holdRead(A);
  const first = h.open(A);
  await h.s().closeTab(A);
  const second = h.open(A);
  fresh.resolve({ id: A, content: 'fresh after close' });
  old.resolve({ id: A, content: 'obsolete before close' });
  await Promise.all([first, second]);
  assertActive(h, A, 'fresh after close');
  assert.equal(h.s().openTabs.length, 1);
});

for (const method of ['closeAllTabs', 'closeTab']) {
  test(`${method} invalidates a superseded read, not just the latest pending target`, async () => {
    const h = harness(), old = h.holdRead(A), other = h.holdRead(B), fresh = h.holdRead(A);
    const one = h.open(A), two = h.open(B);
    await h.s()[method](A);
    const reopened = h.open(A);
    fresh.resolve({ id: A, content: 'after close' });
    old.resolve({ id: A, content: 'before close' }); other.resolve({ id: B, content: 'bravo' });
    await Promise.all([one, two, reopened]);
    assertActive(h, A, 'after close'); assert.equal(h.s().openTabs.length, 1);
  });
}

test('window close drains real sessions, coalesces requests and never closes after save failure', async () => {
  const h = harness(); await h.open(A); h.edit('exit draft');
  const write = h.holdWrite(A); let destroyed = false, prevented = 0;
  assert.equal(typeof h.createCloseHandler, 'function');
  // Only the unavailable native window is substituted, not the flush action.
  const close = h.createCloseHandler(async () => { destroyed = true; });
  const event = { preventDefault() { ++prevented; } };
  const first = close(event); await close(event); await tick();
  assert.equal(destroyed, false); assert.equal(prevented, 2);
  h.edit('last before exit'); write.resolve(); await first;
  assert.equal(destroyed, true); assert.equal(h.disk.get(key(A)), 'last before exit');
  assert.equal(h.s().isDirty, false);
  destroyed = false; h.fail(A); h.edit('failed exit'); await close(event);
  assert.equal(destroyed, false); assertActive(h, A, 'failed exit');
  assert.equal(h.s().isDirty, true);
});

test('native window permission failure is visible and leaves saved sessions available', async () => {
  const h = harness(); await h.open(A); h.edit('safe on disk');
  assert.equal(typeof h.createCloseHandler, 'function');
  const close = h.createCloseHandler(async () => { throw new Error('window.destroy not allowed'); });
  let prevented = false;
  await close({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assertActive(h, A, 'safe on disk');
  assert.equal(h.s().isDirty, false);
  assert.ok(h.toasts.some(t => /window.destroy not allowed/.test(t.message)));
});

test('read failure leaves active note, tab and draft paired', async () => {
  const h = harness(); await h.open(A); h.edit('still here');
  await h.open('C:/isolated/missing.md');
  assertActive(h, A, 'still here'); assert.equal(h.s().isLoading, false);
  assert.ok(h.toasts.some(t => t.type === 'warning'));
});
