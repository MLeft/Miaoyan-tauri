import { EditorView, KeyBinding } from '@codemirror/view';
import { EditorState, Transaction } from '@codemirror/state';

const listPatterns = [
  { regex: /^(\s*)([-*+])\s(\[[ x]\]\s)?$/, type: 'unordered' },
  { regex: /^(\s*)([-*+])\s(\[[ x]\]\s)?(.+)$/, type: 'unordered-content' },
  { regex: /^(\s*)(\d+)\.\s(\[[ x]\]\s)?$/, type: 'ordered' },
  { regex: /^(\s*)(\d+)\.\s(\[[ x]\]\s)?(.+)$/, type: 'ordered-content' },
];

function getListContinuation(line: string): { continuation: string; isEmpty: boolean } | null {
  // Check unordered list with content: "- text" or "* text" or "- [ ] text"
  const unorderedContent = line.match(/^(\s*)([-*+])\s(\[[ x]\]\s)?(.+)$/);
  if (unorderedContent) {
    const [, indent, marker, checkbox] = unorderedContent;
    const cont = checkbox ? `${indent}${marker} [ ] ` : `${indent}${marker} `;
    return { continuation: cont, isEmpty: false };
  }

  // Check ordered list with content: "1. text"
  const orderedContent = line.match(/^(\s*)(\d+)\.\s(\[[ x]\]\s)?(.+)$/);
  if (orderedContent) {
    const [, indent, num, checkbox] = orderedContent;
    const nextNum = parseInt(num) + 1;
    const cont = checkbox ? `${indent}${nextNum}. [ ] ` : `${indent}${nextNum}. `;
    return { continuation: cont, isEmpty: false };
  }

  // Check empty unordered list item: "- " or "* " or "- [ ] "
  const unorderedEmpty = line.match(/^(\s*)([-*+])\s(\[[ x]\]\s)?$/);
  if (unorderedEmpty) {
    return { continuation: '', isEmpty: true };
  }

  // Check empty ordered list item: "1. " or "2. [ ] "
  const orderedEmpty = line.match(/^(\s*)(\d+)\.\s(\[[ x]\]\s)?$/);
  if (orderedEmpty) {
    return { continuation: '', isEmpty: true };
  }

  return null;
}

const smartListEnter: KeyBinding = {
  key: 'Enter',
  run(view: EditorView): boolean {
    const state = view.state;
    const { from, to } = state.selection.main;

    // Only handle when cursor is at end of line (no selection)
    if (from !== to) return false;

    const line = state.doc.lineAt(from);
    const lineText = line.text;

    // Check if cursor is at the end of the line
    if (from !== line.to) return false;

    const result = getListContinuation(lineText);
    if (!result) return false;

    if (result.isEmpty) {
      // Empty list item: remove the marker and outdent
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: '' },
      });
      return true;
    }

    // Insert new line with continuation
    view.dispatch({
      changes: { from, to: from, insert: '\n' + result.continuation },
      selection: { anchor: from + 1 + result.continuation.length },
    });
    return true;
  },
};

export function smartLists() {
  return EditorView.domEventHandlers({});
}

export const smartListKeymap: KeyBinding[] = [smartListEnter];
