import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTypeScriptLoader } from './helpers/load-typescript.mjs';

function createSettings(invoke) {
  const events = [];
  const load = createTypeScriptLoader({ invoke, setTimeout, clearTimeout, window: { dispatchEvent: (event) => events.push(event) } });
  const { useSettingsStore } = load(fileURLToPath(new URL('../src/stores/settings-store.ts', import.meta.url)));
  return { store: useSettingsStore, events };
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('failed settings writes retain the draft and expose retryable failure', async () => {
  let fail = true;
  let disk;
  const { store, events } = createSettings(async (command, args) => {
    if (command !== 'save_config') throw new Error(`Unexpected command: ${command}`);
    if (fail) throw new Error('disk full');
    disk = args.config;
  });
  assert.equal(await store.getState().updateConfig({ theme: 'dark' }), false);
  assert.equal(store.getState().config.theme, 'dark');
  assert.equal(store.getState().saveStatus, 'error');
  assert.match(store.getState().saveError, /disk full/);
  assert.ok(events.some((event) => event.type === 'show-toast'));
  fail = false;
  assert.equal(await store.getState().retrySave(), true);
  assert.equal(disk.theme, 'dark');
  assert.equal(store.getState().saveStatus, 'idle');
  assert.equal(store.getState().saveError, null);
});

test('failed library changes retain a visible draft without switching the active roots', async () => {
  const { store } = createSettings(async () => { throw new Error('disk full'); });
  store.setState({ config: { ...store.getState().config, storage_path: 'C:/old', extra_folders: ['C:/kept'] } });
  assert.equal(await store.getState().updateConfig({ storage_path: 'C:/new', extra_folders: ['C:/new-extra'] }), false);
  assert.equal(store.getState().config.storage_path, 'C:/old');
  assert.deepEqual(store.getState().config.extra_folders, ['C:/kept']);
  assert.equal(store.getState().draftConfig.storage_path, 'C:/new');
  assert.deepEqual(Array.from(store.getState().draftConfig.extra_folders), ['C:/new-extra']);
});

test('library roots become active only after their configuration write succeeds', async () => {
  let finish;
  const { store } = createSettings(() => new Promise(resolve => { finish = resolve; }));
  store.setState({ config: { ...store.getState().config, storage_path: 'C:/old' } });
  const saved = store.getState().updateConfig({ storage_path: 'C:/new' }); await tick();
  assert.equal(store.getState().config.storage_path, 'C:/old');
  finish(); assert.equal(await saved, true);
  assert.equal(store.getState().config.storage_path, 'C:/new');
  assert.equal(store.getState().draftConfig, null);
  assert.equal(store.getState().storageRevision, 1);
});

test('serialized root writes commit each successful scope and keep a later failed selection as a draft', async () => {
  const writes = [];
  const { store } = createSettings((command, args) => new Promise((resolve, reject) => writes.push({ config: args.config, resolve, reject })));
  store.setState({ config: { ...store.getState().config, storage_path: 'C:/A' } });
  const first = store.getState().updateConfig({ storage_path: 'C:/B' });
  const second = store.getState().updateConfig({ storage_path: 'C:/C', theme: 'dark' }); await tick();
  writes[0].resolve(); assert.equal(await first, true); await tick();
  assert.equal(store.getState().config.storage_path, 'C:/B');
  assert.equal(store.getState().config.theme, 'dark');
  assert.equal(store.getState().saveStatus, 'saving');
  writes[1].reject(new Error('disk full')); assert.equal(await second, false);
  assert.equal(store.getState().config.storage_path, 'C:/B');
  assert.equal(store.getState().draftConfig.storage_path, 'C:/C');
  const retry = store.getState().retrySave(); await tick(); writes[2].resolve();
  assert.equal(await retry, true);
  assert.equal(store.getState().config.storage_path, 'C:/C');
  assert.equal(store.getState().storageRevision, 2);
});

test('successful A/B/A root changes advance the storage revision even when the final path is unchanged', async () => {
  const { store } = createSettings(async () => {});
  store.setState({ config: { ...store.getState().config, storage_path: 'C:/A' } });
  await store.getState().updateConfig({ storage_path: 'C:/B' });
  await store.getState().updateConfig({ storage_path: 'C:/A' });
  assert.equal(store.getState().config.storage_path, 'C:/A');
  assert.equal(store.getState().storageRevision, 2);
});

test('settings writes are serialized and an older completion cannot clear pending state', async () => {
  const requests = [];
  const { store } = createSettings((command, args) => new Promise((resolve) => requests.push({ config: args.config, resolve })));
  const first = store.getState().updateConfig({ theme: 'dark' });
  const second = store.getState().updateConfig({ language: 'zh-Hans' });
  await tick();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].config.theme, 'dark');
  requests[0].resolve();
  assert.equal(await first, true);
  await tick();
  assert.equal(requests.length, 2);
  assert.equal(store.getState().saveStatus, 'saving');
  assert.equal(requests[1].config.theme, 'dark');
  assert.equal(requests[1].config.language, 'zh-Hans');
  requests[1].resolve();
  assert.equal(await second, true);
  assert.equal(store.getState().saveStatus, 'idle');
});

test('invalid settings never enter the active configuration or persistence queue', async () => {
  let writes = 0;
  const { store } = createSettings(async () => { writes++; });
  const original = store.getState().config;
  for (const partial of [
    { auto_save_interval: -1 }, { auto_save_interval: NaN }, { editor_font_size: 0 },
    { preview_font_size: Infinity }, { editor_font_family: '' }, { line_ending: 'invalid' },
  ]) {
    assert.equal(await store.getState().updateConfig(partial), false);
    assert.equal(store.getState().config, original);
  }
  assert.equal(writes, 0);
});

test('a failed configuration load cannot be overwritten by a setting change', async () => {
  let fail = true, writes = 0;
  const { store } = createSettings(async command => {
    if (command === 'get_config') {
      if (fail) throw new Error('invalid config JSON');
      return { ...store.getState().config, theme: 'dark' };
    }
    if (command === 'save_config') { writes++; return; }
    throw new Error(command);
  });
  await store.getState().loadConfig();
  assert.equal(await store.getState().updateConfig({ theme: 'light' }), false);
  assert.equal(writes, 0);
  assert.match(store.getState().loadError, /invalid config JSON/);
  fail = false;
  await store.getState().loadConfig();
  assert.equal(store.getState().config.theme, 'dark');
  assert.equal(await store.getState().updateConfig({ theme: 'light' }), true);
  assert.equal(writes, 1);
});

test('configuration load errors remain visible instead of looking like a fresh installation', async () => {
  const { store } = createSettings(async () => { throw new Error('invalid config JSON'); });
  await store.getState().loadConfig();
  assert.equal(store.getState().loaded, true);
  assert.match(store.getState().loadError, /invalid config JSON/);
});

test('the legacy mono editor default migrates once to the signature font', async () => {
  const saved = [];
  const { store } = createSettings(async (command, args) => {
    if (command === 'get_config') return { ...store.getState().config, editor_font_family: 'ui-monospace' };
    if (command === 'save_config') { saved.push(args.config.editor_font_family); return; }
    throw new Error(`Unexpected command: ${command}`);
  });
  await store.getState().loadConfig();
  assert.match(store.getState().config.editor_font_family, /TsangerJinKai02/);
  await tick();
  assert.equal(saved.length, 1);
  assert.match(saved[0], /TsangerJinKai02/);
});

test('a deliberate editor font choice is never overwritten', async () => {
  let writes = 0;
  const { store } = createSettings(async (command) => {
    if (command === 'get_config') return { ...store.getState().config, editor_font_family: 'Courier New' };
    if (command === 'save_config') { writes++; return; }
    throw new Error(`Unexpected command: ${command}`);
  });
  await store.getState().loadConfig();
  await tick();
  assert.equal(store.getState().config.editor_font_family, 'Courier New');
  assert.equal(writes, 0);
});
