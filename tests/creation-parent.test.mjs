import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTypeScriptLoader } from './helpers/load-typescript.mjs';

function harness(config) {
  const load = createTypeScriptLoader({ invoke: async () => undefined, setTimeout, clearTimeout, window: new EventTarget() });
  const { useNotesStore } = load(fileURLToPath(new URL('../src/stores/notes-store.ts', import.meta.url)));
  const { useSettingsStore } = load(fileURLToPath(new URL('../src/stores/settings-store.ts', import.meta.url)));
  useSettingsStore.setState({ config: { ...useSettingsStore.getState().config, ...config } });
  return { notes: useNotesStore, settings: useSettingsStore };
}

const note = path => ({ id: path, path, title: path.split('/').pop(), folder: '', created_at: '', modified_at: '', size: 1, pinned: false, is_encrypted: false });

test('shortcut creation targets the last tree selection before the library root', () => {
  const { notes } = harness({ storage_path: 'C:/library', extra_folders: [] });
  assert.equal(notes.getState().creationParent(), 'C:/library');
  notes.getState().setLastFolder('C:/library/work/notes');
  assert.equal(notes.getState().creationParent(), 'C:/library/work/notes');
});

test('a root switch invalidates the remembered selection and falls back inside the new library', () => {
  const { notes, settings } = harness({ storage_path: 'C:/library', extra_folders: [] });
  notes.getState().setLastFolder('C:/library/work');
  settings.setState({ config: { ...settings.getState().config, storage_path: 'D:/other' } });
  assert.equal(notes.getState().creationParent(), 'D:/other');
  notes.getState().setLastFolder('D:/other/deep');
  assert.equal(notes.getState().creationParent(), 'D:/other/deep');
});

test('extra-folder selections stay valid and the active note folder is the fallback', () => {
  const { notes } = harness({ storage_path: 'C:/library', extra_folders: ['E:/imported'] });
  notes.getState().setLastFolder('E:/imported/reports');
  assert.equal(notes.getState().creationParent(), 'E:/imported/reports');
  notes.setState({ lastFolder: 'C:/elsewhere' });
  notes.setState({ activeNote: note('E:/imported/deep/active.md') });
  assert.equal(notes.getState().creationParent(), 'E:/imported/deep');
});
