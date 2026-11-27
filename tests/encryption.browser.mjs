import React from 'react';
import { createRoot } from 'react-dom/client';
import { EncryptionDialog } from '../src/components/shared/EncryptionDialog';
import { openPreviewFixture } from './preview.browser.mjs';
import { useNotesStore } from '../src/stores/notes-store';

const password = 'fixture-password';
const until = async (predicate, message) => {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(requestAnimationFrame);
  }
  throw new Error(message);
};

export async function openEncryptionFixture() {
  const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  await openPreviewFixture();
  const preview = window.__previewFixture;
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  await preview.edit('accepted body');
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const calls = [];
  let finish, closed = false;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    calls.push({ command, args });
    if (command === 'encrypt_note' || command === 'remove_encryption') {
      if (args.password !== password) throw new Error('Invalid password or corrupted data');
      await new Promise(resolve => { finish = resolve; });
      const id = command === 'encrypt_note' ? (args.path.endsWith('.encrypted') ? args.path : args.path + '.encrypted') : args.path.slice(0, -'.encrypted'.length);
      return { id, content: 'accepted body', disk_version: 'accepted body' };
    }
    if (command === 'decrypt_note') {
      if (args.password !== password) throw new Error('Invalid password or corrupted data');
      return { id: args.path, content: 'accepted body', disk_version: 'accepted body' };
    }
    if (command === 'read_annotations' && args.notePath.endsWith('.encrypted') && args.password !== password) throw new Error('Encrypted annotations require password');
    if (command === 'save_encrypted_note') {
      if (args.password !== password) throw new Error('Wrong encrypted save password');
      return args.content;
    }
    return invoke(command, args);
  };
  const mount = document.createElement('div'); document.body.append(mount);
  const root = createRoot(mount);
  function DialogHost() {
    const dialog = useNotesStore(state => state.encryptionDialog);
    return dialog ? React.createElement(EncryptionDialog, {
      ...dialog,
      onClose() { closed = true; preview.store().setEncryptionDialog(null); },
      onUnlocked(...args) { const accepted = preview.store().onNoteUnlocked(...args); if (accepted) closed = true; return accepted; },
    }) : null;
  }
  const render = mode => {
    closed = false;
    preview.store().setEncryptionDialog({ mode, notePath: preview.store().activeNote.path, visible: true });
    root.render(React.createElement(DialogHost));
  };
  render('encrypt');
  window.__encryptionFixture = {
    calls, mount, render, release: () => { finish?.(); finish = undefined; }, closed: () => closed, pending: () => typeof finish === 'function',
    async beginUnlock() {
      closed = false;
      const path = preview.store().activeTabPath;
      await preview.store().closeTab(path);
      await preview.store().openTemporaryFile(path);
      root.render(React.createElement(DialogHost));
    },
    async cleanup() {
      finish?.();
      await new Promise(resolve => setTimeout(resolve, 0));
      root.unmount(); mount.remove();
      await preview.cleanup();
      globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
      delete window.__encryptionFixture;
    },
  };
  await until(() => mount.querySelectorAll('input').length === 2, 'Encryption dialog missing');
  const confirmation = mount.querySelectorAll('input')[1];
  confirmation.focus();
  await new Promise(resolve => setTimeout(resolve, 80));
  if (document.activeElement !== confirmation) throw new Error('Delayed autofocus stole the confirmation field focus');
  mount.querySelector('input').focus();
}

export function verifyCompositionDidNotEncrypt() {
  if (window.__encryptionFixture.calls.some(call => call.command === 'encrypt_note')) throw new Error('IME confirmation started encryption');
}

export async function verifyEncryptionWaiting() {
  const f = window.__encryptionFixture;
  await until(() => f.calls.some(call => call.command === 'encrypt_note'), 'Encryption did not start');
  if (!f.calls.some(call => call.command === 'write_note' && call.args.content === 'accepted body')) throw new Error('Encryption started before saving the draft');
}

export async function verifyEncrypted() {
  const f = window.__encryptionFixture;
  if (f.closed()) throw new Error('Cancel dismissed an accepted encryption task');
  f.release();
  await until(() => f.closed(), 'Encryption dialog did not close after success');
  if (!window.__previewFixture.store().activeTabPath.endsWith('.encrypted')) throw new Error('Encryption did not migrate the open session');
  await until(() => f.calls.some(call => call.command === 'read_annotations' && call.args.notePath.endsWith('.encrypted') && call.args.password === password), 'Encrypted preview did not supply its document password');
  await f.beginUnlock();
  await until(() => f.mount.querySelectorAll('input').length === 1 && !f.mount.querySelector('input').disabled, 'Unlock dialog missing');
  f.mount.querySelector('input').focus();
}

export async function verifyUnlocked() {
  const f = window.__encryptionFixture;
  await until(() => f.pending() && f.calls.some(call => call.command === 'encrypt_note' && call.args.path.endsWith('.encrypted')), 'Unlock did not protect legacy metadata');
  f.release();
  await until(() => f.closed(), 'Unlock did not complete');
  if (window.__previewFixture.store().activeContent !== 'accepted body') throw new Error('Unlocked document content was lost');
  f.render('remove');
  await until(() => f.mount.querySelectorAll('input').length === 1 && !f.mount.querySelector('input').disabled && window.__previewFixture.store().encryptionDialog.mode === 'remove', 'Remove encryption dialog missing');
  f.mount.querySelector('input').focus();
}

export async function verifyWrongPassword() {
  const f = window.__encryptionFixture;
  await until(() => f.mount.querySelector('[role=alert]'), 'Wrong password was not visible');
  if (f.closed() || !window.__previewFixture.store().activeTabPath.endsWith('.encrypted')) throw new Error('Wrong password changed or closed the document');
  f.mount.querySelector('input').select();
}

export async function verifyDecrypted() {
  const f = window.__encryptionFixture;
  await until(() => f.pending() && f.calls.some(call => call.command === 'remove_encryption' && call.args.password === password), 'Removal did not start');
  f.release();
  await until(() => f.closed(), 'Removal dialog did not close');
  if (window.__previewFixture.store().activeTabPath.endsWith('.encrypted')) throw new Error('Removal did not migrate the session back');
  return { passed: true, compositionIgnored: true, draftDrainedBeforeEncryption: true, pendingCancelBlocked: true, encryptedPreviewAuthorized: true, unlockMigration: true, wrongPasswordPreserved: true, roundTripSession: true };
}
