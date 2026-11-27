import { preview } from 'vite';

function installNative(config) {
  const calls = [], errors = [], disk = new Map();
  let id = 0;
  window.__productionFixture = { calls, errors };
  window.addEventListener('error', event => errors.push(event.message));
  window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback() { return ++id; }, unregisterCallback() {},
    convertFileSrc: path => `http://asset.localhost/${path}`,
    async invoke(command, args = {}) {
      calls.push({ command, args });
      if (command === 'get_config') return config;
      if (command === 'start_scan_session') return 'production-scan-session';
      if (['invalidate_scan', 'release_scan_lane'].includes(command)) return;
      if (['get_projects', 'get_all_notes', 'get_pending_open_files', 'get_document_recoveries', 'get_pinned_notes', 'get_sort_order'].includes(command)) return [];
      if (['set_always_on_top', 'start_watching', 'plugin:event|unlisten', 'write_log', 'write_logs'].includes(command)) return;
      if (command === 'plugin:event|listen') return ++id;
      if (command === 'plugin:app|version') return '1.0.42';
      if (command === 'detect_cloud_sync') return { status: 'Unavailable', icloud_path: null };
      if (command === 'get_sync_status') return 'unavailable';
      if (command === 'create_note') {
        const path = `${args.folderPath}/${args.title}.md`;
        disk.set(path, '');
        return { id: path, path, title: `${args.title}.md`, folder: args.folderPath, created_at: '', modified_at: '', pinned: false, size: 0, is_encrypted: false, disk_version: '' };
      }
      if (command === 'read_note') return { id: args.path, content: disk.get(args.path) ?? '', disk_version: disk.get(args.path) ?? '' };
      if (command === 'write_note') {
        if (args.expectedVersion !== (disk.get(args.path) ?? '')) throw new Error('DiskConflict');
        disk.set(args.path, args.content); return args.content;
      }
      if (command === 'read_annotations') return { document_id: 'production-fixture', json: '[]' };
      if (command === 'parse_markdown') return `<p>${args.content}</p>`;
      throw new Error(`Unexpected production fixture command: ${command}`);
    },
  };
}

export async function runProductionBrowser(send, config) {
  const server = await preview({ logLevel: 'silent', preview: { host: '127.0.0.1', port: 0, strictPort: true } });
  let targetId;
  try {
    ({ targetId } = await send('Target.createTarget', { url: 'about:blank' }));
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result?.value;
    };
    const until = (condition, label) => evaluate(`(async () => {
      const deadline=performance.now()+7000;
      while(performance.now()<deadline){if(${condition})return;await new Promise(requestAnimationFrame);}
      throw new Error(${JSON.stringify(label)}+JSON.stringify(window.__productionFixture?.errors));
    })()`);
    const key = async (key, code, keyCode) => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers: 2 }, sessionId);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers: 2 }, sessionId);
    };
    await send('Page.enable', {}, sessionId);
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `(${installNative.toString()})(${JSON.stringify({ ...config, storage_path: 'C:/production-fixture', extra_folders: [], language: 'en', debug_log: false, auto_save_interval: 0 })})` }, sessionId);
    await send('Page.navigate', { url: `http://127.0.0.1:${server.httpServer.address().port}/` }, sessionId);
    await until("window.__productionFixture?.calls.some(call=>call.command==='get_all_notes')", 'Production startup failed: ');
    const eager = await evaluate("performance.getEntriesByType('resource').filter(entry=>/\\/(Editor|PdfViewer)-/.test(entry.name)).map(entry=>entry.name)");
    if (eager.length) throw new Error(`Production eagerly loaded deferred features: ${eager}`);
    await key('n', 'KeyN', 78);
    await until("document.querySelector('.cm-content')", 'Production editor did not load: ');
    await evaluate("document.querySelector('.cm-content').focus()");
    await send('Input.insertText', { text: 'production saved body' }, sessionId);
    await key('s', 'KeyS', 83);
    await until("window.__productionFixture.calls.some(call=>call.command==='write_note'&&call.args.content==='production saved body')", 'Production editor did not save: ');
    const errors = await evaluate('window.__productionFixture.errors');
    if (errors.length) throw new Error(`Production runtime errors: ${errors.join('; ')}`);
    return { passed: true, productionStartup: true, lazyEditor: true, realInputSaved: true };
  } finally {
    if (targetId) await send('Target.closeTarget', { targetId });
    await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
  }
}
