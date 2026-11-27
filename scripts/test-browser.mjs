import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPreviewBrowser } from '../tests/preview.browser.mjs';
import { runProductionBrowser } from '../tests/production.browser.mjs';

const binary = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome');
const profile = await mkdtemp(path.join(tmpdir(), 'miaoyan-browser-test-'));
const chrome = spawn(binary, [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--window-size=1024,768', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Chrome debugging endpoint did not start')), 20000);
    let output = '';
    chrome.once('error', (error) => { clearTimeout(timeout); reject(error); });
    chrome.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Chrome exited before connection: ${code}`)); });
    chrome.stderr.on('data', (data) => {
      output = (output + data).slice(-8192);
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  const loaded = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Browser regression page did not load')), 20000);
    const listener = ({ data }) => {
      const event = JSON.parse(data);
      if (event.sessionId === sessionId && event.method === 'Page.loadEventFired') {
        clearTimeout(timeout);
        socket.removeEventListener('message', listener);
        resolve();
      }
    };
    socket.addEventListener('message', listener);
  });
  await send('Page.navigate', { url: 'http://127.0.0.1:1420/tests/browser.html' }, sessionId);
  await loaded;
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  const startupResult = await evaluate("import('/tests/app-shell.browser.mjs').then(test => test.testManualUpdateStartup())");
  const results = await evaluate("(async () => { const page = await import('/tests/pdf-lifecycle.browser.mjs'); const viewer = await import('/tests/pdf-viewer.browser.mjs'); const formatter = await import('/tests/formatter.browser.mjs'); const editor = await import('/tests/editor-revision.browser.mjs'); return [await page.testPdfPageLifecycle(), await page.testPdfPageLifecycle(5), await viewer.testPdfViewerFirstFrameAndRestore(), await formatter.testMarkdownFormatting(), await editor.testEditorRevision()]; })()");
  results.unshift(startupResult);
  results.push(await evaluate("import('/tests/app-shell.browser.mjs').then(test => test.testManualUpdateStartup(true))"));
  results.push(await evaluate("import('/tests/app-shell.browser.mjs').then(test => test.testSearchKeepsFilterWhenOpeningPdf())"));
  results.push(await evaluate("import('/tests/library-scans.browser.mjs').then(test => test.testLibraryScanScopes())"));
  const press = async (key, code) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code }, sessionId);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code }, sessionId);
  };
  try {
    let point = await evaluate("import('/tests/library-scans.browser.mjs').then(test => test.openWelcomeSaveFixture())");
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, sessionId);
    point = await evaluate("import('/tests/library-scans.browser.mjs').then(test => test.verifyWelcomeSaveFailure())");
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, sessionId);
    results.push(await evaluate("import('/tests/library-scans.browser.mjs').then(test => test.verifyWelcomeSaveRetry())"));
  } finally {
    await evaluate('window.__welcomeSave?.cleanup()');
  }
  for (const mode of ['disjoint', 'nested', 'hidden', 'alias']) {
    try {
      let point = await evaluate(`import('/tests/library-scans.browser.mjs').then(test => test.openExtraRemovalFixture('${mode}'))`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, sessionId);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, sessionId);
      if (mode === 'disjoint') {
        point = await evaluate("import('/tests/library-scans.browser.mjs').then(test => test.verifyExtraRemovalFailure())");
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, sessionId);
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, sessionId);
      }
      results.push(await evaluate("import('/tests/library-scans.browser.mjs').then(test => test.verifyExtraRemoval())"));
    } finally { await evaluate('window.__extraRemoval?.cleanup()'); }
  }
  try {
    const point = await evaluate("import('/tests/library-scans.browser.mjs').then(test => test.openExtraRemovalFixture('nested', true))");
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, sessionId);
    results.push(await evaluate("import('/tests/library-scans.browser.mjs').then(test => test.verifyExtraRemovalUnmount())"));
  } finally { await evaluate('window.__extraRemoval?.cleanup()'); }
  try {
    await evaluate("import('/tests/settings.browser.mjs').then(test => test.openSettingsFixture())");
    await evaluate("import('/tests/settings.browser.mjs').then(test => test.focusThemeControl())");
    await press('End', 35);
    await press('Enter', 13);
    const point = await evaluate("import('/tests/settings.browser.mjs').then(test => test.allowRetryAndGetPoint())");
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, sessionId);
    results.push(await evaluate("import('/tests/settings.browser.mjs').then(test => test.verifySettingsRetry())"));
    await press('Escape', 27);
    results.push(await evaluate("import('/tests/settings.browser.mjs').then(test => test.verifySettingsClosed())"));
  } finally {
    await evaluate("import('/tests/settings.browser.mjs').then(test => test.cleanupSettingsFixture())");
  }
  try {
    await evaluate("import('/tests/settings.browser.mjs').then(test => test.openSettingsFixture())");
    const point = await evaluate("import('/tests/settings.browser.mjs').then(test => test.editorTabPoint())");
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, sessionId);
    await evaluate("import('/tests/settings.browser.mjs').then(test => test.focusFontSize())");
    await send('Input.insertText', { text: '2' }, sessionId);
    await send('Input.insertText', { text: '4' }, sessionId);
    results.push(await evaluate("import('/tests/settings.browser.mjs').then(test => test.verifyFontDraft())"));
    await press('Enter', 13);
    results.push(await evaluate("import('/tests/settings.browser.mjs').then(test => test.verifyFontCommit())"));
  } finally {
    await evaluate("import('/tests/settings.browser.mjs').then(test => test.cleanupSettingsFixture())");
  }
  try {
    await evaluate("import('/tests/settings.browser.mjs').then(test => test.openSettingsFixture())");
    const point = await evaluate("import('/tests/settings.browser.mjs').then(test => test.editorTabPoint())");
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, sessionId);
    await evaluate("import('/tests/settings.browser.mjs').then(test => test.focusFontFamily())");
    await send('Input.imeSetComposition', { text: '测试', selectionStart: 2, selectionEnd: 2 }, sessionId);
    await press('Enter', 229);
    results.push(await evaluate("import('/tests/settings.browser.mjs').then(test => test.verifyCompositionNotSubmitted())"));
    await send('Input.imeSetComposition', { text: '字体', selectionStart: 2, selectionEnd: 2 }, sessionId);
    await press('Escape', 229);
    results.push(await evaluate("import('/tests/settings.browser.mjs').then(test => test.verifyCompositionDidNotClose())"));
    await send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }, sessionId);
  } finally {
    await evaluate("import('/tests/settings.browser.mjs').then(test => test.cleanupSettingsFixture())");
  }
  try {
    let point = await evaluate("import('/tests/recovery.browser.mjs').then(test => test.openRecoveryFixture())");
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, sessionId);
    point = await evaluate("import('/tests/recovery.browser.mjs').then(test => test.verifyRecoveryFailure())");
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, sessionId);
    results.push(await evaluate("import('/tests/recovery.browser.mjs').then(test => test.verifyRecoverySuccess())"));
  } finally {
    await evaluate("import('/tests/recovery.browser.mjs').then(test => test.cleanupRecoveryFixture())");
  }
  try {
    await evaluate("import('/tests/search.browser.mjs').then(test => test.openSearchFixture())");
    await send('Input.insertText', { text: 'needle' }, sessionId);
    await evaluate("import('/tests/search.browser.mjs').then(test => test.checkBodySearch())");
    await evaluate("window.__searchFixture.mount.querySelector('input').select()");
    await press('Backspace', 8);
    await evaluate("import('/tests/search.browser.mjs').then(test => test.checkClearedSearch())");
    await send('Input.insertText', { text: 'manual' }, sessionId);
    results.push(await evaluate("import('/tests/search.browser.mjs').then(test => test.checkSearchRetry())"));
  } finally {
    await evaluate('window.__searchFixture?.cleanup()');
  }
  try {
    await evaluate("import('/tests/search.browser.mjs').then(test => test.openSearchFixture())");
    await send('Input.insertText', { text: 'needle' }, sessionId);
    await evaluate("import('/tests/search.browser.mjs').then(test => test.waitForPendingSearch())");
    await press('Backspace', 8);
    results.push(await evaluate("import('/tests/search.browser.mjs').then(test => test.checkCancelledSearch())"));
  } finally {
    await evaluate('window.__searchFixture?.cleanup()');
  }
  try {
    await evaluate("import('/tests/search.browser.mjs').then(test => test.openSearchFixture())");
    await send('Input.insertText', { text: 'needle' }, sessionId);
    await evaluate("import('/tests/search.browser.mjs').then(test => test.waitForPendingSearch())");
    results.push(await evaluate("import('/tests/search.browser.mjs').then(test => test.checkRootChangeSearch())"));
  } finally {
    await evaluate('window.__searchFixture?.cleanup()');
  }
  try {
    await evaluate("import('/tests/search.browser.mjs').then(test => test.openSearchFixture(50000))");
    await evaluate("import('/tests/search.browser.mjs').then(test => test.prepareLargeSearch())");
    await send('Input.insertText', { text: 'needle' }, sessionId);
    results.push(await evaluate("import('/tests/search.browser.mjs').then(test => test.checkLargeSearch())"));
  } finally {
    await evaluate('window.__searchFixture?.cleanup()');
  }
  results.push(await evaluate("import('/tests/editor-state.browser.mjs').then(test => test.testEditorState())"));
  try {
    await evaluate("import('/tests/encryption.browser.mjs').then(test => test.openEncryptionFixture())");
    await send('Input.insertText', { text: 'fixture-password' }, sessionId);
    await evaluate("window.__encryptionFixture.mount.querySelectorAll('input')[1].focus()");
    await send('Input.imeSetComposition', { text: 'fixture-password', selectionStart: 16, selectionEnd: 16 }, sessionId);
    await press('Enter', 229);
    await evaluate("import('/tests/encryption.browser.mjs').then(test => test.verifyCompositionDidNotEncrypt())");
    await send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }, sessionId);
    await send('Input.insertText', { text: 'fixture-password' }, sessionId);
    await press('Enter', 13);
    await evaluate("import('/tests/encryption.browser.mjs').then(test => test.verifyEncryptionWaiting())");
    await press('Escape', 27);
    await evaluate("import('/tests/encryption.browser.mjs').then(test => test.verifyEncrypted())");
    await send('Input.insertText', { text: 'fixture-password' }, sessionId);
    await press('Enter', 13);
    await evaluate("import('/tests/encryption.browser.mjs').then(test => test.verifyUnlocked())");
    await send('Input.insertText', { text: 'incorrect' }, sessionId);
    await press('Enter', 13);
    await evaluate("import('/tests/encryption.browser.mjs').then(test => test.verifyWrongPassword())");
    await send('Input.insertText', { text: 'fixture-password' }, sessionId);
    await press('Enter', 13);
    results.push(await evaluate("import('/tests/encryption.browser.mjs').then(test => test.verifyDecrypted())"));
  } finally {
    await evaluate('window.__encryptionFixture?.cleanup()');
  }
  try {
    await evaluate("import('/tests/save-recovery.browser.mjs').then(test => test.openSaveRecoveryFixture())");
    const clickRecovery = async label => {
      const point = await evaluate(`import('/tests/save-recovery.browser.mjs').then(test => test.saveRecoveryPoint(${JSON.stringify(label)}))`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, sessionId);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, sessionId);
    };
    await clickRecovery('Retry save');
    await evaluate("import('/tests/save-recovery.browser.mjs').then(test => test.verifyRetryAndCreateConflict())");
    await clickRecovery('Save a copy…');
    await evaluate("import('/tests/save-recovery.browser.mjs').then(test => test.verifyCancelledSaveAs())");
    await clickRecovery('Save a copy…');
    await evaluate("import('/tests/save-recovery.browser.mjs').then(test => test.verifySavedCopy())");
    await clickRecovery('Discard draft');
    await evaluate("import('/tests/save-recovery.browser.mjs').then(test => test.verifyCancelledDiscard())");
    await clickRecovery('Discard draft');
    results.push(await evaluate("import('/tests/save-recovery.browser.mjs').then(test => test.verifyDiscard())"));
  } finally { await evaluate('window.__saveRecoveryFixture?.cleanup()'); }
  results.push(await evaluate("import('/tests/watcher.browser.mjs').then(test => test.testWatcherRefresh())"));
  results.push(await runPreviewBrowser(send, sessionId));
  results.push(await runProductionBrowser(send, await evaluate("import('/src/stores/settings-store').then(module=>module.useSettingsStore.getState().config)")));
  if (results.some((result) => result?.passed !== true)) throw new Error(`Unexpected results: ${JSON.stringify(results)}`);
  console.log(JSON.stringify({ passed: true, cases: results }, null, 2));
  await send('Browser.close');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  socket?.close();
  if (chrome.exitCode === null && chrome.signalCode === null) {
    const exited = once(chrome, 'exit');
    chrome.kill();
    await exited;
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
