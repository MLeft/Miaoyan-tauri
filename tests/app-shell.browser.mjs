async function until(predicate, message) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(requestAnimationFrame);
  }
  throw new Error(message);
}

export async function testManualUpdateStartup(failConfig = false) {
  const previous = window.__TAURI_INTERNALS__;
  const previousEvents = window.__TAURI_EVENT_PLUGIN_INTERNALS__;
  const calls = [];
  const callbacks = new Map();
  let id = 0, config;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback(callback) { callbacks.set(++id, callback); return id; },
    unregisterCallback(callbackId) { callbacks.delete(callbackId); },
    async invoke(command) {
      calls.push(command);
      if (command === 'get_config') {
        if (failConfig) throw new Error('synthetic invalid configuration');
        return config;
      }
      if (command === 'start_scan_session') return 'browser-scan-session';
      if (['invalidate_scan', 'release_scan_lane'].includes(command)) return;
      if (['get_projects', 'get_all_notes', 'get_pending_open_files', 'get_document_recoveries', 'get_pinned_notes', 'get_sort_order'].includes(command)) return [];
      if (['set_always_on_top', 'start_watching', 'plugin:event|unlisten', 'write_log', 'write_logs'].includes(command)) return;
      if (command === 'plugin:event|listen') return ++id;
      if (command === 'plugin:app|version') return '1.0.42';
      if (command === 'plugin:updater|check') return null;
      if (command === 'detect_cloud_sync') return { status: 'Unavailable', icloud_path: null };
      if (command === 'get_sync_status') return 'unavailable';
      throw new Error(`Unexpected app-shell command: ${command}`);
    },
  };
  const [React, { createRoot }, { default: App }, { useSettingsStore }] = await Promise.all([
    import('react'), import('react-dom/client'), import('../src/App'), import('../src/stores/settings-store'),
  ]);
  const previousConfig = useSettingsStore.getState().config;
  config = { ...previousConfig, storage_path: 'C:/app-shell-fixture', extra_folders: [], debug_log: false, auto_save_interval: 0, language: 'en' };
  const mount = document.createElement('div');
  mount.style.cssText = 'position:fixed;inset:0';
  document.body.append(mount);
  const root = createRoot(mount);
  try {
    root.render(React.createElement(App));
    if (failConfig) {
      await until(() => mount.querySelector('[role=alert]'), 'Configuration failure was not shown');
      if (!mount.textContent.includes('synthetic invalid configuration')) throw new Error('Configuration failure detail was lost');
      if (calls.some(command => ['get_all_notes', 'start_watching', 'save_config', 'get_pending_open_files'].includes(command))) throw new Error('Library work started with invalid configuration');
      failConfig = false;
      mount.querySelector('[role=alert] button').click();
      await until(() => calls.includes('get_all_notes'), 'Configuration retry did not start the library');
      return { passed: true, invalidConfigurationIsolated: true, retryStartedLibrary: true };
    }
    await until(() => calls.includes('get_all_notes'), 'Application did not finish initial library loading');
    await new Promise(resolve => setTimeout(resolve, 3200));
    if (calls.some(command => command.startsWith('plugin:updater|'))) throw new Error('Manual update mode still invokes the native updater at startup');
    if (performance.getEntriesByType('resource').some(entry => entry.name.includes('/src/components/editor/Editor.tsx'))) throw new Error('Empty startup still loads the CodeMirror editor');
    return { passed: true, manualUpdatesOnly: true, emptyStartupDefersEditor: true };
  } finally {
    root.unmount();
    await new Promise(resolve => setTimeout(resolve, 0));
    mount.remove();
    useSettingsStore.setState({ config: previousConfig });
    if (previous === undefined) delete window.__TAURI_INTERNALS__;
    else window.__TAURI_INTERNALS__ = previous;
    if (previousEvents === undefined) delete window.__TAURI_EVENT_PLUGIN_INTERNALS__;
    else window.__TAURI_EVENT_PLUGIN_INTERNALS__ = previousEvents;
  }
}

export async function testSearchKeepsFilterWhenOpeningPdf() {
  const previous = window.__TAURI_INTERNALS__;
  const previousEvents = window.__TAURI_EVENT_PLUGIN_INTERNALS__;
  const callbacks = new Map();
  let id = 0;
  const root = 'C:/search-pdf-fixture';
  const note = name => ({ id: `${root}/${name}`, path: `${root}/${name}`, title: name, folder: root, created_at: '2026-01-01T00:00:00Z', modified_at: '2026-01-01T00:00:00Z', size: 1, pinned: false, is_encrypted: false });
  const notes = [note('manual.pdf'), note('alpha.md')];
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback(callback) { callbacks.set(++id, callback); return id; }, unregisterCallback(callbackId) { callbacks.delete(callbackId); },
    async invoke(command) {
      if (command === 'get_config') return { ...useSettingsStore.getState().config, storage_path: root, extra_folders: [], debug_log: false, auto_save_interval: 0, language: 'en' };
      if (command === 'start_scan_session') return 'browser-scan-session';
      if (command === 'start_search_session') return 'browser-search-session';
      if (['invalidate_scan', 'release_scan_lane', 'invalidate_search', 'save_config', 'start_watching', 'plugin:event|unlisten', 'write_log', 'write_logs', 'set_always_on_top'].includes(command)) return;
      if (command === 'get_all_notes') return notes;
      if (['get_projects', 'get_pending_open_files', 'get_document_recoveries', 'get_pinned_notes', 'get_sort_order'].includes(command)) return [];
      if (command === 'plugin:event|listen') return ++id;
      if (command === 'plugin:app|version') return '1.0.44';
      if (command === 'search_notes') return [notes[0]];
      if (command === 'detect_cloud_sync') return { status: 'Unavailable', icloud_path: null };
      if (command === 'get_sync_status') return 'unavailable';
      return null;
    },
  };
  const [React, { createRoot }, { default: App }, { useNotesStore }, { useSettingsStore }] = await Promise.all([
    import('react'), import('react-dom/client'), import('../src/App'), import('../src/stores/notes-store'), import('../src/stores/settings-store'),
  ]);
  const previousConfig = useSettingsStore.getState().config;
  const previousNotesState = useNotesStore.getState();
  const previousSettings = useSettingsStore.getState();
  const mount = document.createElement('div');
  mount.style.cssText = 'position:fixed;inset:0';
  document.body.append(mount);
  const rootEl = createRoot(mount);
  const input = () => [...mount.querySelectorAll('input')].find(element => element.placeholder === 'Search...');
  try {
    rootEl.render(React.createElement(App));
    await until(() => mount.textContent.includes('alpha.md'), 'Library fixture did not render');
    const search = await new Promise(resolve => {
      const poll = () => { const element = input(); if (element) resolve(element); else requestAnimationFrame(poll); };
      poll();
    });
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, '.pd');
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await until(() => useNotesStore.getState().searchStatus === 'idle' && mount.textContent.includes('manual.pdf'), 'Search results were not rendered');
    if (mount.textContent.includes('alpha.md')) throw new Error('Non-matching note survived the active filter');
    const row = [...mount.querySelectorAll('div')].find(element => element.textContent.trim().startsWith('manual.pdf') && element.className.includes('cursor-pointer'));
    if (!row) throw new Error('PDF search result row missing');
    row.click();
    await until(() => useNotesStore.getState().activeNote?.path === `${root}/manual.pdf`, 'PDF did not become active');
    await new Promise(resolve => setTimeout(resolve, 300));
    if (useNotesStore.getState().searchQuery !== '.pd') throw new Error('Opening a PDF cleared the active query');
    if (search.value !== '.pd') throw new Error('Search input and shared query diverged after opening a PDF');
    if (mount.textContent.includes('alpha.md')) throw new Error('Opening a PDF reset the tree to the full library');
    return { passed: true, pdfSearchOpenKeepsFilter: true, queryRetained: true };
  } finally {
    await useNotesStore.getState().setSearchQuery('', root);
    rootEl.unmount();
    await new Promise(resolve => setTimeout(resolve, 0));
    mount.remove();
    useSettingsStore.setState(previousConfig ? { ...previousSettings, config: previousConfig } : previousSettings);
    useNotesStore.setState(previousNotesState);
    if (previous === undefined) delete window.__TAURI_INTERNALS__; else window.__TAURI_INTERNALS__ = previous;
    if (previousEvents === undefined) delete window.__TAURI_EVENT_PLUGIN_INTERNALS__; else window.__TAURI_EVENT_PLUGIN_INTERNALS__ = previousEvents;
  }
}
