import { ChangeSet, Compartment, EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { history, historyField } from '@codemirror/commands';
import { useNotesStore } from '../../stores/notes-store';

type ViewSnapshot = {
  doc: EditorState['doc'];
  selection: EditorState['selection'];
  history: unknown;
  scroll: ReturnType<EditorView['scrollSnapshot']>;
};

// Only immutable view data, never a View, EditorState or its old path/revision closures.
const snapshots = new Map<number, ViewSnapshot>();
const openIdentities = () => {
  const store = useNotesStore.getState();
  return new Set(store.openTabs.map(tab => store.getDocumentSession(tab.path)!.identity));
};
let liveIdentities = openIdentities();

// Sessions are added/removed with tab insertion/removal; rename/reorder preserves identity.
// Keep this subscription outside React so closing in preview also releases snapshots.
// Dirty/save/mode publications and every keystroke take only this O(1) length check.
useNotesStore.subscribe((next, previous) => {
  if (next.openTabs.length === previous.openTabs.length) return;
  liveIdentities = openIdentities();
  for (const identity of snapshots.keys()) {
    if (!liveIdentities.has(identity)) snapshots.delete(identity);
  }
});

export function saveEditorViewState(identity: number | null, view: EditorView) {
  // Close may publish before React disposes the active view. Do not resurrect it.
  if (identity === null || !liveIdentities.has(identity)) return;
  snapshots.set(identity, {
    doc: view.state.doc,
    selection: view.state.selection,
    history: view.state.field(historyField),
    scroll: view.scrollSnapshot(),
  });
}

export function restoreEditorViewState(identity: number | null, state: EditorState, compartment: Compartment): {
  state: EditorState;
  scrollTo?: ReturnType<EditorView['scrollSnapshot']>;
} {
  const snapshot = identity === null ? undefined : snapshots.get(identity);
  if (!snapshot) return { state };
  snapshots.delete(identity!); // The mounted view now owns this data.

  const clip = ChangeSet.of(state.doc.length < snapshot.doc.length
    ? { from: state.doc.length, to: snapshot.doc.length } : [], snapshot.doc.length);
  const selection = snapshot.selection.map(clip);
  const scrollTo = snapshot.scroll.map(clip);
  if (!snapshot.doc.eq(state.doc)) return { state: state.update({ selection }).state, scrollTo };

  // Reinitialize only the public history field in the freshly guarded state.
  // Removing it first is required: reconfiguration otherwise retains the old field value.
  const savedHistory = snapshot.history;
  const fresh = state.update({ effects: compartment.reconfigure([]) }).state;
  return {
    state: fresh.update({ selection, effects: compartment.reconfigure([
      history(), historyField.init(() => savedHistory),
    ]) }).state,
    scrollTo,
  };
}
