import { EditorView, KeyBinding } from '@codemirror/view';
import { EditorState } from '@codemirror/state';

export function wrapSelection(view: EditorView, before: string, after: string): boolean {
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

/** Toggle unordered list prefix "- " on all selected lines */
export function toggleUnorderedList(view: EditorView): boolean {
  const { from, to } = view.state.selection.main;
  const firstLine = view.state.doc.lineAt(from);
  const lastLine = view.state.doc.lineAt(to);

  // Determine whether ALL lines already have "- " prefix
  let allHavePrefix = true;
  for (let lineNo = firstLine.number; lineNo <= lastLine.number; lineNo++) {
    const line = view.state.doc.line(lineNo);
    if (!line.text.startsWith('- ')) { allHavePrefix = false; break; }
  }

  const changes: { from: number; to: number; insert: string }[] = [];
  for (let lineNo = firstLine.number; lineNo <= lastLine.number; lineNo++) {
    const line = view.state.doc.line(lineNo);
    if (allHavePrefix) {
      // Remove "- "
      changes.push({ from: line.from, to: line.from + 2, insert: '' });
    } else if (!line.text.startsWith('- ')) {
      // Add "- "
      changes.push({ from: line.from, to: line.from, insert: '- ' });
    }
  }
  if (changes.length) view.dispatch({ changes });
  return true;
}

/** Toggle ordered list prefixes "1. ", "2. " ... on all selected lines */
export function toggleOrderedList(view: EditorView): boolean {
  const { from, to } = view.state.selection.main;
  const firstLine = view.state.doc.lineAt(from);
  const lastLine = view.state.doc.lineAt(to);

  const orderedRe = /^\d+\.\s/;

  // Determine whether ALL lines already have a numbered prefix
  let allHavePrefix = true;
  for (let lineNo = firstLine.number; lineNo <= lastLine.number; lineNo++) {
    const line = view.state.doc.line(lineNo);
    if (!orderedRe.test(line.text)) { allHavePrefix = false; break; }
  }

  const changes: { from: number; to: number; insert: string }[] = [];
  let counter = 1;
  for (let lineNo = firstLine.number; lineNo <= lastLine.number; lineNo++) {
    const line = view.state.doc.line(lineNo);
    if (allHavePrefix) {
      // Remove existing "N. "
      const match = line.text.match(/^(\d+\.\s)/);
      if (match) changes.push({ from: line.from, to: line.from + match[1].length, insert: '' });
    } else if (!orderedRe.test(line.text)) {
      changes.push({ from: line.from, to: line.from, insert: `${counter}. ` });
    }
    counter++;
  }
  if (changes.length) view.dispatch({ changes });
  return true;
}

/** Toggle todo list prefix "- [ ] " on all selected lines */
export function toggleTodoList(view: EditorView): boolean {
  const { from, to } = view.state.selection.main;
  const firstLine = view.state.doc.lineAt(from);
  const lastLine = view.state.doc.lineAt(to);

  // Determine whether ALL lines already have "- [ ] " or "- [x] " prefix
  let allHavePrefix = true;
  for (let lineNo = firstLine.number; lineNo <= lastLine.number; lineNo++) {
    const line = view.state.doc.line(lineNo);
    if (!line.text.match(/^- \[[ x]\] /)) { allHavePrefix = false; break; }
  }

  const changes: { from: number; to: number; insert: string }[] = [];
  for (let lineNo = firstLine.number; lineNo <= lastLine.number; lineNo++) {
    const line = view.state.doc.line(lineNo);
    if (allHavePrefix) {
      // Remove "- [ ] " or "- [x] "
      changes.push({ from: line.from, to: line.from + 6, insert: '' });
    } else if (!line.text.match(/^- \[[ x]\] /)) {
      // Add "- [ ] ", replacing existing "- " if present
      if (line.text.startsWith('- ')) {
        changes.push({ from: line.from, to: line.from + 2, insert: '- [ ] ' });
      } else {
        changes.push({ from: line.from, to: line.from, insert: '- [ ] ' });
      }
    }
  }
  if (changes.length) view.dispatch({ changes });
  return true;
}

export function insertLink(view: EditorView): boolean {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const insert = selected ? `[${selected}](url)` : '[text](url)';
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + 1, head: from + 1 + (selected || 'text').length },
  });
  return true;
}

export function insertImage(view: EditorView): boolean {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const insert = selected ? `![${selected}](url)` : '![alt](url)';
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + 2, head: from + 2 + (selected || 'alt').length },
  });
  return true;
}

export function insertCodeBlock(view: EditorView): boolean {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const insert = selected
    ? '```\n' + selected + '\n```'
    : '```\n\n```';
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: selected ? from + 4 : from + 4 },
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

/** Cmd+U → toggle unordered list (original MiaoYan behaviour) */
const unorderedListBinding: KeyBinding = {
  key: 'Mod-u',
  run(view) { return toggleUnorderedList(view); },
};

/** Cmd+Shift+O → toggle ordered list */
const orderedListBinding: KeyBinding = {
  key: 'Mod-Shift-o',
  run(view) { return toggleOrderedList(view); },
};

/** Cmd+T → toggle todo list */
const todoListBinding: KeyBinding = {
  key: 'Mod-t',
  run(view) { return toggleTodoList(view); },
};

const strikethroughBinding: KeyBinding = {
  key: 'Mod-Shift-x',
  run(view) { return wrapSelection(view, '~~', '~~'); },
};

const linkBinding: KeyBinding = {
  key: 'Mod-k',
  run(view) { return insertLink(view); },
};

const codeBlockBinding: KeyBinding = {
  key: 'Mod-Shift-c',
  run(view) { return insertCodeBlock(view); },
};

const inlineCodeBinding: KeyBinding = {
  key: 'Mod-e',
  run(view) { return wrapSelection(view, '`', '`'); },
};

export const textFormattingKeymap: KeyBinding[] = [
  boldBinding,
  italicBinding,
  unorderedListBinding,
  orderedListBinding,
  todoListBinding,
  strikethroughBinding,
  linkBinding,
  codeBlockBinding,
  inlineCodeBinding,
];
