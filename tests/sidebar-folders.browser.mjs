import React from 'react';
import { createRoot } from 'react-dom/client';
import { UnifiedTree } from '../src/components/sidebar/UnifiedTree';
import { useNotesStore } from '../src/stores/notes-store';
import { useSettingsStore } from '../src/stores/settings-store';

const rootPath = 'C:/new-subfolder-fixture';
const until = async (predicate, message) => {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(requestAnimationFrame);
  }
  throw new Error(message);
};
const toWindows = path => path.replace(/\//g, '\\');

export async function openNewSubfolderFixture() {
  const native = window.__TAURI_INTERNALS__, events = window.__TAURI_EVENT_PLUGIN_INTERNALS__;
  const settings = useSettingsStore.getState(), notes = useNotesStore.getState();
  const calls = [], callbacks = new Map(), listeners = new Map();
  let id = 0;
  const emit = (event, payload) => {
    for (const [listenerId, listener] of listeners) if (listener.event === event) listener.callback({ event, id: listenerId, payload });
  };
  const child = { name: 'Child', path: `${rootPath}/Parent/Child`, children: [], is_root: false };
  const parent = { name: 'Parent', path: `${rootPath}/Parent`, children: [child], is_root: false };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback(callback) { callbacks.set(++id, callback); return id; },
    unregisterCallback(callbackId) { callbacks.delete(callbackId); },
    async invoke(command, args = {}) {
      calls.push({ command, args });
      if (command === 'plugin:event|listen') {
        const listener = ++id;
        listeners.set(listener, { event: args.event, callback: callbacks.get(args.handler) });
        return listener;
      }
      if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
      if (command === 'start_scan_session') return 'browser-scan-session';
      if (['invalidate_scan', 'release_scan_lane', 'start_watching', 'write_log', 'write_logs'].includes(command)) return;
      if (command === 'get_all_notes') return [];
      if (command === 'get_projects') return [parent];
      if (command === 'create_folder') return `\\\\?\\${toWindows(args.parentPath)}\\${args.name}`;
      if (command === 'read_directory_snapshot') {
        const path = args.path;
        return { project: { name: path.split(/[\\/]/).pop(), path, children: [], is_root: false }, notes: [] };
      }
      if (command === 'get_notes_metadata') return [];
      if (command === 'detect_cloud_sync') return { status: 'Unavailable', icloud_path: null };
      if (command === 'get_sync_status') return 'unavailable';
      throw new Error(`Unexpected subfolder command: ${command}`);
    },
  };
  useSettingsStore.setState({ config: { ...settings.config, storage_path: rootPath, extra_folders: [], debug_log: false, language: 'en' }, loaded: true, loadError: null, draftConfig: null, saveError: null, saveStatus: 'idle' });
  useNotesStore.setState({ projects: [parent], notes: [], activeFolder: null, expandedFolders: [parent.path, child.path], allNotesExpanded: true, searchQuery: '', searchResults: [] });
  const mount = document.createElement('div');
  mount.style.cssText = 'position:fixed;left:0;top:0;width:350px;height:650px';
  document.body.append(mount);
  const root = createRoot(mount);
  window.__newSubfolder = {
    mount, calls,
    emitStructureCreate: path => emit('fs-structure', { kind: 'dir-create', path, from: null, to: null }),
    cleanup: async () => {
      root.unmount(); mount.remove(); await new Promise(requestAnimationFrame);
      useSettingsStore.setState(settings); useNotesStore.setState(notes);
      window.__TAURI_INTERNALS__ = native; window.__TAURI_EVENT_PLUGIN_INTERNALS__ = events;
      delete window.__newSubfolder;
    },
  };
  root.render(React.createElement(UnifiedTree));
  await until(() => mount.textContent.includes('Child'), 'Subfolder fixture did not render');
}

const nestedUnderChild = () => {
  const projects = useNotesStore.getState().projects;
  if (projects.some(project => project.name === 'NewChild')) return false;
  const parent = projects.find(project => project.name === 'Parent');
  const child = parent?.children.find(project => project.name === 'Child');
  return !!child?.children.some(project => project.name === 'NewChild');
};

export async function createSubfolderUnderChild() {
  const f = window.__newSubfolder;
  const row = [...f.mount.querySelectorAll('div')].find(element => element.textContent.trim().startsWith('Child') && element.className.includes('group'));
  if (!row) throw new Error('Nested folder row missing');
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 160 }));
  await until(() => f.mount.textContent.includes('New Subfolder'), 'Folder context menu did not open');
  if (useNotesStore.getState().lastFolder !== `${rootPath}/Parent/Child`) throw new Error('Folder interaction did not record the shortcut target');
  if (useNotesStore.getState().creationParent() !== `${rootPath}/Parent/Child`) throw new Error('Shortcut parent ignored the selected folder');
  const item = [...f.mount.querySelectorAll('div')].find(element => element.textContent.trim() === 'New Subfolder');
  if (!item) throw new Error('New Subfolder item missing');
  const previousPrompt = window.prompt;
  window.prompt = () => 'NewChild';
  try {
    item.click();
    await until(() => f.calls.some(call => call.command === 'create_folder'), 'create_folder was not invoked');
    const call = f.calls.find(call => call.command === 'create_folder');
    if (call.args.parentPath !== `${rootPath}/Parent/Child`) throw new Error(`Subfolder used the wrong parent: ${call.args.parentPath}`);
    await until(() => nestedUnderChild(), 'New folder was not inserted under its parent');
    // Native watcher reports the created directory right after the IPC returns.
    f.emitStructureCreate(`\\\\?\\${toWindows(rootPath)}\\Parent\\Child\\NewChild`);
    await new Promise(resolve => setTimeout(resolve, 400));
    if (f.calls.some(call => call.command === 'read_directory_snapshot')) {
      if (!nestedUnderChild()) throw new Error('Directory refresh moved the new folder out of its parent');
    }
    return { passed: true, parent: call.args.parentPath, insertedUnderParent: true, watcherRefreshKeepsNesting: true };
  } finally {
    window.prompt = previousPrompt;
  }
}