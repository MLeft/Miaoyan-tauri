import React from 'react';
import { createRoot } from 'react-dom/client';
import { UnifiedTree } from '../src/components/sidebar/UnifiedTree';
import { useNotesStore } from '../src/stores/notes-store';
import { useSettingsStore } from '../src/stores/settings-store';

const rootPath = 'C:/watch-fixture', a = `${rootPath}/a.md`, incoming = `${rootPath}/incoming`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, message) => {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(requestAnimationFrame);
  }
  throw new Error(message);
};

export async function testWatcherRefresh() {
  const native = window.__TAURI_INTERNALS__, eventPlugin = window.__TAURI_EVENT_PLUGIN_INTERNALS__;
  const config = useSettingsStore.getState().config, previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  const files = new Map([[a, 'alpha']]), dirs = new Set([rootPath]);
  const callbacks = new Map(), listeners = new Map(), calls = [], warnings = [];
  const warning = event => warnings.push(event.detail);
  window.addEventListener('show-toast', warning);
  const note = path => ({ id: path, path, title: path.split('/').pop(), folder: path.slice(0, path.lastIndexOf('/')), created_at: '', modified_at: '2026-01-01T00:00:00Z', pinned: false, size: files.get(path)?.length ?? 0, is_encrypted: false });
  const project = path => ({ name: path.split('/').pop(), path, is_root: false,
    children: [...dirs].filter(child => child !== path && child.slice(0, child.lastIndexOf('/')) === path).map(project) });
  const snapshot = path => ({ project: dirs.has(path) ? project(path) : null,
    notes: dirs.has(path) ? [...files.keys()].filter(file => file.startsWith(path + '/')).map(note) : [] });
  let id = 0, releaseMetadata, holdMetadata = false, metadataRunning = 0, maxMetadataRunning = 0;
  let releaseDirectory, holdDirectory = false;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(listener) { listeners.delete(listener); } };
  window.__TAURI_INTERNALS__ = { ...native, transformCallback(callback) { callbacks.set(++id, callback); return id; }, unregisterCallback(callbackId) { callbacks.delete(callbackId); },
    async invoke(command, args = {}) {
      calls.push({ command, args });
      if (command === 'plugin:event|listen') { const listener = ++id; listeners.set(listener, { event: args.event, callback: callbacks.get(args.handler) }); return listener; }
      if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
      if (command === 'start_watching') throw new Error('synthetic watcher registration failure');
      if (command === 'start_scan_session') return 'browser-scan-session';
      if (['invalidate_scan', 'release_scan_lane'].includes(command)) return;
      if (['write_log', 'write_logs'].includes(command)) return;
      if (command === 'get_all_notes') return [...files.keys()].map(note);
      if (command === 'get_notes_metadata') {
        const result = args.paths.filter(path => files.has(path)).map(note);
        maxMetadataRunning = Math.max(maxMetadataRunning, ++metadataRunning);
        if (holdMetadata) { holdMetadata = false; await new Promise(resolve => { releaseMetadata = resolve; }); }
        metadataRunning--;
        return result;
      }
      if (command === 'read_directory_snapshot') {
        const result = snapshot(args.path);
        if (holdDirectory) { holdDirectory = false; await new Promise(resolve => { releaseDirectory = resolve; }); }
        return result;
      }
      if (command === 'read_note') return { id: args.path, content: files.get(args.path), disk_version: files.get(args.path) };
      if (command === 'write_note') { if (files.get(args.path) !== args.expectedVersion) throw new Error('DiskConflict'); files.set(args.path, args.content); return args.content; }
      if (command === 'detect_cloud_sync') return { status: 'Unavailable', icloud_path: null };
      if (command === 'get_sync_status') return 'unavailable';
      throw new Error(command);
    },
  };
  const emit = (event, payload) => { for (const [id, listener] of listeners) if (listener.event === event) listener.callback({ event, id, payload }); };
  useSettingsStore.setState({ config: { ...config, storage_path: rootPath, extra_folders: [], auto_save_interval: 0, debug_log: false } });
  await useNotesStore.getState().setSearchQuery('', rootPath);
  await useNotesStore.getState().openTemporaryFile(a);
  useNotesStore.setState({ projects: [], notes: [note(a)], allNotesExpanded: true, expandedFolders: [] });
  const mount = document.createElement('div'); mount.style.cssText = 'position:fixed;left:0;top:0;width:340px;height:650px'; document.body.append(mount);
  const root = createRoot(mount); root.render(React.createElement(UnifiedTree));
  try {
    await until(() => [...listeners.values()].some(listener => listener.event === 'fs-change') && mount.textContent.includes('a.md'), 'Watcher fixture did not initialize');
    await until(() => warnings.some(warning => warning.type === 'warning' && warning.message.includes('watcher registration failure')), 'Watcher startup failure was not visible');
    useNotesStore.getState().updateContent('saved', ''); await useNotesStore.getState().saveCurrentNote();
    files.set(a, 'omega'); emit('fs-change', { type: 'modify', paths: [a] });
    await until(() => useNotesStore.getState().activeContent === 'omega', 'Own-save time window or equal metadata swallowed an external change');
    const revision = useNotesStore.getState().getDocumentRevision(a);
    emit('fs-change', { type: 'modify', paths: [a] }); await pause(600);
    if (useNotesStore.getState().getDocumentRevision(a) !== revision || useNotesStore.getState().isDirty) throw new Error('Own/duplicate event changed editor history or dirtied the document');

    dirs.add(incoming); dirs.add(`${incoming}/deep`); files.set(`${incoming}/deep/old.md`, 'imported body');
    emit('fs-structure', { kind: 'dir-create', path: incoming });
    await until(() => useNotesStore.getState().notes.some(note => note.path.endsWith('/old.md')), 'Nonempty moved-in directory did not load its notes');
    if (!useNotesStore.getState().projects.find(item => item.path === incoming)?.children.some(child => child.path.endsWith('/deep'))) throw new Error('Imported child directory was not synchronized');
    useNotesStore.setState({ expandedFolders: [incoming, `${incoming}/deep`] });
    files.delete(`${incoming}/deep/old.md`); files.set(`${incoming}/deep/new.md`, 'replacement');
    emit('fs-structure', { kind: 'path-remove', path: incoming }); emit('fs-structure', { kind: 'dir-create', path: incoming });
    await until(() => useNotesStore.getState().notes.some(note => note.path.endsWith('/new.md')) && !useNotesStore.getState().notes.some(note => note.path.endsWith('/old.md')), 'Recreated directory retained stale descendants');
    if (!useNotesStore.getState().expandedFolders.includes(`${incoming}/deep`)) throw new Error('Directory replacement unnecessarily collapsed its surviving children');

    holdMetadata = true;
    const raced = `${rootPath}/raced.md`; files.set(raced, 'old metadata'); emit('fs-change', { type: 'create', paths: [raced] });
    await until(() => typeof releaseMetadata === 'function', 'Metadata hold was not reached');
    files.delete(raced); emit('fs-change', { type: 'remove', paths: [raced] });
    releaseMetadata(); await pause(1000);
    if (useNotesStore.getState().notes.some(note => note.path === raced)) throw new Error('Late metadata resurrected a deleted file');
    if (maxMetadataRunning !== 1) throw new Error('Metadata batches overlapped instead of being coalesced');

    holdDirectory = true;
    emit('fs-structure', { kind: 'dir-create', path: incoming });
    await until(() => typeof releaseDirectory === 'function', 'Directory hold was not reached');
    for (const path of [...dirs]) if (path.startsWith(incoming)) dirs.delete(path);
    for (const path of [...files.keys()]) if (path.startsWith(incoming + '/')) files.delete(path);
    emit('fs-structure', { kind: 'path-remove', path: incoming }); releaseDirectory();
    await until(() => !useNotesStore.getState().projects.some(project => project.path === incoming) && !useNotesStore.getState().notes.some(note => note.path.startsWith(incoming + '/')), 'Late subtree result resurrected a removed directory');
    const resynced = `${rootPath}/overflow-recovered.md`; files.set(resynced, 'resynced');
    emit('fs-change', { type: 'rescan', paths: [rootPath] });
    await until(() => useNotesStore.getState().notes.some(note => note.path === resynced), 'Native overflow notification did not refresh the configured root');
    const burst = Array.from({ length: 1300 }, (_, index) => `${rootPath}/burst-${index}.md`);
    for (const path of burst) files.set(path, 'burst');
    emit('fs-change', { type: 'create', paths: burst });
    await until(() => useNotesStore.getState().notes.filter(note => note.path.includes('/burst-')).length === 1300, 'Bounded queue lost the final burst state');
    if (calls.some(call => call.command === 'get_notes_metadata' && call.args.paths.length > 1024)) throw new Error('Frontend event queue exceeded its metadata batch budget');
    files.clear(); dirs.clear(); emit('fs-change', { type: 'rescan', paths: [rootPath] });
    await until(() => useNotesStore.getState().notes.length === 0 && useNotesStore.getState().projects.length === 0, 'A removed configured root retained its stale tree');
    if (calls.filter(call => call.command === 'get_all_notes').length !== 1) throw new Error('Incremental directory changes triggered a full-library scan');
    return { passed: true, removedRootCleared: true, overflowResync: true, boundedMetadataBurst: true, ownSaveDoesNotHideExternalEdit: true, unchangedMetadataStillReloads: true, movedInSubtree: true, replacementKeepsExpansion: true, latestMetadataWins: true, removedSubtreeNotResurrected: true, noFullLibraryRescan: true };
  } finally {
    releaseMetadata?.(); releaseDirectory?.();
    root.unmount(); mount.remove();
    window.removeEventListener('show-toast', warning);
    const store = useNotesStore.getState();
    for (const tab of [...store.openTabs]) store.discardDocument(tab.path, store.getDocumentSession(tab.path).identity);
    useSettingsStore.setState({ config }); window.__TAURI_INTERNALS__ = native; window.__TAURI_EVENT_PLUGIN_INTERNALS__ = eventPlugin;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
}
