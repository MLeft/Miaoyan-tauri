import { EditorView, KeyBinding } from '@codemirror/view';
import { EditorState } from '@codemirror/state';

function wrapSelection(view: EditorView, before: string, after: string): boolean {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);

  // Check if already wrapped - if so, unwrap
  const docBefore = view.state.sliceDoc(Math.max(0, from - before.length), from);
  const docAfter = view.state.sliceDoc(to, Math.min(view.state.doc.length, to + after.length));

  if (docBefore === before && docAfter === after) {
    // Unwrap
    view.dispatch({
      changes: [
        { from: from - before.length, to: from, insert: '' },
        { from: to, to: to + after.length, insert: '' },
      ],
      selection: { anchor: from - before.length, head: to - before.length },
    });
    return true;
  }

  // Wrap
  view.dispatch({
    changes: [
      { from, to: from, insert: before },
      { from: to, to, insert: after },
    ],
    selection: { anchor: from + before.length, head: to + before.length },
  });
  return true;
}

function insertAtLineStart(view: EditorView, prefix: string): boolean {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  view.dispatch({
    changes: { from: line.from, to: line.from, insert: prefix },
  });
  return true;
}

const boldBinding: KeyBinding = {
  key: 'Mod-b',
  run(view) { return wrapSelection(view, '**', '**'); },
};

const italicBinding: KeyBinding = {
  key: 'Mod-i',
  run(view) { return wrapSelection(view, '*', '*'); },
};

const underlineBinding: KeyBinding = {
  key: 'Mod-u',
  run(view) { return wrapSelection(view, '<u>', '</u>'); },
};

const strikethroughBinding: KeyBinding = {
  key: 'Mod-Shift-x',
  run(view) { return wrapSelection(view, '~~', '~~'); },
};

const linkBinding: KeyBinding = {
  key: 'Mod-k',
  run(view) {
    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to);
    const insert = selected ? `[${selected}](url)` : '[text](url)';
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + 1, head: from + 1 + (selected || 'text').length },
    });
    return true;
  },
};

const codeBlockBinding: KeyBinding = {
  key: 'Mod-Shift-c',
  run(view) {
    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to);
    const insert = selected
      ? '```\n' + selected + '\n```'
      : '```\n\n```';
    const cursorPos = selected ? from + 4 + selected.length + 4 : from + 4;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: selected ? from + 4 : from + 4 },
    });
    return true;
  },
};

const inlineCodeBinding: KeyBinding = {
  key: 'Mod-e',
  run(view) { return wrapSelection(view, '`', '`'); },
};

export const textFormattingKeymap: KeyBinding[] = [
  boldBinding,
  italicBinding,
  underlineBinding,
  strikethroughBinding,
  linkBinding,
  codeBlockBinding,
  inlineCodeBinding,
];
