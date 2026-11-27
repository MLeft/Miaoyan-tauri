import React, { act } from 'react';
import { EditorView } from '@codemirror/view';
import { Compartment, EditorState } from '@codemirror/state';
import { isolateHistory, undo, redo, undoDepth, redoDepth } from '@codemirror/commands';
import { Editor } from '../src/components/editor/Editor';
import { restoreEditorViewState } from '../src/components/editor/editor-view-state';
import { useNotesStore } from '../src/stores/notes-store';
import { useEditorStore } from '../src/stores/editor-store';
import { useSettingsStore } from '../src/stores/settings-store';
import { withEditor } from './editor-revision.browser.mjs';
import '../src/styles/globals.css';

const A = 'C:/editor-fixture/revision.md';
const B = 'C:/editor-fixture/other.md';
const renamed = 'C:/editor-fixture/renamed.md';
const note = path => ({ id: path, path, title: path.split('/').pop(), folder: 'C:/editor-fixture',
  created_at: '', modified_at: '', pinned: false, size: 5, is_encrypted: false });
const expect = (condition, message) => { if (!condition) throw new Error(message); };
const longBody = Array.from({ length: 160 }, (_, i) => `Line ${i + 1}: editor state fixture`).join('\n');
const type = (view, text) => act(async () => view().dispatch({
  changes: { from: view().state.doc.length, insert: text }, annotations: isolateHistory.of('full'),
}));
const select = (view, anchor, head) => act(async () => view().dispatch({ selection: { anchor, head } }));
const selectionIs = (view, anchor, head) => view().state.selection.main.anchor === anchor && view().state.selection.main.head === head;
const mode = value => act(async () => useEditorStore.getState().setViewMode(value));

function ModeEditor() {
  const viewMode = useEditorStore(state => state.viewMode);
  return viewMode === 'preview' ? null : React.createElement(Editor);
}

async function fixture(run, options = {}) {
  const previous = useEditorStore.getState().viewMode;
  try {
    await withEditor(async context => {
      context.mount.style.cssText = 'position:fixed;top:0;left:0;width:720px;height:400px';
      await run(context);
    }, {}, { ...options, element: React.createElement(ModeEditor),
      beforeRender: () => useEditorStore.getState().setViewMode('editor'),
    });
  } finally {
    useEditorStore.getState().setViewMode(previous);
  }
}

// Wait for real CodeMirror layout and the following DOM frame, not a timed sleep.
async function measured(view) {
  await new Promise(resolve => view.requestMeasure({ read: () => null, write: () => requestAnimationFrame(resolve) }));
}

async function until(check, message) {
  const deadline = performance.now() + 4000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(message);
    await new Promise(requestAnimationFrame);
  }
}

async function openB(store, disk) {
  disk.set(B, 'bravo');
  await act(async () => {
    await store().selectNote(note(B));
    useEditorStore.getState().setViewMode('editor');
  });
}

export async function testEditorTabState() {
  await fixture(async ({ store, view, disk }) => {
    await type(view, '!');
    await type(view, '?');
    await act(async () => undo(view()));
    await select(view, 4, 1);
    await openB(store, disk);
    await type(view, ' B');
    await select(view, 2, 6);
    await act(async () => store().switchTab(A));
    expect(selectionIs(view, 4, 1), 'A/B switch lost A backward selection');
    expect(undoDepth(view().state) === 1 && redoDepth(view().state) === 1, 'A/B switch lost undo or redo history');
    await act(async () => redo(view()));
    expect(store().activeContent === 'alpha!?', 'Restored redo did not edit A');
    await act(async () => { undo(view()); undo(view()); });
    expect(store().activeContent === 'alpha', 'Restored undo did not reach A original body');
    await act(async () => store().switchTab(B));
    expect(selectionIs(view, 2, 6), 'A/B switch lost B selection');
    await act(async () => undo(view()));
    expect(store().activeContent === 'bravo', 'B history was lost or mixed with A');
  });
  return { passed: true, case: 'A/B/A independent undo, redo and selections' };
}

export async function testEditorModeState() {
  await fixture(async ({ store, view, mount }) => {
    await type(view, '!');
    for (const from of ['editor', 'split']) {
      await mode(from);
      await select(view, 5, 2);
      const old = view();
      await mode('preview');
      expect(!mount.querySelector('.cm-editor'), 'Preview mode did not unmount real Editor');
      await mode(from);
      expect(view() !== old, 'Mode test did not create a fresh view');
      expect(selectionIs(view, 5, 2), `${from}/preview lost selection`);
      await act(async () => undo(view()));
      expect(store().activeContent === 'alpha', `${from}/preview lost undo`);
      await mode('preview');
      await mode(from);
      await act(async () => redo(view()));
      expect(store().activeContent === 'alpha!', `${from}/preview lost redo`);
    }
  });
  return { passed: true, case: 'editor and split preview unmount/remount history' };
}

export async function testEditorScrollState() {
  await fixture(async ({ store, view, disk }) => {
    await measured(view());
    expect(view().scrollDOM.scrollHeight > view().scrollDOM.clientHeight * 3, 'Long editor fixture is not scrollable');
    await act(async () => view().dispatch({ effects: EditorView.scrollIntoView(view().state.doc.line(125).from, { y: 'start' }) }));
    await measured(view());
    view().scrollDOM.scrollTop += 7;
    await measured(view());
    const top = view().scrollDOM.scrollTop;
    expect(top > 1000, 'Fixture did not reach line 125');
    await openB(store, disk);
    await act(async () => store().switchTab(A));
    await until(() => Math.abs(view().scrollDOM.scrollTop - top) < 2, 'A/B/A lost measured scroll position');
    await mode('preview');
    await mode('editor');
    await until(() => Math.abs(view().scrollDOM.scrollTop - top) < 2, 'Mode remount lost measured scroll position');
  }, { content: longBody });
  return { passed: true, case: '160-line scroll anchor and pixel offset restoration' };
}

export async function testEditorRenameState() {
  await fixture(async ({ store, view, disk }) => {
    const identity = store().getDocumentSession(A).identity;
    await type(view, '!');
    await select(view, 4, 1);
    await act(async () => store().withDocumentPathChange(A, false, async () => {
      disk.set(renamed, disk.get(A)); disk.delete(A);
      store().applyNotePathChange(A, renamed, 'renamed.md');
    }, [{ path: renamed, directory: false }]));
    expect(store().getDocumentSession(renamed).identity === identity, 'Rename unexpectedly replaced session identity');
    expect(selectionIs(view, 4, 1), 'Rename lost selection');
    await act(async () => undo(view()));
    expect(store().activeContent === 'alpha', 'Rename lost history or retained old-path callbacks');
    await type(view, ' renamed');
    expect(store().getDocumentSession(renamed).content === 'alpha renamed', 'Renamed editor used stale revision/path');
  });
  return { passed: true, case: 'rename keeps identity/history and refreshes callbacks' };
}

export async function testEditorClosedState() {
  await fixture(async ({ store, view, disk }) => {
    const identity = store().getDocumentSession(A).identity;
    await type(view, '!');
    await select(view, 5, 1);
    await mode('preview');
    await act(async () => store().closeTab(A));
    // Check release before reopening: a new identity alone could hide a memory leak.
    const fresh = EditorState.create({ doc: 'alpha!' });
    expect(restoreEditorViewState(identity, fresh, new Compartment()).state === fresh,
      'Closing in preview retained the closed session snapshot');
    await act(async () => store().selectNote(note(A)));
    expect(store().getDocumentSession(A).identity !== identity, 'Reopen did not get a fresh identity');
    await mode('editor');
    expect(disk.get(A) === 'alpha!', 'Close did not save the fixture draft');
    expect(undoDepth(view().state) === 0 && redoDepth(view().state) === 0, 'Preview close/reopen resurrected old history');
    expect(selectionIs(view, 0, 0), 'Reopen resurrected old selection');
    await type(view, ' new');
    expect(store().activeContent === 'alpha! new', 'Reopened session could not edit');
  });
  return { passed: true, case: 'close in preview and same-path reopen reset state' };
}

export async function testEditorHiddenContent() {
  await fixture(async ({ store, view }) => {
    await type(view, '!');
    await select(view, 5, 2);
    await mode('preview');
    await act(async () => {
      expect(store().updateDocumentContent(A, 'other', store().getDocumentRevision(A)), 'Hidden ABA first CAS failed');
      expect(store().updateDocumentContent(A, 'alpha!', store().getDocumentRevision(A)), 'Hidden ABA second CAS failed');
    });
    await mode('editor');
    expect(selectionIs(view, 5, 2), 'Hidden same-text ABA lost selection');
    await act(async () => undo(view()));
    expect(store().activeContent === 'alpha', 'Same-text ABA did not restore valid history/latest revision');
    await type(view, ' input');
    expect(store().activeContent === 'alpha input', 'Same-text ABA left typing frozen');
    await mode('preview');
    await act(async () => store().updateDocumentContent(A, 'x', store().getDocumentRevision(A)));
    await mode('editor');
    expect(view().state.doc.toString() === 'x', 'Hidden content update restored stale body');
    expect(undoDepth(view().state) === 0 && redoDepth(view().state) === 0, 'Changed hidden body retained incompatible history');
    expect(view().state.selection.ranges.every(r => r.to <= 1), 'Changed body restored out-of-range selection');
    await act(async () => undo(view()));
    expect(store().activeContent === 'x', 'Undo corrupted externally changed body');
    await type(view, '!');
    expect(store().activeContent === 'x!', 'Changed hidden body could not accept input');
  });
  await fixture(async ({ store, view }) => {
    await measured(view());
    await act(async () => view().dispatch({ effects: EditorView.scrollIntoView(view().state.doc.line(125).from, { y: 'start' }) }));
    await measured(view());
    await select(view, longBody.length, longBody.length - 3);
    await mode('preview');
    await act(async () => store().updateDocumentContent(A, 'short', store().getDocumentRevision(A)));
    await mode('editor');
    await measured(view());
    expect(selectionIs(view, 5, 5), 'Shrunken document did not clamp selection');
    expect(view().scrollDOM.scrollTop === 0, 'Shrunken document restored invalid scroll');
  }, { content: longBody });
  return { passed: true, case: 'hidden external change/ABA, revision and legal bounds' };
}

export async function testEditorFonts() {
  await fixture(async ({ store, view, mount }) => {
    expect(getComputedStyle(view().contentDOM).fontFamily === 'serif', 'Initial configured editor family was ignored');
    expect(getComputedStyle(view().contentDOM).fontSize === '19px', 'Initial configured editor size was ignored');
    expect(getComputedStyle(mount.querySelector('input')).fontSize === '27px', 'Initial configured title size was ignored');
    await type(view, '!');
    await select(view, 4, 1);
    const previous = view();
    await act(async () => useSettingsStore.setState(state => ({ config: { ...state.config,
      editor_font_family: 'monospace', editor_font_size: 24, title_font_size: 32, letter_spacing: 3,
    } })));
    await measured(view());
    expect(view() === previous && selectionIs(view, 4, 1), 'Font change recreated view or lost selection');
    expect(getComputedStyle(view().contentDOM).fontFamily === 'monospace', 'Dynamic editor font family was ignored');
    expect(getComputedStyle(view().contentDOM).fontSize === '24px', 'Dynamic editor font size was ignored');
    expect(getComputedStyle(mount.querySelector('input')).fontSize === '32px', 'Dynamic document title size was ignored');
    expect(['normal', '0px'].includes(getComputedStyle(view().contentDOM).letterSpacing), 'Editor enabled costly global letter spacing');
    await act(async () => undo(view()));
    expect(store().activeContent === 'alpha', 'Font reconfiguration lost undo history');
    await act(async () => redo(view()));
    expect(store().activeContent === 'alpha!', 'Font reconfiguration lost redo history');
  }, { config: { editor_font_family: 'serif', editor_font_size: 19, title_font_size: 27 } });
  return { passed: true, case: 'initial/dynamic editor and title fonts without history loss' };
}

export async function testEditorCacheLookupCost() {
  await fixture(async ({ store, view, disk }) => {
    await openB(store, disk);
    await act(async () => store().switchTab(A));
    const getSession = store().getDocumentSession;
    let inactiveLookups = 0;
    await act(async () => useNotesStore.setState({ getDocumentSession(path) {
      if (path === B) inactiveLookups++;
      return getSession(path);
    } }));
    try {
      // Includes the first dirty publication, not just already-dirty keystrokes.
      await type(view, '1'); await type(view, '2'); await type(view, '3');
      await act(async () => store().saveCurrentNote());
      expect(inactiveLookups === 0, 'Editing/saving scanned inactive sessions for snapshot cleanup');
    } finally {
      await act(async () => useNotesStore.setState({ getDocumentSession: getSession }));
    }
  });
  return { passed: true, case: 'typing and save do not scan inactive sessions for cache pruning' };
}

export async function testEditorScrollCleanup() {
  const nativeRaf = window.requestAnimationFrame, nativeCancel = window.cancelAnimationFrame;
  const nativeTimeout = window.setTimeout, nativeClear = window.clearTimeout;
  const frames = new Set(), suppressionTimers = new Set();
  window.requestAnimationFrame = callback => {
    const id = nativeRaf.call(window, time => { frames.delete(id); callback(time); });
    frames.add(id); return id;
  };
  window.cancelAnimationFrame = id => { frames.delete(id); nativeCancel.call(window, id); };
  window.setTimeout = (callback, delay, ...args) => {
    const id = nativeTimeout.call(window, (...values) => { suppressionTimers.delete(id); callback(...values); }, delay, ...args);
    if (delay === 500) suppressionTimers.add(id);
    return id;
  };
  window.clearTimeout = id => { suppressionTimers.delete(id); nativeClear.call(window, id); };
  try {
    await fixture(async ({ view, removeEditor }) => {
      await measured(view());
      await type(view, '\nnew line');
      expect(frames.size > 0, 'Fixture did not queue real editor RAF work');
      await removeEditor();
      expect(frames.size === 0, 'Destroyed editor retained queued RAF work');
    }, { content: longBody });
    await fixture(async ({ store, view, disk }) => {
      await measured(view());
      for (const name of ['editor-scroll-to-line', 'preview-scroll-to-line']) {
        window.dispatchEvent(new CustomEvent(name, { detail: { line: 125 } }));
      }
      expect(suppressionTimers.size === 1, 'Scroll suppression accumulated reset timers');
      await openB(store, disk);
      expect(suppressionTimers.size === 0, 'Tab switch retained old scroll suppression timer');
      window.dispatchEvent(new CustomEvent('preview-scroll-to-line', { detail: { line: 1 } }));
      await mode('preview');
      expect(suppressionTimers.size === 0, 'Mode unmount retained scroll suppression timer');
    }, { content: longBody });
  } finally {
    window.requestAnimationFrame = nativeRaf; window.cancelAnimationFrame = nativeCancel;
    window.setTimeout = nativeTimeout; window.clearTimeout = nativeClear;
  }
  return { passed: true, case: 'destroy cancels editor RAF and latest scroll suppression reset' };
}

// Main session can wire this single entry into the shared runner.
export async function testEditorState() {
  const cases = [];
  for (const run of [testEditorTabState, testEditorModeState, testEditorScrollState, testEditorRenameState,
    testEditorClosedState, testEditorHiddenContent, testEditorFonts, testEditorCacheLookupCost, testEditorScrollCleanup]) cases.push(await run());
  return { passed: true, cases };
}
