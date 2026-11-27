import React from 'react';
import { createRoot } from 'react-dom/client';
import { useNotesStore } from '../src/stores/notes-store';
import { useSettingsStore } from '../src/stores/settings-store';

const source = 'C:/save-recovery/a.md', target = 'C:/save-recovery/recovered.md';
const until = async (predicate, message) => {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(requestAnimationFrame);
  }
  throw new Error(message + JSON.stringify({ calls: window.__saveRecoveryFixture?.calls.filter(call => call.command.startsWith('plugin:dialog')), alert: window.__saveRecoveryFixture?.mount.textContent }));
};

export async function openSaveRecoveryFixture() {
  const { SaveFailureBanner } = await import('../src/components/shared/SaveFailureBanner');
  const previous = window.__TAURI_INTERNALS__, previousConfig = useSettingsStore.getState().config;
  const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  const disk = new Map([[source, 'original']]), calls = [];
  let fail = true, selection = null, approve = false;
  window.__TAURI_INTERNALS__ = { ...previous, async invoke(command, args) {
    calls.push({ command, args });
    if (command === 'read_note') return { id: args.path, content: disk.get(args.path), disk_version: disk.get(args.path) };
    if (command === 'write_note') {
      if (fail) throw new Error('synthetic disk full');
      if (args.expectedVersion !== disk.get(args.path)) throw { code: 'DiskConflict', message: 'External disk change', paths: [args.path] };
      disk.set(args.path, args.content); return args.content;
    }
    if (command === 'save_document_copy') {
      if (disk.has(args.targetPath)) throw new Error('Target occupied');
      disk.set(args.targetPath, args.content); return { id: args.targetPath, content: args.content, disk_version: args.content };
    }
    if (command === 'plugin:dialog|save') return selection;
    if (command === 'plugin:dialog|message') return approve ? (args.buttons?.OkCancelCustom?.[0] ?? 'Ok') : (args.buttons?.OkCancelCustom?.[1] ?? 'Cancel');
    if (['write_log', 'write_logs'].includes(command)) return;
    throw new Error(command);
  } };
  useSettingsStore.setState({ config: { ...previousConfig, auto_save_interval: 0, language: 'en' } });
  await useNotesStore.getState().openTemporaryFile(source);
  useNotesStore.getState().updateContent('retry draft', '');
  await useNotesStore.getState().saveCurrentNote();
  const mount = document.createElement('div'); document.body.append(mount);
  const root = createRoot(mount); root.render(React.createElement(SaveFailureBanner));
  window.__saveRecoveryFixture = {
    mount, disk, calls, setSelection: value => { selection = value; }, setApprove: value => { approve = value; },
    async cleanup() {
      root.unmount(); mount.remove();
      for (const tab of [...useNotesStore.getState().openTabs]) {
        const snapshot = useNotesStore.getState().getDocumentSession(tab.path);
        useNotesStore.getState().discardDocument(tab.path, snapshot.identity);
      }
      useSettingsStore.setState({ config: previousConfig }); window.__TAURI_INTERNALS__ = previous;
      globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
      delete window.__saveRecoveryFixture;
    },
    allowWrite() { fail = false; },
  };
  await until(() => mount.querySelector('[role=alert]'), 'Failed save has no recovery actions');
  fail = false;
}

export function saveRecoveryPoint(label) {
  const button = [...window.__saveRecoveryFixture.mount.querySelectorAll('button')].find(button => button.textContent === label);
  if (!button || button.disabled) throw new Error(`Recovery action missing: ${label}`);
  const rect = button.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

export async function verifyRetryAndCreateConflict() {
  const f = window.__saveRecoveryFixture;
  await until(() => f.disk.get(source) === 'retry draft' && !f.mount.querySelector('[role=alert]'), 'Retry did not save or clear the error');
  useNotesStore.getState().updateContent('conflict draft', '');
  f.disk.set(source, 'external version');
  await useNotesStore.getState().saveCurrentNote();
  await until(() => f.mount.querySelector('[role=alert]'), 'Disk conflict has no recovery actions');
}

export async function verifyCancelledSaveAs() {
  const f = window.__saveRecoveryFixture;
  await until(() => !f.mount.querySelector('button:disabled'), 'Cancelled save-as left controls disabled');
  if (f.calls.some(call => call.command === 'save_document_copy')) throw new Error('Cancelled save-as wrote a file');
  if (f.disk.get(source) !== 'external version') throw new Error('External version was overwritten');
  f.setSelection(target);
}

export async function verifySavedCopy() {
  const f = window.__saveRecoveryFixture;
  await until(() => f.disk.get(target) === 'conflict draft', 'Draft copy was not saved');
  await useNotesStore.getState().switchTab(source);
  await until(() => f.mount.querySelector('[role=alert]') && !f.mount.querySelector('button:disabled'), 'Original draft error was lost');
  if (!useNotesStore.getState().getDocumentSession(source).isDirty || f.disk.get(source) !== 'external version') throw new Error('Saving a copy cleared or overwrote the original');
}

export async function verifyCancelledDiscard() {
  const f = window.__saveRecoveryFixture;
  await until(() => !f.mount.querySelector('button:disabled'), 'Discard confirmation did not finish');
  if (!useNotesStore.getState().getDocumentSession(source)) throw new Error('Cancelled discard lost the draft');
  f.setApprove(true);
}

export async function verifyDiscard() {
  const f = window.__saveRecoveryFixture;
  await until(() => !useNotesStore.getState().getDocumentSession(source), 'Confirmed discard did not close the draft');
  const writes = f.calls.filter(call => call.command === 'write_note').length;
  await useNotesStore.getState().openTemporaryFile(source);
  if (useNotesStore.getState().activeContent !== 'external version') throw new Error('Discard did not preserve the disk version');
  if (f.calls.filter(call => call.command === 'write_note').length !== writes) throw new Error('Discard issued an unexpected save');
  return { passed: true, explicitRetry: true, diskConflictKeptDraft: true, saveAsCancellation: true, copyKeepsOriginal: true, discardConfirmation: true };
}
