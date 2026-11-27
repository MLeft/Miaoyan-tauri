import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createTypeScriptLoader } from './helpers/load-typescript.mjs';

const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const root = 'C:/synthetic-library';
const project = (name, children = []) => ({ name, path: `${root}/${name}`, children, is_root: false });
function harness() {
  const pending = new Map();
  const load = createTypeScriptLoader({ window: new EventTarget(), setTimeout, clearTimeout,
    invoke: (command) => {
      if (command === 'start_scan_session') return Promise.resolve('fixture-session');
      if (['write_log', 'invalidate_scan', 'release_scan_lane'].includes(command)) return Promise.resolve();
      return new Promise((resolve, reject) => pending.set(command, { resolve, reject }));
    },
  });
  const store = load(fileURLToPath(new URL('../src/stores/notes-store.ts', import.meta.url))).useNotesStore;
  const settings = load(fileURLToPath(new URL('../src/stores/settings-store.ts', import.meta.url))).useSettingsStore;
  settings.setState({ config: { ...settings.getState().config, storage_path: root, extra_folders: [] } });
  return { store, settings, pending, s: () => store.getState() };
}

test('failed project discovery keeps old subtrees and completed chunks, adding only new shells', async () => {
  const h = harness();
  const old = project('old', [project('old/deep')]);
  const complete = project('complete', [project('complete/fresh')]);
  h.store.setState({ projects: [old, project('complete')] });
  const loading = h.s().loadProjects(root); await tick();
  h.s().mergeProjectChunk({ ...project('old'), scanning: true });
  h.s().mergeProjectChunk(complete);
  h.s().mergeProjectChunk({ ...project('complete'), scanning: true });
  h.s().mergeProjectChunk({ ...project('new'), scanning: true });
  h.pending.get('get_projects').reject('injected worker creation failure');
  await loading;
  assert.equal(h.s().projects[0], old);
  assert.equal(h.s().projects[1], complete);
  assert.equal(h.s().projects[2].path, `${root}/new`);
  assert.equal(h.s().projects.length, 3);
});

test('complete chunks and successful empty arrays remain authoritative', async () => {
  const h = harness();
  const old = project('old', [project('old/deep')]);
  h.store.setState({ projects: [old] });
  h.s().mergeProjectChunk({ ...project('old'), path: 'c:\\synthetic-library\\old', scanning: true });
  assert.equal(h.s().projects.length, 1);
  assert.equal(h.s().projects[0], old);
  const empty = project('old');
  h.s().mergeProjectChunk(empty);
  assert.equal(h.s().projects[0], empty);
  const loading = h.s().loadProjects(root); await tick();
  h.pending.get('get_projects').resolve([]);
  await loading;
  assert.equal(h.s().projects.length, 0);
});

test('failed notes IPC retains current list including partial chunks, then success replaces it', async () => {
  const h = harness();
  const old = { id: 'old', path: `${root}/old.md` };
  const partial = { id: 'partial', path: `${root}/partial.md` };
  h.store.setState({ notes: [old] });
  const loading = h.s().loadNotes(root); await tick();
  h.s().setNotesFromCache([old, partial]);
  const current = h.s().notes;
  h.pending.get('get_all_notes').reject('injected worker panic');
  await loading;
  assert.equal(h.s().notes, current);
  assert.equal(h.s().notes.length, 2);
  assert.equal(h.s().isLoading, false);
  const next = h.s().loadNotes(root); await tick();
  h.pending.get('get_all_notes').resolve([]);
  await next;
  assert.equal(h.s().notes.length, 0);
});

async function switchRoot(h, path) {
  const saved = h.settings.getState().updateConfig({ storage_path: path });
  await Promise.resolve(); h.pending.get('save_config').resolve(); await saved;
}
const note = path => ({ id: path, path, title: path.split('/').pop(), folder: path.slice(0, path.lastIndexOf('/')), created_at: '', modified_at: '', pinned: false, size: 1, is_encrypted: false });

test('old-root notes cannot replace a newer library or clear its loading state', async () => {
  const h = harness(), nextRoot = 'C:/next-library';
  const old = h.s().loadNotes(root); await tick();
  const oldRequest = h.pending.get('get_all_notes');
  await switchRoot(h, nextRoot);
  const fresh = h.s().loadNotes(nextRoot); await tick();
  const newRequest = h.pending.get('get_all_notes');
  oldRequest.resolve([note(`${root}/old.md`)]); await old;
  assert.equal(h.s().isLoading, true);
  assert.equal(h.s().notes.some(item => item.path.startsWith(root)), false);
  newRequest.resolve([note(`${nextRoot}/new.md`)]); await fresh;
  assert.equal(h.s().notes[0].path, `${nextRoot}/new.md`);
});

test('old-root project discovery cannot restore folders after a new library finished', async () => {
  const h = harness(), nextRoot = 'C:/next-library';
  const old = h.s().loadProjects(root); await tick();
  const oldRequest = h.pending.get('get_projects');
  await switchRoot(h, nextRoot);
  const fresh = h.s().loadProjects(nextRoot); await tick();
  const newRequest = h.pending.get('get_projects');
  newRequest.resolve([{ name: 'new', path: `${nextRoot}/new`, children: [], is_root: false }]); await fresh;
  oldRequest.resolve([project('old')]); await old;
  assert.equal(h.s().projects.length, 1);
  assert.equal(h.s().projects[0].path, `${nextRoot}/new`);
});

test('A/B/A committed roots reject the first A snapshot even though its path matches again', async () => {
  const h = harness();
  const old = h.s().loadNotes(root); await tick();
  const oldRequest = h.pending.get('get_all_notes');
  await switchRoot(h, 'C:/next-library'); await switchRoot(h, root);
  const fresh = h.s().loadNotes(root); await tick();
  const newRequest = h.pending.get('get_all_notes');
  newRequest.resolve([note(`${root}/fresh.md`)]); await fresh;
  oldRequest.resolve([note(`${root}/stale.md`)]); await old;
  assert.equal(h.s().notes.length, 1);
  assert.equal(h.s().notes[0].path, `${root}/fresh.md`);
});

for (const operation of ['select', 'refresh']) {
  test(`old-root folder ${operation} cannot replace the new library list`, async () => {
    const h = harness(), folder = `${root}/folder`, nextRoot = 'C:/next-library';
    h.store.setState({ activeFolder: folder });
    const old = operation === 'select' ? h.s().setActiveFolder(folder, root) : h.s().loadNotesInFolder(folder, root);
    const oldRequest = h.pending.get('get_notes_in_folder');
    await switchRoot(h, nextRoot);
    const fresh = h.s().loadNotes(nextRoot); await tick();
    h.pending.get('get_all_notes').resolve([note(`${nextRoot}/new.md`)]); await fresh;
    oldRequest.resolve([note(`${folder}/old.md`)]); await old;
    assert.equal(h.s().activeFolder, null);
    assert.equal(h.s().notes.length, 1);
    assert.equal(h.s().notes[0].path, `${nextRoot}/new.md`);
  });
}

test('all scan bridge commands reject rather than resolve an empty library', async () => {
  const error = 'injected scan failure';
  const load = createTypeScriptLoader({ window: new EventTarget(), setTimeout, clearTimeout,
    invoke: () => Promise.reject(error),
  });
  const bridge = load(fileURLToPath(new URL('../src/services/tauri-bridge.ts', import.meta.url)));
  for (const call of [() => bridge.getProjects(root), () => bridge.getAllNotes(root), () => bridge.scanFolder(root)]) {
    await assert.rejects(call(), e => e === error);
  }
});
