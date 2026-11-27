import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTypeScriptLoader } from './helpers/load-typescript.mjs';

function harness(extraFolders = []) {
  const load = createTypeScriptLoader({ invoke: async () => undefined, setTimeout, clearTimeout, window: new EventTarget() });
  const { useNotesStore } = load(fileURLToPath(new URL('../src/stores/notes-store.ts', import.meta.url)));
  const { useSettingsStore } = load(fileURLToPath(new URL('../src/stores/settings-store.ts', import.meta.url)));
  useSettingsStore.setState({ config: { ...useSettingsStore.getState().config, storage_path: 'C:/library', extra_folders: extraFolders } });
  return useNotesStore;
}

const project = (name, path, children = []) => ({ name, path, children, is_root: false });
const tree = () => [project('Parent', 'C:/library/Parent', [project('Child', 'C:/library/Parent/Child')])];

test('a nested project chunk merges beneath its parent instead of the top level', () => {
  const notes = harness();
  notes.setState({ projects: tree() });
  notes.getState().mergeProjectChunk(project('NewChild', 'C:/library/Parent/Child/NewChild'));
  const projects = notes.getState().projects;
  assert.equal(projects.length, 1);
  assert.equal(projects[0].children[0].children.length, 1);
  assert.equal(projects[0].children[0].children[0].name, 'NewChild');
});

test('a chunk without a known parent is not appended at the top level', () => {
  const notes = harness();
  notes.setState({ projects: tree() });
  notes.getState().mergeProjectChunk(project('Orphan', 'C:/library/Parent/Unknown/Orphan'));
  assert.equal(notes.getState().projects.length, 1);
});

test('top-level chunks still append at the root and scanning shells stay non-destructive', () => {
  const notes = harness();
  notes.setState({ projects: tree() });
  notes.getState().mergeProjectChunk({ ...project('Fresh', 'C:/library/Fresh'), scanning: true });
  assert.equal(notes.getState().projects.length, 2);
  notes.getState().mergeProjectChunk({ ...project('Parent', 'C:/library/Parent'), scanning: true });
  assert.equal(notes.getState().projects[0].children.length, 1);
  assert.equal(notes.getState().projects[0].children[0].name, 'Child');
});
test('children of an extra root nest under that root instead of the top level', () => {
  const notes = harness(['C:/library/Downloads']);
  notes.setState({ projects: [project('Downloads', 'C:/library/Downloads'), project('Other', 'C:/library/Other')] });
  notes.getState().mergeProjectChunk(project('Child', 'C:/library/Downloads/Child'));
  const projects = notes.getState().projects;
  assert.equal(projects.length, 2);
  const downloads = projects.find(item => item.name === 'Downloads');
  assert.equal(downloads.children.length, 1);
  assert.equal(downloads.children[0].name, 'Child');
});

test('a discovered extra root itself still appends at the top level', () => {
  const notes = harness(['C:/library/Nested/Extra']);
  notes.setState({ projects: [project('Nested', 'C:/library/Nested')] });
  notes.getState().mergeProjectChunk(project('Extra', 'C:/library/Nested/Extra'));
  const projects = notes.getState().projects;
  assert.equal(projects.length, 2);
  assert.equal(projects[1].name, 'Extra');
});
