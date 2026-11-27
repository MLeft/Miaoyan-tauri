import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { Editor } from '../src/components/editor/Editor';
import { useNotesStore } from '../src/stores/notes-store';
import { useSettingsStore } from '../src/stores/settings-store';

const path = 'C:/editor-fixture/revision.md';
const note = { id: path, path, title: 'revision.md', folder: 'C:/editor-fixture',
  created_at: '', modified_at: '', pinned: false, size: 5, is_encrypted: false };
const expect = (condition, message) => { if (!condition) throw new Error(message); };

export async function withEditor(run, native = {}, options = {}) {
  const previousTauri = window.__TAURI_INTERNALS__;
  const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const config = useSettingsStore.getState().config;
  const disk = new Map([[path, options.content ?? 'alpha']]);
  window.__TAURI_INTERNALS__ = { ...previousTauri, async invoke(command, args) {
    if (command === 'read_note') return { id: args.path, content: disk.get(args.path), disk_version: disk.get(args.path) };
    if (command === 'write_note') { disk.set(args.path, args.content); return args.content; }
    if (command === 'write_log') return;
    if (native[command]) return native[command](args);
    throw new Error(`Unexpected native command: ${command}`);
  } };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  useSettingsStore.setState({ config: { ...config, ...options.config, auto_save_interval: 0, image_upload_service: 'none' } });
  const mount = document.createElement('div');
  document.body.append(mount);
  const root = createRoot(mount);
  const store = () => useNotesStore.getState();
  const view = () => EditorView.findFromDOM(mount.querySelector('.cm-editor'));
  try {
    await act(async () => {
      await store().selectNote(note);
      options.beforeRender?.();
      root.render(options.element ?? React.createElement(Editor));
    });
    expect(view(), 'Real React Editor did not mount a CodeMirror view');
    await run({ store, view, disk, mount, removeEditor: () => act(async () => root.render(null)) });
  } finally {
    await act(async () => root.unmount());
    await store().closeAllTabs();
    mount.remove();
    useSettingsStore.setState({ config });
    window.__TAURI_INTERNALS__ = previousTauri;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
}

// Browser runner entry; intentionally not wired into the shared runner here.
export async function testEditorRevision() {
  const cases = [];
  for (const run of [testEditorRevisionSync, testEditorSessionIdentity, testEditorTransactionGuards, testEditorImagePaste]) {
    cases.push(await run());
  }
  return { passed: true, cases };
}

export async function testEditorRevisionSync() {
  await withEditor(async ({ store, view, disk }) => {
    const editor = view();
    const stale = editor.state.update({ changes: { from: 0, insert: 'stale ' } });
    // Both CAS updates occur in one task; React sees the original string again.
    await act(async () => {
      expect(store().updateDocumentContent(path, 'bravo', store().getDocumentRevision(path)), 'First CAS failed');
      expect(store().updateDocumentContent(path, 'alpha', store().getDocumentRevision(path)), 'Second CAS failed');
    });
    expect(view() === editor, 'Content revisions must not recreate the editor');
    await act(async () => editor.dispatch(stale));
    expect(editor.state.doc.toString() === 'alpha', 'Prebuilt old-revision transaction was accepted');
    await act(async () => editor.dispatch({ changes: { from: 5, insert: '!' } }));
    expect(editor.state.doc.toString() === 'alpha!', 'Normal input stayed frozen after same-task content ABA');
    await act(async () => editor.dispatch({ changes: { from: 6, insert: '?' } }));
    expect(store().activeContent === 'alpha!?', 'Subsequent input failed the revision CAS');
    await act(async () => store().saveCurrentNote());
    expect(disk.get(path) === 'alpha!?', 'Editor input did not reach the saved body');
  });
  return { passed: true, case: 'React Editor content ABA revision sync' };
}

export async function testEditorSessionIdentity() {
  await withEditor(async ({ store, view }) => {
    const previous = view();
    // Same metadata/id and body, but a different session after close/reopen.
    await act(async () => { await store().closeTab(path); await store().selectNote(note); });
    expect(view() !== previous, 'Same-path reopened session reused the old view identity');
    await act(async () => view().dispatch({ changes: { from: 5, insert: ' reopened' } }));
    expect(store().activeContent === 'alpha reopened', 'Reopened document remained stuck on its old revision');
  });
  return { passed: true, case: 'React Editor same-path session replacement' };
}

export async function testEditorImagePaste() {
  let finishImage, imageStarted;
  const toasts = [];
  const onToast = event => toasts.push(event.detail);
  const paste = async view => {
    const started = new Promise(resolve => { imageStarted = resolve; });
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([new Uint8Array([1, 2])], 'fixture.png', { type: 'image/png' }));
    await act(async () => {
      view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
      await started;
    });
  };
  window.addEventListener('show-toast', onToast);
  try {
    await withEditor(async ({ store, view, removeEditor }) => {
      await act(async () => view().dispatch({ selection: { anchor: 1, head: 4 } }));
      await paste(view());
      await act(async () => view().dispatch({ changes: { from: 1, to: 4, insert: 'typed' } }));
      expect(store().activeContent === 'atypeda', 'Pending image upload blocked ordinary input');
      await act(async () => { finishImage('images/browser.png'); });
      expect(store().activeContent === 'atyped![](images/browser.png)a', 'Real Editor did not map the pending paste selection');
      expect(toasts.length === 0, 'Normal typing incorrectly cancelled the paste');
      await paste(view());
      await removeEditor(); // Real ViewPlugin.destroy, without a store path change.
      expect(toasts.some(t => /cancel|取消/i.test(t.message)), 'View destruction silently discarded the pending paste');
      const body = store().activeContent;
      await act(async () => { finishImage('images/recover.png'); });
      expect(store().activeContent === body, 'Destroyed view wrote its late paste');
      expect(toasts.some(t => t.message.includes('images/recover.png')), 'Late saved image has no recovery link');
    }, { save_image: () => new Promise(resolve => { finishImage = resolve; imageStarted(); }) });
  } finally {
    window.removeEventListener('show-toast', onToast);
  }
  return { passed: true, case: 'React Editor image mapping and view destruction recovery' };
}

export async function testEditorTransactionGuards() {
  await withEditor(async ({ store, view }) => {
    await act(async () => view().dispatch({ changes: { from: 0, insert: 'saved ' } }));
    const stale = view().state.update({ changes: { from: 0, insert: 'stale ' } });
    let release, moving;
    const gate = new Promise(resolve => { release = resolve; });
    await act(async () => { moving = store().withDocumentPathChange(path, false, () => gate); });
    try {
      await act(async () => {
        view().dispatch(stale);
        undo(view()); // CodeMirror's real filter:false transaction.
        view().dispatch({ changes: { from: 0, insert: 'locked ' } });
      });
      expect(view().state.doc.toString() === 'saved alpha', 'Sealed view accepted a prebuilt, undo or input transaction');
      expect(store().activeContent === 'saved alpha', 'Sealed session body changed');
    } finally {
      await act(async () => { release(); await moving; });
    }
    await act(async () => undo(view()));
    expect(store().activeContent === 'alpha', 'Undo did not recover after unlock');
  });
  return { passed: true, case: 'React Editor dispatch/filter double guard' };
}
