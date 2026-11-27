import { createRoot } from 'react-dom/client';
import React from 'react';
import { UnifiedTree } from '../src/components/sidebar/UnifiedTree';
import { useNotesStore } from '../src/stores/notes-store';
import { useSettingsStore } from '../src/stores/settings-store';

const rootPath = 'C:/search-fixture', extra = 'C:/extra-fixture';
const folder = `${rootPath}/Manuals`;
const note = (path, body) => ({ id: path, path, title: path.split('/').pop(), folder: path.slice(0, path.lastIndexOf('/')), created_at: '', modified_at: '', pinned: false, size: body.length, is_encrypted: false, body });
const notes = [note(`${rootPath}/needle-title.md`, 'plain'), note(`${extra}/reference.md`, 'needle in body'), note(`${folder}/overview.md`, 'manual content')];
const until = async (predicate, message) => {
  const deadline = performance.now() + 4000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(requestAnimationFrame);
  }
  throw new Error(message);
};

export async function openSearchFixture(size = notes.length) {
  const library = [...notes, ...Array.from({ length: size - notes.length }, (_, index) => note(`${rootPath}/bulk-${index}.md`, 'plain'))];
  const previousNative = window.__TAURI_INTERNALS__;
  const previousEvents = window.__TAURI_EVENT_PLUGIN_INTERNALS__;
  const previousConfig = useSettingsStore.getState().config;
  const { notes: previousNotes, projects: previousProjects, expandedFolders: previousExpanded, allNotesExpanded: previousAllExpanded, activeFolder: previousFolder } = useNotesStore.getState();
  const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  const calls = [];
  let callback = 0, release, activeSearch, fail = false;
  const canceled = [];
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback() { return ++callback; }, unregisterCallback() {},
    async invoke(command, args) {
      calls.push({ command, args });
      if (command === 'get_all_notes') return library;
      if (command === 'start_search_session') return 'browser-search-session';
      if (command === 'start_scan_session') return 'browser-scan-session';
      if (['invalidate_scan', 'release_scan_lane'].includes(command)) return;
      if (command === 'invalidate_search') {
        if (activeSearch && args.generation > activeSearch.generation) { canceled.push(activeSearch.generation); release?.(); }
        return;
      }
      if (command === 'plugin:event|listen') return ++callback;
      if (['plugin:event|unlisten', 'start_watching', 'write_log', 'write_logs'].includes(command)) return;
      if (command === 'detect_cloud_sync') return { status: 'Unavailable', icloud_path: null };
      if (command === 'get_sync_status') return 'unavailable';
      if (command === 'search_notes') {
        activeSearch = args;
        if (args.query === 'needle') await new Promise(resolve => { release = resolve; });
        activeSearch = null;
        if (fail) throw new Error('synthetic search failure');
        const roots = [args.rootPath, ...args.extraFolders];
        return library.filter(note => roots.some(root => note.path.startsWith(root + '/')) && `${note.title} ${note.body}`.includes(args.query));
      }
      throw new Error(`Unexpected search fixture command: ${command}`);
    },
  };
  useSettingsStore.setState({ config: { ...previousConfig, storage_path: rootPath, extra_folders: [extra], debug_log: false } });
  await useNotesStore.getState().setSearchQuery('', rootPath);
  useNotesStore.setState({ projects: [{ name: 'Manuals', path: folder, children: [] }, { name: 'Extra', path: extra, children: [] }], notes: library, activeFolder: null, expandedFolders: [folder], allNotesExpanded: true });
  const mount = document.createElement('div');
  mount.style.cssText = 'position:fixed;top:0;left:0;width:350px;height:650px';
  document.body.append(mount);
  const root = createRoot(mount);
  window.__searchFixture = { mount, calls, canceled, release: () => release?.(), fail: value => { fail = value; },
    async cleanup() {
      release?.();
      await useNotesStore.getState().setSearchQuery('', rootPath);
      root.unmount(); mount.remove();
      useNotesStore.setState({ notes: previousNotes, projects: previousProjects, expandedFolders: previousExpanded, allNotesExpanded: previousAllExpanded, activeFolder: previousFolder });
      useSettingsStore.setState({ config: previousConfig });
      window.__TAURI_INTERNALS__ = previousNative;
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = previousEvents;
      globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
      delete window.__searchFixture;
    },
  };
  root.render(React.createElement(UnifiedTree));
  await until(() => mount.textContent.includes('needle-title.md'), 'Initial tree did not load');
  mount.querySelector('input').focus();
}

export async function waitForPendingSearch() {
  await until(() => window.__searchFixture.calls.some(call => call.command === 'search_notes'), 'No native search was in flight');
  window.__searchFixture.mount.querySelector('input').select();
}

export async function checkCancelledSearch() {
  const f = window.__searchFixture;
  const old = f.calls.find(call => call.command === 'search_notes');
  await until(() => useNotesStore.getState().searchQuery === '' && f.canceled.includes(old.args.generation), 'Clearing input did not cancel the native request');
  await new Promise(requestAnimationFrame);
  if (useNotesStore.getState().searchResults.length !== 0 || useNotesStore.getState().searchStatus !== 'idle') throw new Error('Canceled result resurfaced or left search loading');
  if (!f.mount.textContent.includes('overview.md')) throw new Error('Clearing restored search lost the expanded tree');
  if (f.calls.filter(call => call.command === 'get_all_notes').length !== 1) throw new Error('Canceling search rescanned the library');
  return { passed: true, nativeCancellationRequested: true, oldResultsDiscarded: true, clearKeepsTree: true };
}

export async function checkRootChangeSearch() {
  const f = window.__searchFixture;
  const old = f.calls.find(call => call.command === 'search_notes');
  useSettingsStore.setState({ config: { ...useSettingsStore.getState().config, extra_folders: [] } });
  await until(() => f.canceled.includes(old.args.generation), 'Changing search roots did not cancel the old native query');
  await until(() => f.calls.filter(call => call.command === 'search_notes').length === 2, 'Changing roots did not start a replacement query');
  const latest = f.calls.filter(call => call.command === 'search_notes')[1];
  if (latest.args.extraFolders.length !== 0) throw new Error('Replacement query still searched removed roots');
  f.release();
  await until(() => useNotesStore.getState().searchStatus === 'idle', 'Replacement query did not finish');
  if (useNotesStore.getState().searchResults.some(note => note.path.startsWith(extra + '/'))) throw new Error('Removed root results resurfaced');
  return { passed: true, rootChangeCancelsOldSearch: true, removedRootExcluded: true };
}

export async function prepareLargeSearch() {
  const f = window.__searchFixture;
  if (useNotesStore.getState().notes.length !== 50000) throw new Error('Large library fixture did not load all notes');
  const tree = f.mount.querySelector('.overflow-y-auto');
  tree.scrollTop = tree.scrollHeight;
  await until(() => f.mount.textContent.includes('bulk-49996.md'), 'Last note was not reachable by scrolling');
  f.domElements = f.mount.querySelectorAll('*').length;
  if (f.domElements > 1500) throw new Error(`Large tree mounted too many elements: ${f.domElements}`);
  f.mount.addEventListener('input', () => { f.inputAt = performance.now(); }, { capture: true, once: true });
  f.mount.querySelector('input').focus();
}

export async function checkLargeSearch() {
  const f = window.__searchFixture;
  await until(() => useNotesStore.getState().searchQuery === 'needle' && f.mount.textContent.includes('needle-title.md'), 'Search from the bottom of a large tree did not show the immediate filename match');
  const filenameRenderMs = performance.now() - f.inputAt;
  if (filenameRenderMs > 500) throw new Error(`Large library filename search took ${filenameRenderMs}ms`);
  await checkBodySearch();
  const elements = f.mount.querySelectorAll('*').length;
  if (elements > 1500) throw new Error('Filtered results bypassed virtualization');
  return { passed: true, notes: 50000, bottomNoteReachable: true, domElements: f.domElements, filenameRenderMs: Math.round(filenameRenderMs), bodyResultFromExtraRoot: true };
}

export async function checkBodySearch() {
  const f = window.__searchFixture;
  await until(() => f.calls.some(call => call.command === 'search_notes'), 'Typing did not start full-text search');
  if (!f.mount.textContent.includes('needle-title.md')) throw new Error('Immediate filename result was lost');
  f.release();
  await until(() => f.mount.textContent.includes('reference.md'), 'Body-only result from extra folder was not rendered');
  const search = f.calls.find(call => call.command === 'search_notes');
  if (search.args.extraFolders[0] !== extra) throw new Error('Extra roots were not searched');
}

export async function checkClearedSearch() {
  const f = window.__searchFixture;
  await until(() => useNotesStore.getState().searchQuery === '', 'Input and shared query diverged');
  if (!useNotesStore.getState().expandedFolders.includes(folder)) throw new Error('Clearing search lost the original expanded folders');
  if (f.calls.filter(call => call.command === 'get_all_notes').length !== 1) throw new Error('Clearing search caused a full library rescan');
  f.fail(true);
}

export async function checkSearchRetry() {
  const f = window.__searchFixture;
  await until(() => f.mount.querySelector('[role=alert]'), 'Search failure was not visible');
  f.fail(false);
  f.mount.querySelector('[role=alert] button').click();
  await until(() => useNotesStore.getState().searchStatus === 'idle', 'Search retry failed');
  if (!f.mount.textContent.includes('overview.md')) throw new Error('Retried body match was not displayed');
  return { passed: true, bodyMatchesExtraRoots: true, sharedQuery: true, clearKeepsExpansion: true, failureRetry: true };
}
