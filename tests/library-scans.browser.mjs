import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../src/App';
import { UnifiedTree } from '../src/components/sidebar/UnifiedTree';
import { setScanRoots } from '../src/services/tauri-bridge';
import { useNotesStore } from '../src/stores/notes-store';
import { useSettingsStore } from '../src/stores/settings-store';

const A = 'C:/library-A-fixture', B = 'C:/library-B-fixture';
const note = (root, name) => ({ id: `${root}/${name}`, path: `${root}/${name}`, title: name, folder: '', created_at: '2026-01-01T00:00:00Z', modified_at: '2026-01-01T00:00:00Z', size: 1, pinned: false, is_encrypted: false });
const project = (root, name) => ({ name, path: `${root}/${name}`, children: [], is_root: false });
const frame = () => new Promise(requestAnimationFrame);
const until = async (predicate, message) => {
  const end = performance.now() + 5000;
  while (performance.now() < end) { if (predicate()) return; await frame(); }
  throw new Error(message);
};

export async function openExtraRemovalFixture(mode = 'disjoint', holdValidation = false) {
  const native = window.__TAURI_INTERNALS__, events = window.__TAURI_EVENT_PLUGIN_INTERNALS__;
  const settings = useSettingsStore.getState(), notes = useNotesStore.getState();
  const main = 'C:/remove-main-fixture', kept = 'C:/kept-alias-fixture';
  const extra = mode === 'nested' ? `${main}/Parent/Child` : mode === 'hidden' ? `${main}/.selected` : 'C:/remove-extra-fixture';
  const calls = [], extraProject = project(extra, ''); extraProject.path = extra; extraProject.name = 'Extra';
  let fail = mode === 'disjoint', releaseValidation;
  let mounted = true;
  const parent = project(main, 'Parent'); parent.children = [extraProject];
  const currentRows = () => {
    const configured = useSettingsStore.getState().config.extra_folders.includes(extra);
    return [note(main, 'main.md'), ...(configured || mode === 'nested' ? [note(extra, 'extra.md')] : mode === 'alias' ? [note(kept, 'extra.md')] : [])];
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = { ...native, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, transformCallback() { return 1; }, unregisterCallback() {},
    async invoke(command, args = {}) {
      calls.push({ command, args });
      if (command === 'start_scan_session') return 'browser-scan-session';
      if (['invalidate_scan', 'release_scan_lane', 'start_watching', 'write_log', 'write_logs', 'plugin:event|unlisten'].includes(command)) return;
      if (command === 'plugin:event|listen') return 1;
      if (command === 'save_config') { if (fail) throw new Error('synthetic removal-save failure'); return; }
      if (command === 'scope_roots_overlap') {
        if (holdValidation) await new Promise(resolve => { releaseValidation = resolve; });
        return mode !== 'disjoint';
      }
      if (command === 'get_all_notes') return currentRows();
      if (command === 'get_projects') return mode === 'nested' ? [parent] : mode === 'alias' ? [{ ...extraProject, name: 'Kept', path: kept }] : [];
      if (command === 'detect_cloud_sync') return { status: 'Unavailable', icloud_path: null };
      if (command === 'get_sync_status') return 'unavailable';
      throw new Error(`Unexpected removal command: ${command}`);
    },
  };
  const extras = mode === 'alias' ? [extra, kept] : [extra];
  setScanRoots(main, extras);
  useSettingsStore.setState({ config: { ...settings.config, storage_path: main, extra_folders: extras, debug_log: false }, loaded: true, loadError: null, draftConfig: null, saveError: null, saveStatus: 'idle' });
  useNotesStore.setState({ projects: mode === 'nested' ? [parent, extraProject] : [extraProject], notes: [], activeFolder: null, expandedFolders: [extra, parent.path], allNotesExpanded: true, searchQuery: '', searchResults: [] });
  const mount = document.createElement('div'); mount.style.cssText = 'position:fixed;left:0;top:0;width:350px;height:650px'; document.body.append(mount);
  const root = createRoot(mount);
  const unmount = () => { if (mounted) { mounted = false; root.unmount(); } };
  window.__extraRemoval = { mount, calls, extra, kept, mode, allow: () => { fail = false; }, unmount, validationReady: () => typeof releaseValidation === 'function', releaseValidation: () => releaseValidation?.(), cleanup: async () => { unmount(); releaseValidation?.(); mount.remove(); await frame(); useSettingsStore.setState(settings); useNotesStore.setState(notes); window.__TAURI_INTERNALS__ = native; window.__TAURI_EVENT_PLUGIN_INTERNALS__ = events; delete window.__extraRemoval; } };
  root.render(React.createElement(UnifiedTree));
  await until(() => mount.textContent.includes('extra.md'), 'Extra-root fixture did not load');
  const button = mount.querySelector('button[title="Remove from tree (keeps local files)"]');
  const rect = button.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export async function verifyExtraRemovalUnmount() {
  const f = window.__extraRemoval;
  await until(() => f.validationReady(), 'Directory validation was not in flight');
  const notes = useNotesStore.getState().notes, projects = useNotesStore.getState().projects;
  const scans = f.calls.filter(call => ['get_all_notes', 'get_projects'].includes(call.command)).length;
  f.unmount(); f.releaseValidation(); await frame(); await frame();
  if (f.calls.filter(call => ['get_all_notes', 'get_projects'].includes(call.command)).length !== scans) throw new Error('Unmounted tree started a new scan after late validation');
  if (useNotesStore.getState().notes !== notes || useNotesStore.getState().projects !== projects) throw new Error('Unmounted validation changed shared library state');
  return { passed: true, unmountedValidationDoesNotScan: true, sharedStateUnchanged: true };
}

export async function verifyExtraRemovalFailure() {
  const f = window.__extraRemoval;
  await until(() => useSettingsStore.getState().saveStatus === 'error', 'Removal save failure was not exposed');
  if (!useSettingsStore.getState().config.extra_folders.includes(f.extra) || !f.mount.textContent.includes('extra.md') || !f.mount.textContent.includes('Extra')) throw new Error('Failed extra-root removal changed the active tree');
  if (f.calls.some(call => call.command === 'scope_roots_overlap')) throw new Error('Uncommitted removal started a scope validation');
  f.allow(); const button = f.mount.querySelector('button[title="Remove from tree (keeps local files)"]'); const rect = button.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export async function verifyExtraRemoval() {
  const f = window.__extraRemoval;
  await until(() => !useSettingsStore.getState().config.extra_folders.includes(f.extra), 'Removal did not commit');
  if (f.mode === 'disjoint') {
    await until(() => !f.mount.textContent.includes('extra.md'), 'Disjoint removed-root notes remained');
    if (f.calls.filter(call => call.command === 'get_all_notes').length !== 1) throw new Error('Disjoint removal rescanned the full library');
  } else {
    await until(() => f.calls.filter(call => call.command === 'get_all_notes').length === 2, 'Overlapping roots were not revalidated');
    await until(() => f.mode === 'hidden' ? !useNotesStore.getState().notes.some(note => note.path.startsWith(f.extra + '/')) : useNotesStore.getState().notes.some(note => note.path === `${f.mode === 'alias' ? f.kept : f.extra}/extra.md`), 'Retained scope contents were incorrect');
    if (f.mode === 'alias' && useNotesStore.getState().notes.some(note => note.path.startsWith(f.extra + '/'))) throw new Error('Alias removal kept the obsolete display path');
  }
  if (!f.mount.textContent.includes('main.md')) throw new Error('Removing an extra root removed main-library notes');
  return { passed: true, removalMode: f.mode, failedSaveKeepsTree: f.mode === 'disjoint', onlyOverlapsRescan: true };
}

export async function openWelcomeSaveFixture() {
  const native = window.__TAURI_INTERNALS__, previousEvents = window.__TAURI_EVENT_PLUGIN_INTERNALS__;
  const previous = useSettingsStore.getState(), previousNotes = useNotesStore.getState();
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  let fail = true, calls = [];
  const config = { ...previous.config, storage_path: '', extra_folders: [], debug_log: false, language: 'en' };
  window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, transformCallback() { return 1; }, unregisterCallback() {},
    async invoke(command, args = {}) {
      calls.push({ command, args });
      if (command === 'get_config') return config;
      if (command === 'start_scan_session') return 'browser-scan-session';
      if (['invalidate_scan', 'release_scan_lane'].includes(command)) return;
      if (command === 'plugin:dialog|open') return B;
      if (command === 'save_config') { if (fail) throw new Error('synthetic root-save failure'); return; }
      if (command === 'plugin:event|listen') return 1;
      if (['get_projects', 'get_all_notes', 'get_pending_open_files', 'get_document_recoveries', 'get_pinned_notes', 'get_sort_order'].includes(command)) return [];
      if (['set_always_on_top', 'start_watching', 'plugin:event|unlisten', 'write_log', 'write_logs'].includes(command)) return;
      if (command === 'detect_cloud_sync') return { status: 'Unavailable', icloud_path: null };
      if (command === 'get_sync_status') return 'unavailable';
      throw new Error(command);
    },
  };
  useSettingsStore.setState({ config, loaded: false, loadError: null, draftConfig: null, saveStatus: 'idle', saveError: null });
  const mount = document.createElement('div'); mount.style.cssText = 'position:fixed;inset:0'; document.body.append(mount);
  const root = createRoot(mount);
  window.__welcomeSave = { mount, calls, allow: () => { fail = false; }, cleanup: async () => { root.unmount(); mount.remove(); await frame(); useSettingsStore.setState(previous); useNotesStore.setState(previousNotes); window.__TAURI_INTERNALS__ = native; window.__TAURI_EVENT_PLUGIN_INTERNALS__ = previousEvents; delete window.__welcomeSave; } };
  root.render(React.createElement(App));
  await until(() => mount.textContent.includes('Select Notes Folder') && useSettingsStore.getState().loaded, 'Welcome screen did not load');
  const button = [...mount.querySelectorAll('button')].find(button => button.textContent.includes('Select Notes Folder'));
  const rect = button.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export async function verifyWelcomeSaveFailure() {
  const f = window.__welcomeSave;
  await until(() => f.mount.querySelector('[role=alert]'), 'Welcome folder save failure was not visible');
  if (!f.mount.textContent.includes('synthetic root-save failure')) throw new Error('Folder save error detail was lost');
  if (useSettingsStore.getState().config.storage_path !== '' || f.calls.some(call => call.command === 'get_all_notes')) throw new Error('Failed selection started the library');
  f.allow();
  const rect = f.mount.querySelector('[role=alert] button').getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export async function verifyWelcomeSaveRetry() {
  const f = window.__welcomeSave;
  await until(() => useSettingsStore.getState().config.storage_path === B && f.calls.some(call => call.command === 'get_all_notes'), 'Retry did not commit the selected folder');
  if (f.calls.filter(call => call.command === 'plugin:dialog|open').length !== 1) throw new Error('Retry reopened the folder picker instead of saving its draft');
  return { passed: true, initialFolderFailureVisible: true, failedRootNotActivated: true, retryCommitsDraft: true };
}

export async function testLibraryScanScopes() {
  const native = window.__TAURI_INTERNALS__, eventPlugin = window.__TAURI_EVENT_PLUGIN_INTERNALS__;
  const previousSettings = useSettingsStore.getState(), previousNotes = useNotesStore.getState();
  const callbacks = new Map(), listeners = new Map(), calls = [], pending = new Map(), counts = new Map();
  let id = 0, holdB = true;
  const emit = (event, payload) => { for (const [id, listener] of listeners) if (listener.event === event) listener.callback({ event, id, payload }); };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(listener) { listeners.delete(listener); } };
  const config = { ...previousSettings.config, storage_path: A, extra_folders: [], auto_save_interval: 0, debug_log: false, language: 'en', show_sidebar: true, show_notes_list: true };
  window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback(callback) { callbacks.set(++id, callback); return id; }, unregisterCallback(callbackId) { callbacks.delete(callbackId); },
    async invoke(command, args = {}) {
      calls.push({ command, args });
      if (command === 'plugin:event|listen') { const listener = ++id; listeners.set(listener, { event: args.event, callback: callbacks.get(args.handler) }); return listener; }
      if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
      if (command === 'get_config') return config;
      if (command === 'start_scan_session') return 'browser-scan-session';
      if (['invalidate_scan', 'release_scan_lane'].includes(command)) return;
      if (command === 'save_config') return;
      if (['get_pending_open_files', 'get_document_recoveries', 'get_pinned_notes', 'get_sort_order'].includes(command)) return [];
      if (['set_always_on_top', 'start_watching', 'write_log', 'write_logs'].includes(command)) return;
      if (command === 'plugin:app|version') return '1.0.42';
      if (command === 'detect_cloud_sync') return { status: 'Unavailable', icloud_path: null };
      if (command === 'get_sync_status') return 'unavailable';
      if (command === 'get_all_notes' || command === 'get_projects') {
        const key = `${command}:${args.rootPath}`, count = (counts.get(key) || 0) + 1; counts.set(key, count);
        const firstA = args.rootPath === A && count === 1;
        const rows = command === 'get_all_notes'
          ? [note(args.rootPath, args.rootPath === B ? 'B.md' : firstA ? 'old-A.md' : 'fresh-A.md')]
          : [project(args.rootPath, args.rootPath === B ? 'FolderB' : firstA ? 'FolderA' : 'FreshFolderA')];
        await frame();
        if (command === 'get_all_notes') {
          const partial = firstA ? [note(A, 'A.md')] : rows;
          emit('miaoyan://notes-chunk', { scan_id: args.scanId, data: { dir: args.rootPath, notes: partial } });
          emit('miaoyan://scan-total', { scan_id: args.scanId, data: 1 });
        } else emit('miaoyan://project-chunk', { scan_id: args.scanId, data: { ...rows[0], scanning: true } });
        if (firstA || (args.rootPath === B && holdB)) await new Promise(resolve => pending.set(args.scanId, resolve));
        return rows;
      }
      throw new Error(`Unexpected library fixture command: ${command}`);
    },
  };
  useSettingsStore.setState({ config: { ...config, storage_path: '' }, loaded: false, loadError: null, draftConfig: null, storageRevision: 0 });
  useNotesStore.setState({ notes: [], projects: [], activeNote: null, activeContent: '', activeFolder: null, openTabs: [], activeTabPath: null, isDirty: false, isLoading: false, searchQuery: '', searchResults: [], allNotesExpanded: true });
  const mount = document.createElement('div'); mount.style.cssText = 'position:fixed;inset:0'; document.body.append(mount);
  const root = createRoot(mount);
  const counter = () => mount.querySelector('.overflow-y-auto')?.firstElementChild?.lastElementChild?.textContent;
  try {
    root.render(React.createElement(App));
    await until(() => mount.textContent.includes('A.md'), 'Initial tagged scan chunk was not rendered');
    const oldNotes = calls.find(call => call.command === 'get_all_notes' && call.args.rootPath === A);
    const oldProjects = calls.find(call => call.command === 'get_projects' && call.args.rootPath === A);
    await useSettingsStore.getState().updateConfig({ storage_path: B });
    await until(() => mount.textContent.includes('B.md') && calls.some(call => call.command === 'get_all_notes' && call.args.rootPath === B), 'Committed storage change did not load the new library');
    await frame();
    if (counter() !== '1/1') throw new Error(`New root retained old cached rows or failed to start its own scan: ${counter()}`);
    emit('miaoyan://scan-total', { scan_id: oldNotes.args.scanId, data: 999 }); await frame();
    if (counter() !== '1/1') throw new Error('Old scan total changed the current library progress');
    holdB = false;
    for (const call of calls.filter(call => call.args.rootPath === B)) pending.get(call.args.scanId)?.();
    await until(() => counter() === '1' && !useNotesStore.getState().isLoading, 'Current scan did not finish its progress state');
    await useSettingsStore.getState().updateConfig({ storage_path: A });
    await until(() => mount.textContent.includes('fresh-A.md') && counter() === '1', 'A/B/A did not request a fresh A snapshot');
    emit('miaoyan://notes-chunk', { scan_id: oldNotes.args.scanId, data: { dir: A, notes: [note(A, 'ghost.md')] } });
    emit('miaoyan://project-chunk', { scan_id: oldProjects.args.scanId, data: project(A, 'GhostFolder') });
    pending.get(oldNotes.args.scanId)?.(); pending.get(oldProjects.args.scanId)?.();
    await frame(); await frame();
    if (mount.textContent.includes('ghost.md') || mount.textContent.includes('GhostFolder') || counter() !== '1') throw new Error('Stale A events or replies resurfaced after A/B/A');
    if (useNotesStore.getState().notes.some(item => item.path.endsWith('old-A.md'))) throw new Error('Old store snapshot resurfaced');
    if (calls.filter(call => call.command === 'get_all_notes' && call.args.rootPath === B).length !== 1) throw new Error('App and tree duplicated the new root disk scan');
    return { passed: true, committedRootReloads: true, oldCacheCleared: true, progressScoped: true, abaChunksAndRepliesRejected: true, sharedDiskScan: true };
  } finally {
    for (const release of pending.values()) release();
    root.unmount(); mount.remove(); await frame();
    useSettingsStore.setState(previousSettings); useNotesStore.setState(previousNotes);
    window.__TAURI_INTERNALS__ = native; window.__TAURI_EVENT_PLUGIN_INTERNALS__ = eventPlugin;
  }
}
