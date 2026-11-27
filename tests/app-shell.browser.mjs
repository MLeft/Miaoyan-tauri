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
