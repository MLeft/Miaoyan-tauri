import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const cmState = require('@codemirror/state');
const cmView = require('@codemirror/view');
import { createTypeScriptLoader } from './helpers/load-typescript.mjs';

const source = path => fileURLToPath(new URL(`../src/${path}`, import.meta.url));
const A = 'C:/isolated/A.md', B = 'C:/other/B.md', E = 'C:/isolated/secret.md.encrypted';
const key = path => path.replace(/\\/g, '/').toLowerCase();
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const note = path => ({ id: path, path, title: path.split('/').pop(), folder: path.slice(0, path.lastIndexOf('/')),
  created_at: '', modified_at: '', pinned: false, size: 1, is_encrypted: path.endsWith('.encrypted') });
function harness() {
  const disk = new Map([[key(A), 'alpha'], [key(B), 'bravo']]);
  const gates = new Map(), failures = new Set(), calls = [], events = [], timers = new Map(), searches = new Map(), progressListeners = new Set();
  let timerId = 0;
  const window = new EventTarget();
  for (const name of ['note-path-changed', 'note-created', 'show-toast']) window.addEventListener(name, e => events.push({ name, detail: e.detail }));
  const hold = command => { const gate = deferred(); gates.set(command, [...(gates.get(command) || []), gate]); return gate; };
  const invoke = async (command, args = {}) => {
    calls.push({ command, ...args });
    const readBody = command === 'read_note' ? disk.get(key(args.path)) : undefined;
    const searchRows = command === 'search_notes' ? [...disk].filter(([path, body]) => path.includes(args.query.toLowerCase()) || body.toLowerCase().includes(args.query.toLowerCase())).map(([path]) => note(path)) : undefined;
    const gate = gates.get(command)?.shift();
    if (command === 'search_notes' && gate) searches.set(args.generation, gate);
    if (gate) await gate.promise;
    if (command === 'search_notes') searches.delete(args.generation);
    if (failures.has(command)) throw new Error('isolated failure');
    switch (command) {
      case 'start_scan_session': return 'fixture-scan-session';
      case 'invalidate_scan': case 'release_scan_lane': return;
      case 'start_search_session': return 'fixture-search-session';
      case 'invalidate_search':
        for (const [generation, search] of searches) if (generation < args.generation) search.resolve();
        return;
      case 'create_note': {
        const path = args.folderPath + '/' + args.title + (/\.(md|markdown|txt|html|htm)$/.test(args.title) ? '' : '.md');
        disk.set(key(path), ''); return { ...note(path), disk_version: '' };
      }
      case 'delete_note': case 'delete_folder':
        for (const path of disk.keys()) if (path === key(args.path) || (command === 'delete_folder' && path.startsWith(key(args.path) + '/'))) disk.delete(path);
        return;
      case 'create_folder': return args.parentPath + '/' + args.name;
      case 'decrypt_note': return { id: args.path, content: 'decrypted body', disk_version: disk.get(key(args.path)) };
      case 'encrypt_note': case 'remove_encryption': {
        const target = command === 'encrypt_note' ? (args.path.endsWith('.encrypted') ? args.path : args.path + '.encrypted') : args.path.slice(0, -'.encrypted'.length);
        if (key(target) !== key(args.path)) { disk.set(key(target), disk.get(key(args.path))); disk.delete(key(args.path)); }
        return { id: target, content: disk.get(key(target)), disk_version: disk.get(key(target)) };
      }
      case 'search_notes': return searchRows;
      case 'save_image': return 'images/pasted.png';
      case 'upload_image': return 'https://example.invalid/pasted.png';
      case 'read_note':
        if (readBody === undefined) throw new Error('isolated missing file');
        return { id: args.path, content: readBody, disk_version: readBody };
      case 'write_note': case 'save_encrypted_note':
        if (args.expectedVersion !== disk.get(key(args.path))) throw { code: 'DiskConflict', message: 'File changed on disk', paths: [args.path] };
        disk.set(key(args.path), args.content); return args.content;
      case 'get_notes_in_folder': return [...disk.keys()].filter(p => p.startsWith(key(args.folderPath) + '/')).map(note);
      case 'get_sort_order': return [];
      case 'get_all_notes': return [...disk.keys()].map(note);
      case 'save_config': case 'write_log': case 'scan_folder': return;
      case 'rename_note': case 'move_note': case 'rename_folder': {
        const from = args.oldPath ?? args.sourcePath;
        const to = command === 'rename_note' ? from.slice(0, from.lastIndexOf('/') + 1) + args.newTitle + '.md'
          : command === 'move_note' ? args.targetFolder + '/' + from.split('/').pop()
          : from.slice(0, from.lastIndexOf('/') + 1) + args.newName;
        for (const [path, body] of [...disk]) {
          if (path === key(from) || (command === 'rename_folder' && path.startsWith(key(from) + '/'))) {
            disk.delete(path); disk.set(key(to) + path.slice(key(from).length), body);
          }
        }
        return to;
      }
      default: throw new Error(`Unexpected native command: ${command}`);
    }
  };
  const load = createTypeScriptLoader({ invoke, window,
    setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id) });
  const { useNotesStore: store, createDocumentCloseHandler, documentRenameTarget } = load(source('stores/notes-store.ts'));
  const settings = load(source('stores/settings-store.ts')).useSettingsStore;
  const editor = load(source('stores/editor-store.ts')).useEditorStore;
  const bridge = load(source('services/tauri-bridge.ts'));
  settings.setState({ config: { ...settings.getState().config, storage_path: 'C:/library', auto_save_interval: 0 } });
  const bindings = { useNotesStore: store, useSettingsStore: settings, documentRenameTarget, ...bridge, URL };
  const app = () => load.functions(source('App.tsx'), ['normPath', 'showToastEvent', 'isInsideLibrary', 'importExternalFolder', 'openExternalFile'], {
    ...bindings, i18n: { t: (text, args) => args?.count === undefined ? text : `${text} ${args.count}` }, listen: async (event, callback) => {
      calls.push({ command: 'listen' });
      const gate = gates.get('listen')?.shift(); if (gate) await gate.promise;
      if (event === 'miaoyan://scan-progress') progressListeners.add(callback);
      return () => { progressListeners.delete(callback); calls.push({ command: 'unlisten' }); };
    },
  });
  return { store, settings, editor, disk, calls, events, hold, failures, load, bindings, app,
    emitProgress: (scanId, count) => { for (const callback of progressListeners) callback({ payload: { scan_id: scanId, data: count } }); },
    close: createDocumentCloseHandler, s: () => store.getState(),
    open: path => store.getState().selectNote(note(path)),
    edit: body => store.getState().updateContent(body, ''),
    async timers() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } await tick(); },
  };
}

// Executes the production EditorState initializer and listeners. No DOM/keyboard
// simulation: these assertions cover real CodeMirror State transactions only.
function editorStateFixture(h, path) {
  const filename = source('components/editor/Editor.tsx');
  const ast = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ast.statements.flatMap(n => ts.isFunctionDeclaration(n) && n.name.text !== 'Editor' ? [n.name.text]
    : ts.isVariableStatement(n) ? n.declarationList.declarations.map(d => d.name.getText(ast)) : []);
  const visit = n => {
    if (ts.isPropertyAssignment(n) && n.name.getText(ast) === 'dispatchTransactions') names.push('dispatchTransactions');
    ts.forEachChild(n, visit);
  };
  visit(ast);
  const empty = () => [];
  const bindings = { ...h.bindings, ...cmState, ...cmView, useEditorStore: h.editor,
    activeNote: note(path), activeContent: h.s().activeContent, config: h.settings.getState().config,
    updateContent: h.s().updateContent, isHtmlFile: false, isDark: false,
    lineNumbers: empty, highlightActiveLine: empty, highlightActiveLineGutter: empty,
    history: require('@codemirror/commands').history, indentOnInput: empty, bracketMatching: empty, tabSnippets: empty,
    markdown: empty, markdownLanguage: {}, languages: [], syntaxHighlighting: empty,
    defaultHighlightStyle: {}, wikilinks: empty, imagePasteExtension: empty, imagePreviewExtension: empty,
    smartListKeymap: [], textFormattingKeymap: [], defaultKeymap: [], historyKeymap: [], searchKeymap: [], indentWithTab: {},
    lastEditorContentRef: { current: h.s().activeContent }, lastEditorRevisionRef: { current: h.s().getDocumentRevision(path) },
    suppressEditorSync: { current: true },
    scrollRafRef: { current: null }, setEditorScrollLine() {}, perfReport() {},
  };
  const setup = h.load.functions(filename, [...names, 'state'], bindings);
  const view = { state: setup.state, dispatch(spec) {
    const transaction = spec instanceof cmState.Transaction ? spec : view.state.update(spec);
    if (setup.dispatchTransactions) setup.dispatchTransactions([transaction], view);
    else view.update([transaction]);
    return transaction;
  }, update(transactions) {
    const startState = view.state;
    for (const transaction of transactions) view.state = transaction.state;
    for (const listener of view.state.facet(cmView.EditorView.updateListener)) {
      listener({ state: view.state, startState, view, transactions, docChanged: transactions.some(t => t.docChanged),
        changes: transactions.reduce((changes, t) => changes.compose(t.changes), startState.changes()) });
    }
  } };
  return { view, setup };
}

function deleteEntry(h, directory = false) {
  const allNotesRef = { current: [...h.disk.keys()].map(note) };
  const tree = h.load.functions(source('components/sidebar/UnifiedTree.tsx'), [
    'stripExtendedPath', 'normPath', 'isUnderPath', 'projectTreeHas', 'removeNoteLocal', 'dirRemoveLocal', 'handleDeleteNote', 'handleDeleteFolder',
  ], { ...h.bindings, allNotesRef, setAllNotes: fn => { allNotesRef.current = fn(allNotesRef.current); }, setContextMenu() {},
    contextMenu: directory ? { type: 'folder', project: { path: 'C:/isolated' } } : { type: 'note', note: note(A) } });
  return directory ? tree.handleDeleteFolder : tree.handleDeleteNote;
}

function createEntry(h, kind) {
  if (kind === 'duplicate') return () => h.s().duplicateNote('C:/isolated');
  if (kind === 'folder') return h.load.functions(source('components/sidebar/UnifiedTree.tsx'), ['stripKnownExt', 'handleNewFileInFolder'], {
    ...h.bindings, contextMenu: { type: 'folder', project: { path: 'C:/isolated' } }, selectNote: h.s().selectNote,
    setRenamingNoteId() {}, setRenameNoteValue() {}, setContextMenu() {},
  }).handleNewFileInFolder;
  const app = h.load.functions(source('App.tsx'), ['handleNewNote', 'handleDeepLink', 'handler'], { ...h.bindings, isPdfPath: () => false });
  if (kind === 'shortcut') return () => app.handler({ key: 'n', ctrlKey: true, shiftKey: false, preventDefault() {} });
  return kind === 'deep-link' ? () => app.handleDeepLink('miaoyan://new?title=created&content=deep-body') : app.handleNewNote;
}

test('encryption waits for saving, seals edits, and keeps identity and password at the new path', async () => {
  const h = harness(); await h.open(A);
  const identity = h.s().getDocumentSession(A).identity;
  h.edit('accepted body');
  const save = h.hold('write_note'), encrypt = h.hold('encrypt_note');
  const changing = h.s().changeDocumentEncryption(A, 'fixture-password', true); await tick();
  assert.equal(h.calls.some(call => call.command === 'encrypt_note'), false);
  save.resolve(); await tick();
  assert.equal(h.s().isDocumentWritable(A), false);
  h.edit('rejected body');
  await h.open(B);
  encrypt.resolve(); assert.equal(await changing, true);
  assert.equal(h.s().activeTabPath, B);
  const encryptedPath = A + '.encrypted';
  assert.equal(h.s().getDocumentSession(encryptedPath).identity, identity);
  assert.equal(h.s().getDocumentSession(encryptedPath).content, 'accepted body');
  assert.equal(h.s().getDocumentSession(A), null);
  await h.s().switchTab(encryptedPath); h.edit('encrypted edit');
  assert.equal(await h.s().saveCurrentNote(), true);
  const lastSave = h.calls.filter(call => ['write_note', 'save_encrypted_note'].includes(call.command)).at(-1);
  assert.equal(lastSave.command, 'save_encrypted_note');
  assert.equal(lastSave.password, 'fixture-password');
  assert.equal(lastSave.path, encryptedPath);
  assert.equal(await h.s().changeDocumentEncryption(encryptedPath, 'fixture-password', false), true);
  h.edit('plain again'); await h.s().saveCurrentNote();
  assert.equal(h.calls.at(-1).command, 'write_note');
  assert.equal(h.s().getDocumentSession(A).identity, identity);
});

test('unlock metadata migration preserves its open intent and participates in window draining', async () => {
  for (const closeWindow of [false, true]) {
    const h = harness(); await h.open(E);
    const requestId = h.s().encryptionDialog.requestId;
    const native = h.hold('decrypt_note');
    let content;
    const work = h.s().withDocumentPathChange(E, false, async () => {
      await h.bindings.encryptNote(E, 'fixture-password');
      content = await h.bindings.decryptNote(E, 'fixture-password');
    }, [], { preserveOpenRequest: requestId });
    await tick();
    let destroyed = false;
    const close = closeWindow ? h.close(async () => { destroyed = true; })({ preventDefault() {} }) : Promise.resolve();
    await tick(); assert.equal(destroyed, false);
    native.resolve(); assert.equal(await work, true);
    assert.equal(h.s().onNoteUnlocked(E, content, 'fixture-password', requestId), !closeWindow);
    await close;
    assert.equal(destroyed, closeWindow);
    if (!closeWindow) assert.equal(h.s().activeContent, 'decrypted body');
  }
});

test('encryption does not start when the accepted plaintext body could not be saved', async () => {
  const h = harness(); await h.open(A); h.edit('retained draft'); h.failures.add('write_note');
  assert.equal(await h.s().changeDocumentEncryption(A, 'fixture-password', true), false);
  assert.equal(h.calls.some(call => call.command === 'encrypt_note'), false);
  assert.equal(h.s().activeContent, 'retained draft');
  assert.equal(h.s().isDocumentWritable(A), true);
});

test('search debounces typing, includes extra roots, and keeps the library list separate', async () => {
  const h = harness();
  h.settings.setState({ config: { ...h.settings.getState().config, extra_folders: ['C:/other'] } });
  h.store.setState({ notes: [note(A), note(B)] });
  const first = h.s().setSearchQuery('br', 'C:/library');
  const second = h.s().setSearchQuery('bravo', 'C:/library');
  assert.equal(h.calls.filter(call => call.command === 'search_notes').length, 0);
  await h.timers(); await Promise.all([first, second]);
  assert.deepEqual(Array.from(h.s().searchResults, row => row.path), [key(B)]);
  assert.equal(h.s().notes.length, 2);
  const searches = h.calls.filter(call => call.command === 'search_notes');
  assert.equal(searches.length, 1);
  assert.deepEqual(Array.from(searches[0].extraFolders), ['C:/other']);
});

test('while cancellation waits, search keeps one native scan and only the latest pending query', async () => {
  const h = harness(), slow = h.hold('search_notes');
  const cancelSecond = h.hold('invalidate_search'), cancelThird = h.hold('invalidate_search');
  const first = h.s().setSearchQuery('alpha', 'C:/library'); await h.timers();
  const second = h.s().setSearchQuery('not submitted', 'C:/library'); await h.timers();
  const third = h.s().setSearchQuery('bravo', 'C:/library'); await h.timers();
  assert.equal(h.calls.filter(call => call.command === 'search_notes').length, 1);
  slow.resolve(); await Promise.all([first, second, third]);
  cancelSecond.resolve(); cancelThird.resolve(); await tick();
  assert.deepEqual(h.calls.filter(call => call.command === 'search_notes').map(call => call.query), ['alpha', 'bravo']);
  assert.deepEqual(Array.from(h.s().searchResults, row => row.path), [key(B)]);
});

test('clearing a search rejects late results without rescanning the library', async () => {
  const h = harness(), slow = h.hold('search_notes');
  h.store.setState({ notes: [note(B)] });
  const searching = h.s().setSearchQuery('alpha', 'C:/library'); await h.timers();
  await h.s().setSearchQuery('', 'C:/library');
  slow.resolve(); await searching;
  assert.equal(h.s().searchQuery, '');
  assert.equal(h.s().searchResults.length, 0);
  assert.equal(h.s().notes[0].path, B);
  assert.equal(h.calls.some(call => call.command === 'get_all_notes'), false);
});

test('clearing search cancels the in-flight native query without waiting for its old result', async () => {
  const h = harness(); h.hold('search_notes');
  const old = h.s().setSearchQuery('alpha', 'C:/library'); await h.timers();
  const running = h.calls.find(call => call.command === 'search_notes');
  assert.ok(running);
  await h.s().setSearchQuery('', 'C:/library'); await tick();
  const cancellation = h.calls.find(call => call.command === 'invalidate_search');
  assert.ok(cancellation, 'Clear must request native cancellation');
  assert.equal(cancellation.sessionId, running.sessionId);
  assert.ok(cancellation.generation > running.generation);
  await old;
  assert.equal(h.s().searchQuery, '');
  assert.equal(h.s().searchStatus, 'idle');
  assert.equal(h.s().searchResults.length, 0);
});

test('latest query starts after cooperative cancellation rather than waiting for a stale full scan', async () => {
  const h = harness(); h.hold('search_notes');
  const old = h.s().setSearchQuery('alpha', 'C:/library'); await h.timers();
  const latest = h.s().setSearchQuery('bravo', 'C:/other'); await h.timers();
  assert.equal(h.calls.filter(call => call.command === 'search_notes').length, 2, 'Latest search must not wait for manual release of the old scan');
  await Promise.all([old, latest]);
  assert.equal(h.s().searchResults[0]?.path, key(B));
  assert.equal(h.s().searchStatus, 'idle');
  assert.equal(h.calls.filter(call => call.command === 'start_search_session').length, 1);
});

test('pending search session setup cannot start an obsolete query after input was cleared', async () => {
  const h = harness(), setup = h.hold('start_search_session');
  const old = h.s().setSearchQuery('alpha', 'C:/library'); await h.timers();
  await h.s().setSearchQuery('', 'C:/library'); setup.resolve(); await old; await tick();
  assert.equal(h.calls.filter(call => call.command === 'search_notes').length, 0);
  assert.equal(h.s().searchStatus, 'idle');
  assert.equal(h.s().searchError, null);
});

test('search session initialization can fail visibly and retry without reusing a rejected setup promise', async () => {
  const h = harness(); h.failures.add('start_search_session');
  const failed = h.s().setSearchQuery('alpha', 'C:/library'); await h.timers(); await failed;
  assert.equal(h.s().searchStatus, 'error');
  assert.match(h.s().searchError, /isolated failure/);
  h.failures.delete('start_search_session');
  const retry = h.s().setSearchQuery('alpha', 'C:/library'); await h.timers(); await retry;
  assert.equal(h.s().searchStatus, 'idle');
  assert.equal(h.calls.filter(call => call.command === 'start_search_session').length, 2);
});

test('late failure of an obsolete cancellation cannot replace a completed current query with an error', async () => {
  const h = harness(), oldRead = h.hold('search_notes'), cancellation = h.hold('invalidate_search');
  const old = h.s().setSearchQuery('alpha', 'C:/library'); await h.timers();
  const latest = h.s().setSearchQuery('bravo', 'C:/other'); await h.timers();
  oldRead.resolve(); await Promise.all([old, latest]);
  h.failures.add('invalidate_search'); cancellation.resolve(); await tick();
  assert.equal(h.s().searchStatus, 'idle');
  assert.equal(h.s().searchError, null);
  assert.equal(h.s().searchResults[0]?.path, key(B));
});

test('library cache refresh during search preserves the list and invalidates pending results', async () => {
  const h = harness(), slow = h.hold('search_notes');
  const searching = h.s().setSearchQuery('alpha', 'C:/library'); await h.timers();
  h.disk.delete(key(A));
  h.s().setNotesFromCache([note(B)]);
  assert.equal(h.s().notes[0]?.path, B);
  slow.resolve(); await searching;
  assert.equal(h.s().searchResults.length, 0);
  await h.timers();
  assert.equal(h.s().searchStatus, 'idle');
  assert.equal(h.s().searchResults.length, 0);
});

test('search failures are explicit and a subsequent request can retry', async () => {
  const h = harness(); h.failures.add('search_notes');
  const failed = h.s().setSearchQuery('alpha', 'C:/library'); await h.timers(); await failed;
  assert.equal(h.s().searchStatus, 'error');
  assert.match(h.s().searchError, /isolated failure/);
  h.failures.delete('search_notes');
  const retry = h.s().setSearchQuery('alpha', 'C:/library'); await h.timers(); await retry;
  assert.equal(h.s().searchStatus, 'idle');
  assert.equal(h.s().searchResults.length, 1);
});

test('CodeMirror rejects sealed-path transactions before doc mutation and recovers after unlock', async () => {
  const h = harness(); await h.open(A);
  const { view } = editorStateFixture(h, A), native = deferred();
  const moving = h.s().withDocumentPathChange(A, false, () => native.promise); await tick();
  view.dispatch({ changes: { from: 0, insert: 'lost input' } });
  assert.equal(view.state.doc.toString(), 'alpha');
  assert.equal(h.s().activeContent, 'alpha');
  assert.equal(h.s().activeDocumentReadOnly, true);
  native.resolve(); await moving;
  view.dispatch({ changes: { from: 0, insert: 'kept ' } });
  assert.equal(view.state.doc.toString(), 'kept alpha');
  assert.equal(h.s().activeContent, 'kept alpha');
  assert.equal(h.s().activeDocumentReadOnly, false);
});

test('CodeMirror built-in undo and prebuilt transactions cannot bypass the synchronous edit seal', async () => {
  const h = harness(); await h.open(A); const { view } = editorStateFixture(h, A);
  view.dispatch({ changes: { from: 0, insert: 'saved ' } });
  const prebuilt = view.state.update({ changes: { from: 0, insert: 'stale ' } });
  const gate = deferred(), moving = h.s().withDocumentPathChange(A, false, () => gate.promise); await tick();
  require('@codemirror/commands').undo(view);
  assert.equal(view.state.doc.toString(), 'saved alpha');
  view.dispatch(prebuilt);
  assert.equal(view.state.doc.toString(), 'saved alpha');
  assert.equal(h.s().activeContent, 'saved alpha');
  gate.resolve(); await moving;
  require('@codemirror/commands').undo(view);
  assert.equal(view.state.doc.toString(), 'alpha');
  assert.equal(h.s().activeContent, 'alpha');
});

test('external CodeMirror sync remains clean while sealed and never enters undo/save history', async () => {
  const h = harness(); await h.open(A); const { view, setup } = editorStateFixture(h, A);
  h.settings.setState({ config: { ...h.settings.getState().config, auto_save_interval: 25 } });
  h.disk.set(key(A), 'external'); await h.s().reloadOpenTabs([A]);
  const revision = h.s().getDocumentRevision(A), gate = deferred();
  const moving = h.s().withDocumentPathChange(A, false, () => gate.promise); await tick();
  view.dispatch({ changes: { from: 0, to: 5, insert: 'external' },
    annotations: [setup.externalDocumentSync.of(true), cmState.Transaction.addToHistory.of(false)] });
  assert.equal(view.state.doc.toString(), 'external');
  assert.equal(h.s().getDocumentRevision(A), revision); assert.equal(h.s().isDirty, false);
  gate.resolve(); await moving; await h.timers();
  assert.equal(require('@codemirror/commands').undo(view), false);
  assert.equal(h.calls.some(c => c.command === 'write_note'), false);
  view.dispatch({ changes: { from: 0, insert: 'local ' } });
  assert.equal(h.s().activeContent, 'local external');
});

function pasteHandler(h, view, getPath, isCurrent) {
  let paste;
  const { imagePasteExtension } = h.load.functions(source('components/editor/extensions/image-paste.ts'), ['imagePasteExtension'], {
    ...h.bindings, ...cmState, ...cmView,
    // Only the DOM event delivery is substituted. Install the real mapping
    // extension into the same production EditorState used by input/undo.
    EditorView: { ...cmView.EditorView, domEventHandlers: handlers => { paste = handlers.paste; return []; } },
  });
  view.dispatch({ effects: cmState.StateEffect.appendConfig.of(imagePasteExtension(getPath, isCurrent)) });
  return paste;
}
const imageEvent = (arrayBuffer = async () => new ArrayBuffer(2)) => ({ preventDefault() {},
  clipboardData: { items: [{ type: 'image/png', getAsFile: () => ({ arrayBuffer }) }] } });

for (const remote of [false, true]) {
  for (const [label, selection, edits, expected] of [
    ['typing before anchor', { anchor: 2 }, [{ from: 0, insert: 'X' }], 'Xal<image>pha'],
    ['typing after anchor', { anchor: 2 }, [{ from: 5, insert: 'Y' }], 'al<image>phaY'],
    ['typing at anchor', { anchor: 2 }, [{ from: 2, insert: 'X' }], 'alX<image>pha'],
    ['replacing original selection', { anchor: 1, head: 4 }, [], 'a<image>a'],
    ['moving original selection', { anchor: 4, head: 1 }, [{ from: 0, insert: 'X' }], 'Xa<image>a'],
    ['typing replaces selection', { anchor: 1, head: 4 }, [{ from: 1, to: 4, insert: 'typed' }], 'atyped<image>a'],
    ['typing inside selection', { anchor: 1, head: 4 }, [{ from: 2, insert: 'X' }], 'alXph<image>a'],
  ]) {
    test(`${remote ? 'remote' : 'local'} image paste maps ${label} without locking input`, async () => {
      const h = harness(); await h.open(A); const { view } = editorStateFixture(h, A);
      h.settings.setState({ config: { ...h.settings.getState().config, image_upload_service: remote ? 'picgo' : 'none' } });
      view.dispatch({ selection });
      const paste = pasteHandler(h, view, () => A, () => true);
      const gate = h.hold(remote ? 'upload_image' : 'save_image');
      paste(imageEvent(), view); await tick();
      for (const changes of edits) view.dispatch({ changes });
      assert.equal(h.s().isDocumentWritable(A), true);
      gate.resolve(); await tick();
      const markdown = remote ? '![](https://example.invalid/pasted.png)' : '![](images/pasted.png)';
      const body = expected.replace('<image>', markdown);
      assert.equal(view.state.doc.toString(), body);
      assert.equal(h.s().activeContent, body);
      await h.s().saveCurrentNote(); assert.equal(h.disk.get(key(A)), body);
      assert.equal(h.events.filter(e => e.name === 'show-toast').length, 0);
    });
  }
}

for (const late of ['switch', 'switch-back', 'destroy', 'path']) {
  test(`late image result is visibly cancelled with a recovery link after ${late}`, async () => {
    const h = harness(); await h.open(A); const { view } = editorStateFixture(h, A);
    let live = true;
    const paste = pasteHandler(h, view, () => A, () => live);
    const gate = h.hold('save_image');
    paste(imageEvent(), view); await tick();
    if (late === 'switch' || late === 'switch-back') await h.open(B);
    if (late === 'switch-back') await h.open(A);
    if (late === 'destroy') live = false;
    if (late === 'path') h.s().applyNotePathChange(A, 'C:/isolated/renamed.md', 'renamed');
    const before = view.state.doc.toString(), storeBefore = h.s().activeContent;
    gate.resolve(); await tick();
    assert.equal(view.state.doc.toString(), before);
    assert.equal(h.s().activeContent, storeBefore);
    const warnings = h.events.filter(e => e.name === 'show-toast' && e.detail.type === 'warning');
    assert.ok(warnings.some(e => /cancel|取消/i.test(e.detail.message)), 'Cancellation must be visible');
    assert.ok(warnings.some(e => e.detail.message.includes('images/pasted.png')), 'Saved image must be recoverable');
  });
}

test('closing and reopening waits for an accepted image and persists its Markdown', async () => {
  const h = harness(); await h.open(A); const { view } = editorStateFixture(h, A);
  const gate = h.hold('save_image');
  pasteHandler(h, view, () => A, () => true)(imageEvent(), view);
  await tick();
  let closed = false;
  const closing = h.s().closeTab(A).then(() => { closed = true; });
  await tick();
  assert.equal(closed, false);
  gate.resolve();
  await closing;
  assert.equal(h.disk.get(key(A)), '![](images/pasted.png)alpha');
  await h.open(A);
  assert.equal(h.s().activeContent, '![](images/pasted.png)alpha');
});

test('native path mutation starts only after an accepted image and its body save', async () => {
  const h = harness(); await h.open(A); const { view } = editorStateFixture(h, A);
  const image = h.hold('save_image'), native = deferred();
  pasteHandler(h, view, () => A, () => true)(imageEvent(), view);
  await tick();
  let started = false;
  const moving = h.s().withDocumentPathChange(A, false, async () => {
    started = true;
    assert.equal(h.disk.get(key(A)), '![](images/pasted.png)alpha');
    await native.promise;
  });
  await tick();
  assert.equal(started, false);
  image.resolve();
  await tick();
  assert.equal(started, true);
  native.resolve();
  assert.equal(await moving, true);
});

for (const remote of [false, true]) {
  test(`${remote ? 'remote' : 'local'} failed image retries at its mapped position without losing typed text`, async () => {
    const h = harness(); await h.open(A); const { view } = editorStateFixture(h, A);
    h.settings.setState({ config: { ...h.settings.getState().config, image_upload_service: remote ? 'picgo' : 'none' } });
    const command = remote ? 'upload_image' : 'save_image';
    h.failures.add(command);
    pasteHandler(h, view, () => A, () => true)(imageEvent(), view);
    await tick();
    assert.match(h.s().getDocumentWork(A, 'image:').error, /isolated failure/);
    assert.equal(h.s().isDirty, true);
    view.dispatch({ changes: { from: 0, insert: 'typed ' } });
    h.failures.delete(command);
    assert.equal(await h.s().saveCurrentNote(), true);
    const markdown = remote ? '![](https://example.invalid/pasted.png)' : '![](images/pasted.png)';
    assert.equal(h.disk.get(key(A)), `typed ${markdown}alpha`);
    assert.equal(h.s().getDocumentWork(A, 'image:'), null);
    assert.equal(h.s().isDirty, false);
  });
}

test('image paste maps edits made while clipboard bytes are still being read', async () => {
  const h = harness(); await h.open(A); const { view } = editorStateFixture(h, A);
  view.dispatch({ selection: { anchor: 2 } });
  const paste = pasteHandler(h, view, () => A, () => true), read = deferred();
  paste(imageEvent(() => read.promise), view);
  view.dispatch({ changes: { from: 0, insert: 'X' } });
  read.resolve(new ArrayBuffer(2)); await tick();
  assert.equal(h.s().activeContent, 'Xal![](images/pasted.png)pha');
});

test('image paste cancelled before clipboard read completes warns without uploading', async () => {
  const h = harness(); await h.open(A); const { view } = editorStateFixture(h, A);
  const paste = pasteHandler(h, view, () => A, () => true), read = deferred();
  paste(imageEvent(() => read.promise), view); await h.open(B);
  read.resolve(new ArrayBuffer(2)); await tick();
  assert.equal(h.calls.some(c => c.command === 'save_image' || c.command === 'upload_image'), false);
  assert.equal(h.s().activeContent, 'bravo');
  assert.ok(h.events.some(e => e.name === 'show-toast' && /paste again|重新粘贴/i.test(e.detail.message)));
});

for (const directory of [false, true]) {
  test(`${directory ? 'folder' : 'file'} delete retires dirty sessions so flush/close cannot resurrect files`, async () => {
    const h = harness(), child = 'C:/isolated/nested/C.md'; h.disk.set(key(child), 'child');
    await h.open(child); await h.open(A);
    h.settings.setState({ config: { ...h.settings.getState().config, auto_save_interval: 25 } });
    h.s().updateDocumentContent(child, 'child draft', h.s().getDocumentRevision(child)); h.edit('deleted draft');
    await deleteEntry(h, directory)();
    await h.s().flushPendingSaves(); await h.s().closeAllTabs(); await h.timers();
    assert.equal(h.disk.has(key(A)), false);
    assert.equal(h.s().getDocumentSession(A), null);
    assert.equal(h.disk.has(key(child)), !directory);
  });
  test(`${directory ? 'folder' : 'file'} delete cancels on save failure and preserves the draft`, async () => {
    const h = harness(); await h.open(A); h.edit('retained'); h.failures.add('write_note');
    await deleteEntry(h, directory)();
    assert.equal(h.calls.some(c => c.command.startsWith('delete_')), false);
    assert.equal(h.s().getDocumentSession(A).content, 'retained');
    assert.equal(h.disk.get(key(A)), 'alpha');
  });
}

for (const kind of ['toolbar', 'shortcut', 'folder', 'deep-link', 'duplicate']) {
  for (const aba of [false, true]) {
    test(`${kind} pending create cannot steal a newer ${aba ? 'ABA' : 'B'} open but still registers its row`, async () => {
      const h = harness(); await h.open(A); const gate = h.hold('create_note');
      const creating = createEntry(h, kind)(); await tick();
      await h.open(B); if (aba) await h.open(A);
      gate.resolve(); await creating; await tick();
      assert.equal(h.s().activeNote.path, aba ? A : B);
      assert.equal(h.events.filter(e => e.name === 'note-created').length, 1);
      if (kind === 'deep-link') assert.equal(h.disk.get(key('C:/library/created.md')), 'deep-body');
    });
  }
}

for (const directory of [false, true]) {
  test(`${directory ? 'folder' : 'file'} delete drains in-flight writes, seals edits and blocks new opens`, async () => {
    const h = harness(); await h.open(A); h.edit('final');
    const write = h.hold('write_note'), native = h.hold(directory ? 'delete_folder' : 'delete_note');
    const pendingPath = directory ? 'C:/isolated/pending.md' : A;
    const deleting = deleteEntry(h, directory)(); await tick();
    assert.equal(h.calls.some(c => c.command.startsWith('delete_')), false);
    write.resolve(); await tick();
    assert.equal(h.s().updateDocumentContent(A, 'too late', h.s().getDocumentRevision(A)), false);
    const opening = h.s().openTemporaryFile(pendingPath); assert.equal(await opening, null);
    native.resolve(); await deleting; await h.s().flushPendingSaves();
    assert.equal(h.disk.has(key(A)), false); assert.equal(h.s().getDocumentSession(A), null);
  });
}

test('pending read of a deleted folder descendant cannot register a retired session', async () => {
  const h = harness(), child = 'C:/isolated/nested/C.md'; h.disk.set(key(child), 'child'); await h.open(A);
  const read = h.hold('read_note'), opening = h.open(child);
  await deleteEntry(h, true)(); read.resolve(); await opening;
  assert.equal(h.s().getDocumentSession(child), null); assert.equal(h.s().openTabs.length, 0);
  await h.s().flushPendingSaves(); assert.equal(h.disk.has(key(child)), false);
});

for (const first of ['move', 'destination-rename']) {
  test(`${first} excludes the intersecting destination mutation without locking unrelated reads/edits`, async () => {
    const h = harness(); h.disk.set(key('C:/target/existing.md'), 'target'); await h.open(A);
    const gate = h.hold(first === 'move' ? 'move_note' : 'rename_folder');
    const move = pathOperation(h, 'move'), rename = pathOperation(h, 'folder', 'C:/target');
    const pending = first === 'move' ? move() : rename(); await tick();
    await (first === 'move' ? rename() : move());
    assert.equal(h.calls.filter(c => ['move_note', 'rename_folder'].includes(c.command)).length, 1);
    await h.open(B); h.edit('unrelated'); assert.equal(h.s().activeContent, 'unrelated');
    gate.resolve(); await pending; await h.s().flushPendingSaves();
    if (first === 'destination-rename') assert.equal(h.disk.has(key('C:/target/A.md')), false);
  });
}

for (const kind of ['toolbar', 'shortcut', 'folder', 'deep-link', 'duplicate']) {
  test(`${kind} pending create reserves its destination against parent rename`, async () => {
    const h = harness(); await h.open(A); h.store.setState({ activeFolder: 'C:/isolated' });
    const gate = h.hold('create_note'), creating = createEntry(h, kind)(); await tick();
    await pathOperation(h, 'folder')();
    assert.equal(h.calls.some(c => c.command === 'rename_folder'), false);
    gate.resolve(); await creating; await tick();
    assert.equal(h.events.filter(e => e.name === 'note-created').length, 1);
  });
  test(`${kind} cannot create in the old folder while its rename is pending`, async () => {
    const h = harness(); await h.open(A); h.store.setState({ activeFolder: 'C:/isolated' });
    const gate = h.hold('rename_folder'), moving = pathOperation(h, 'folder')(); await tick();
    await createEntry(h, kind)(); await tick();
    assert.equal(h.calls.some(c => c.command === 'create_note'), false);
    gate.resolve(); await moving;
  });
}

for (const entry of ['tree', 'shortcut-handler']) {
  test(`${entry} folder creation is excluded while its ancestor rename is pending`, async () => {
    const h = harness(); await h.open(A); h.store.setState({ activeFolder: 'C:/isolated' });
    const gate = h.hold('rename_folder'), moving = pathOperation(h, 'folder')(); await tick();
    const bindings = { ...h.bindings, prompt: () => 'child', t: text => text, isPdfPath: () => false,
      contextMenu: { type: 'folder', project: { path: 'C:/isolated' } }, setContextMenu() {}, dirCreateLocal() {} };
    if (entry === 'tree') await h.load.functions(source('components/sidebar/UnifiedTree.tsx'), ['handleNewSubfolder'], bindings).handleNewSubfolder();
    else await h.load.functions(source('App.tsx'), ['handler'], bindings).handler({ key: 'N', ctrlKey: true, shiftKey: true, preventDefault() {} });
    assert.equal(h.calls.some(c => c.command === 'create_folder'), false);
    gate.resolve(); await moving;
  });
}

test('duplicate reserves before any delayed source read can outlive a folder rename', async () => {
  const h = harness(); await h.open(A); h.store.setState({ activeFolder: 'C:/isolated' });
  const read = h.hold('read_note'), create = h.hold('create_note');
  const copying = h.s().duplicateNote('C:/isolated'); await tick();
  await pathOperation(h, 'folder')();
  assert.equal(h.calls.some(c => c.command === 'rename_folder'), false);
  read.resolve(); create.resolve(); await copying;
});

test('duplicating an unlocked encrypted session must not write its plaintext into a new Markdown file', async () => {
  const h = harness(); await h.open(E);
  h.s().onNoteUnlocked(E, { id: E, content: 'private body', disk_version: h.disk.get(key(E)) }, 'test-password', h.s().encryptionDialog.requestId);
  await h.s().duplicateNote('C:/isolated');
  assert.equal(h.calls.some(c => c.command === 'write_note' && c.content === 'private body'), false);
});

for (const fails of [false, true]) {
  test(`same-task close drains accepted create body${fails ? ' and retains it on write failure' : ' to disk'}`, async () => {
    const h = harness(); await h.open(A);
    if (fails) h.failures.add('write_note');
    const path = 'C:/isolated/accepted.md';
    let destroys = 0;
    // No await/tick here: close races the registered path-operation microtask.
    const creating = h.s().createDocument('C:/isolated', 'accepted', 'accepted body');
    const closing = h.close(async () => { ++destroys; })({ preventDefault() {} });
    await Promise.all([creating, closing]);
    if (fails) {
      assert.equal(destroys, 0);
      const session = h.s().getDocumentSession(path);
      assert.equal(session?.content, 'accepted body');
      assert.equal(session.isDirty, true);
      assert.ok(h.s().openTabs.some(tab => tab.path === path));
      assert.equal(h.s().closing, null);
    } else {
      assert.equal(h.disk.get(key(path)), 'accepted body');
      assert.equal(destroys, 1);
    }
  });
}

test('initial create persistence does not depend on a second disk read', async () => {
  const h = harness();
  h.failures.add('read_note');
  const result = await h.s().createDocument('C:/isolated', 'accepted', 'supplied body');
  assert.ok(result);
  assert.equal(h.disk.get(key('C:/isolated/accepted.md')), 'supplied body');
});

test('create requested after close starts is rejected without creating a file', async () => {
  const h = harness(); await h.open(A); h.edit('hold close');
  const write = h.hold('write_note');
  const closing = h.close(async () => {})({ preventDefault() {} });
  assert.equal(await h.s().createDocument('C:/isolated', 'too-late', 'new body'), null);
  assert.equal(h.disk.has(key('C:/isolated/too-late.md')), false);
  write.resolve(); await closing;
});

test('failed initial deep-link write retains the supplied body and prevents window destroy', async () => {
  const h = harness(); await h.open(A); h.failures.add('write_note');
  await createEntry(h, 'deep-link')(); await tick();
  const created = h.s().getDocumentSession('C:/library/created.md');
  assert.equal(created?.content, 'deep-body'); assert.equal(created.isDirty, true);
  let destroyed = false; await h.close(async () => { destroyed = true; })({ preventDefault() {} });
  assert.equal(destroyed, false); assert.equal(h.s().getDocumentSession('C:/library/created.md').content, 'deep-body');
});

test('close started before a rename waits for the native phase after their shared save', async () => {
  const h = harness(); await h.open(A); h.edit('saved draft');
  const save = h.hold('write_note'), native = h.hold('rename_note');
  let closed = false; const closing = h.s().closeTab(A).then(() => { closed = true; }); await tick();
  const moving = pathOperation(h, 'file')(); save.resolve(); await tick();
  assert.equal(closed, false);
  native.resolve(); await Promise.all([moving, closing]);
  assert.equal(h.disk.has(key(A)), false); assert.equal(h.s().openTabs.length, 0);
});

test('flush includes a path mutation admitted before its first await resumes', async () => {
  const h = harness(); await h.open(A);
  let flushed = false; const flushing = h.s().flushPendingSaves().then(() => { flushed = true; });
  const native = h.hold('rename_note'), moving = pathOperation(h, 'file')(); await tick();
  assert.equal(flushed, false);
  native.resolve(); await Promise.all([moving, flushing]);
  assert.equal(h.disk.has(key(A)), false);
});

test('closeTab waits for native path migration and closes the migrated identity', async () => {
  const h = harness(); await h.open(A); const gate = h.hold('rename_note');
  const moving = pathOperation(h, 'file')(); await tick();
  let closed = false; const closing = h.s().closeTab(A).then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  gate.resolve(); await Promise.all([moving, closing]);
  assert.equal(h.s().openTabs.length, 0); assert.equal(h.disk.has(key(A)), false);
});

test('accepted open tokens distinguish same-path ABA and cancelled reads', async () => {
  const h = harness();
  const first = await h.open(A);
  assert.equal(typeof first, 'number');
  await h.open(B); const last = await h.open(A);
  assert.notEqual(first, last);
  assert.equal(h.s().isCurrentOpen(first), false);
  assert.equal(h.s().isCurrentOpen(last), true);
  const read = h.hold('read_note');
  const opening = h.s().openTemporaryFile('C:/missing.md');
  await h.open(A); read.resolve();
  assert.equal(await opening, null);
});

for (const stage of ['listen', 'save_config', 'scan_folder']) {
  test(`external import checks intent after ${stage}, including same-path ABA`, async () => {
    const h = harness(), pending = h.hold(stage);
    const opening = h.app().openExternalFile(A); await tick();
    await h.open(B); await h.open(A);
    h.editor.getState().setViewMode('editor');
    pending.resolve(); await opening;
    assert.equal(h.s().activeFolder, null);
    assert.equal(h.editor.getState().viewMode, 'editor');
    if (stage === 'listen') assert.deepEqual(Array.from(h.settings.getState().config.extra_folders), []);
    if (stage !== 'scan_folder') assert.equal(h.calls.some(c => c.command === 'scan_folder'), false);
  });
}

test('concurrent folder imports merge their pending configuration instead of dropping the first root', async () => {
  const h = harness(), saving = h.hold('save_config');
  const first = h.app().importExternalFolder('C:/first-import'); await tick();
  const second = h.app().importExternalFolder('C:/second-import'); await tick();
  saving.resolve(); await Promise.all([first, second]);
  assert.deepEqual(Array.from(h.settings.getState().config.extra_folders), ['C:/first-import', 'C:/second-import']);
  assert.deepEqual(h.calls.filter(call => call.command === 'scan_folder').map(call => call.folder).sort(), ['C:/first-import', 'C:/second-import']);
});

test('an import progress toast only uses its own scan and stops after its folder is removed', async () => {
  const h = harness(), scan = h.hold('scan_folder');
  const importing = h.app().importExternalFolder('C:/imported'); await tick();
  const request = h.calls.find(call => call.command === 'scan_folder');
  assert.ok(request);
  const before = h.events.length;
  h.emitProgress('unrelated-scan', 999);
  assert.equal(h.events.length, before, 'Another scan must not change the import toast');
  h.emitProgress(request.scanId, 7);
  assert.equal(h.events.at(-1).detail.message, 'toast.importingProgress 7');
  await h.settings.getState().updateConfig({ extra_folders: [] });
  const removed = h.events.length;
  h.emitProgress(request.scanId, 8);
  assert.equal(h.events.length, removed);
  scan.resolve(); assert.equal(await importing, false);
  assert.equal(h.events.some(event => event.detail.message === 'toast.importDone'), false);
});

test('failed external folder configuration does not scan or announce a completed import', async () => {
  const h = harness();
  h.failures.add('save_config');
  assert.equal(await h.app().importExternalFolder('C:/isolated'), false);
  assert.equal(h.calls.some(call => call.command === 'scan_folder'), false);
  assert.equal(h.events.some(event => event.detail.message === 'toast.importDone'), false);
  assert.ok(h.events.some(event => event.detail.type === 'warning'));
  assert.ok(h.calls.some(call => call.command === 'unlisten'));
});

test('late external folder listing cannot replace a newer sidebar selection', async () => {
  const h = harness();
  h.settings.setState({ config: { ...h.settings.getState().config, storage_path: 'C:/isolated' } });
  const listing = h.hold('get_notes_in_folder');
  const opening = h.app().openExternalFile(A); await tick();
  await h.open(B);
  await h.s().setActiveFolder('C:/other', 'C:/isolated');
  listing.resolve(); await opening;
  assert.equal(h.s().activeFolder, 'C:/other');
  assert.deepEqual(Array.from(h.s().notes, n => key(n.path)), [key(B)]);
});

test('browser-open aborts when saving the real active session fails', async () => {
  const h = harness(); await h.open(A); h.edit('new browser content'); h.failures.add('write_note');
  const opened = [];
  const { handleOpenInBrowser } = h.load.functions(source('components/preview/Preview.tsx'), ['handleOpenInBrowser'], {
    ...h.bindings, activeNote: h.s().activeNote, openPath: async path => opened.push(path),
  });
  await handleOpenInBrowser();
  assert.deepEqual(opened, []);
  assert.equal(h.s().getDocumentSession(A).content, 'new browser content');
  assert.equal(h.s().isDirty, true);
  h.failures.clear(); await handleOpenInBrowser();
  assert.deepEqual(opened, [A]);
  assert.equal(h.disk.get(key(A)), 'new browser content');
});

function pathOperation(h, kind, folderPath = 'C:/isolated') {
  const allNotesRef = { current: [...h.disk.keys()].map(note) };
  h.store.setState({ notes: allNotesRef.current, projects: [{ name: 'isolated', path: 'C:/isolated', children: [], is_root: false }] });
  const bindings = { ...h.bindings, allNotesRef, setAllNotes: update => { allNotesRef.current = update(allNotesRef.current); },
    renameNoteValue: 'renamed', renameFolderValue: 'renamed', setRenamingNoteId() {}, setRenamingFolderPath() {},
    project: { name: 'isolated', path: kind === 'move' ? 'C:/target' : folderPath }, isActive: false };
  if (kind === 'title') {
    return h.load.functions(source('components/editor/Editor.tsx'), ['handleTitleCommit'], {
      ...bindings, title: 'renamed', activeNote: note(A), setTitle() {},
    }).handleTitleCommit;
  }
  const tree = h.load.functions(source('components/sidebar/UnifiedTree.tsx'), [
    'stripExtendedPath', 'normPath', 'slashPath', 'baseName', 'isUnderPath', 'remapPath', 'projectTreeHas', 'dirRenameLocal', 'stripKnownExt',
    'dirCreateLocal', 'sortProjects', 'getParentPath',
    'handleRenameNoteSubmit', 'handleRenameFolderSubmit', 'onDrop',
  ], bindings);
  if (kind === 'file') return () => tree.handleRenameNoteSubmit(note(A));
  if (kind === 'folder') return () => tree.handleRenameFolderSubmit(bindings.project);
  return () => tree.onDrop({ preventDefault() {}, stopPropagation() {},
    dataTransfer: { getData: () => A }, currentTarget: { style: {} } });
}

for (const [kind, command, destination] of [
  ['file', 'rename_note', 'C:/isolated/renamed.md'],
  ['move', 'move_note', 'C:/target/A.md'],
  ['folder', 'rename_folder', 'C:/renamed/A.md'],
  ['title', 'rename_note', 'C:/isolated/renamed.md'],
]) {
  test(`${kind} rename/move drains native writes before relocating the disk file`, async () => {
    const h = harness(); await h.open(A); h.edit('draft before relocation');
    const write = h.hold('write_note'); const saving = h.s().saveCurrentNote(); await tick();
    const relocate = pathOperation(h, kind)(); await tick();
    assert.equal(h.calls.some(c => c.command === command), false, 'native relocation must not overtake a save');
    h.edit('last old-path edit'); write.resolve(); await Promise.all([saving, relocate]);
    assert.equal(h.disk.has(key(A)), false, 'old path must not be recreated');
    assert.equal(h.disk.get(key(destination)), 'last old-path edit');
    assert.equal(h.s().getDocumentSession(destination).isDirty, false);
    h.edit('new-path edit'); await h.s().saveCurrentNote(); await h.timers();
    assert.equal(h.disk.has(key(A)), false);
    assert.equal(h.disk.get(key(destination)), 'new-path edit');
    if (kind !== 'folder') assert.ok(h.events.some(e => e.name === 'note-path-changed'));
  });

  test(`${kind} rename/move cancels after save failure without losing the draft`, async () => {
    const h = harness(); await h.open(A); h.edit('recoverable'); h.failures.add('write_note');
    await pathOperation(h, kind)();
    assert.equal(h.calls.some(c => c.command === command), false);
    assert.equal(h.disk.get(key(A)), 'alpha');
    assert.equal(h.s().getDocumentSession(A).content, 'recoverable');
    assert.equal(h.s().getDocumentSession(A).isDirty, true);
  });
}

for (const kind of ['close', 'file', 'folder']) {
  test(`${kind} of the external tab invalidates its pending import`, async () => {
    const h = harness(), listen = h.hold('listen');
    const opening = h.app().openExternalFile(A); await tick();
    if (kind === 'close') await h.s().closeTab(A);
    else await pathOperation(h, kind)();
    listen.resolve(); await opening;
    assert.equal(h.s().activeFolder, null);
    assert.deepEqual(Array.from(h.settings.getState().config.extra_folders), []);
  });
}

test('folder relocation drains every descendant but not similarly named sibling folders', async () => {
  const h = harness(), child = 'C:/isolated/nested/C.md', sibling = 'C:/isolated-copy/D.md';
  h.disk.set(key(child), 'child'); h.disk.set(key(sibling), 'sibling');
  await h.open(A); await h.open(child); await h.open(E);
  const request = h.s().encryptionDialog.requestId;
  h.s().onNoteUnlocked(E, { id: E, content: 'secret', disk_version: h.disk.get(key(E)) }, 'test-password', request);
  await h.open(sibling);
  for (const [path, body] of [[A, 'A draft'], [child, 'child draft'], [E, 'encrypted draft'], [sibling, 'unrelated draft']]) {
    assert.equal(h.s().updateDocumentContent(path, body, h.s().getDocumentRevision(path)), true);
  }
  const first = h.hold('write_note'), second = h.hold('write_note'), secret = h.hold('save_encrypted_note');
  const relocating = pathOperation(h, 'folder')(); await tick();
  first.resolve(); await tick(); second.resolve(); await tick();
  assert.equal(h.calls.some(c => c.command === 'rename_folder'), false);
  secret.resolve(); await relocating;
  assert.equal(h.disk.has(key(A)), false); assert.equal(h.disk.has(key(child)), false); assert.equal(h.disk.has(key(E)), false);
  assert.equal(h.disk.get(key('C:/renamed/A.md')), 'A draft');
  assert.equal(h.disk.get(key('C:/renamed/nested/C.md')), 'child draft');
  assert.equal(h.disk.get(key('C:/renamed/secret.md.encrypted')), 'encrypted draft');
  assert.equal(h.disk.get(key(sibling)), 'sibling'); assert.equal(h.s().getDocumentSession(sibling).isDirty, true);
  assert.equal(h.calls.some(c => c.command === 'write_note' && c.path === E), false);
});

test('native relocation holds edits and duplicate operations until path migration finishes', async () => {
  const h = harness(); await h.open(A); h.edit('preserved draft');
  const native = h.hold('rename_note'); const relocate = pathOperation(h, 'file');
  const moving = relocate(); await tick();
  assert.equal(h.s().updateDocumentContent(A, 'late edit', h.s().getDocumentRevision(A)), false);
  assert.equal(await h.open(A), null);
  await relocate();
  assert.equal(h.calls.filter(c => c.command === 'rename_note').length, 1);
  await h.s().saveCurrentNote(); native.resolve(); await moving;
  assert.equal(h.disk.has(key(A)), false); assert.equal(h.disk.get(key('C:/isolated/renamed.md')), 'preserved draft');
});

test('native relocation failure releases the edit guard and keeps the saved source', async () => {
  const h = harness(); await h.open(A); h.edit('source draft');
  await assert.rejects(h.s().withDocumentPathChange(A, false, async () => { throw new Error('native rename denied'); }), /native rename denied/);
  assert.equal(h.disk.get(key(A)), 'source draft');
  assert.equal(h.s().updateDocumentContent(A, 'editable again', h.s().getDocumentRevision(A)), true);
});

test('window close waits for an already issued native relocation and saves only its new path', async () => {
  const h = harness(); await h.open(A); h.edit('moving draft');
  const native = h.hold('rename_note');
  const moving = pathOperation(h, 'file')(); await tick();
  let destroys = 0;
  const close = h.close(async () => { ++destroys; });
  const closing = close({ preventDefault() {} }); await tick();
  assert.equal(destroys, 0);
  native.resolve(); await Promise.all([moving, closing]);
  assert.equal(destroys, 1);
  assert.equal(h.disk.has(key(A)), false);
  assert.equal(h.disk.get(key('C:/isolated/renamed.md')), 'moving draft');
});

test('window destroy pending rejects edits, opens and duplicate destroy requests', async () => {
  const h = harness(); await h.open(A); h.edit('final saved draft');
  const destroy = deferred(); let destroys = 0;
  const close = h.close(async () => { ++destroys; await destroy.promise; });
  const closing = close({ preventDefault() {} }); await tick();
  assert.equal(h.s().closing, 'destroying');
  const revision = h.s().getDocumentRevision(A);
  assert.equal(h.s().updateDocumentContent(A, 'too late', revision), false);
  h.edit('also too late');
  assert.equal(h.s().activeContent, 'final saved draft');
  assert.equal(await h.open(B), null);
  assert.equal(await h.s().openTemporaryFile(B), null);
  await close({ preventDefault() {} }); assert.equal(destroys, 1);
  destroy.reject(new Error('isolated native denial')); await closing;
  assert.equal(h.s().closing, null);
  assert.equal(h.s().updateDocumentContent(A, 'retry edit', revision), true);
});

for (const pendingKind of ['read', 'unlock']) {
  test(`window close invalidates pending ${pendingKind} even when saving fails`, async () => {
    const h = harness(); await h.open(A); h.edit('retained draft'); h.failures.add('write_note');
    const read = pendingKind === 'read' ? h.hold('read_note') : null;
    const opening = h.open(pendingKind === 'read' ? B : E);
    const request = h.s().encryptionDialog?.requestId;
    const save = h.hold('write_note');
    const close = h.close(async () => assert.fail('failed save must not destroy'));
    const closing = close({ preventDefault() {} }); await tick();
    assert.equal(h.s().closing, 'draining');
    assert.equal(await h.open(E), null);
    save.resolve(); await closing;
    read?.resolve(); await opening;
    if (pendingKind === 'unlock') assert.equal(h.s().onNoteUnlocked(E, { id: E, content: 'secret', disk_version: h.disk.get(key(E)) }, 'test-password', request), false);
    assert.equal(h.s().activeNote.path, A);
    assert.equal(h.s().activeContent, 'retained draft');
    assert.equal(h.s().closing, null);
    assert.equal(h.s().openTabs.length, 1);
    h.edit('editable after failure'); assert.equal(h.s().activeContent, 'editable after failure');
  });
}

test('superseded external open cannot import a folder or move the sidebar', async () => {
  const h = harness(), read = h.hold('read_note');
  const opening = h.app().openExternalFile(A);
  await h.open(B);
  read.resolve(); await opening;
  assert.equal(h.s().activeNote.path, B);
  assert.equal(h.s().activeFolder, null);
  assert.deepEqual(Array.from(h.settings.getState().config.extra_folders), []);
  assert.equal(h.calls.some(c => c.command === 'scan_folder'), false);
});
