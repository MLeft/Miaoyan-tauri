import React from 'react';
import { createRoot } from 'react-dom/client';
import { useNotesStore } from '../src/stores/notes-store';
import { until } from './pdf-lifecycle.browser.mjs';
import '../src/i18n';
import '../src/styles/globals.css';

let fixture;
export async function openRecoveryFixture() {
  const { RecoveryBanner } = await import('../src/components/shared/RecoveryBanner');
  const previous = window.__TAURI_INTERNALS__;
  const pending = [{ transaction_id: 'fixture-recovery', kind: 'relocate', paths: ['C:/recovery-fixture/a.md'], committed: false }];
  fixture = { previous, pending, attempts: 0, fail: true };
  window.__TAURI_INTERNALS__ = { ...previous, async invoke(command, args) {
    if (command === 'read_note') return { id: args.path, content: 'preserved document', disk_version: 'preserved document' };
    if (command === 'get_document_recoveries') return fixture.pending;
    if (command === 'retry_document_recovery') {
      fixture.attempts++;
      if (fixture.fail) throw { code: 'RecoveryRequired', message: 'fixture recovery failure', paths: pending[0].paths, recovery_id: 'fixture-recovery', warnings: [] };
      fixture.pending = [];
      return;
    }
    if (command === 'write_log' || command === 'write_logs') return;
    throw new Error(`Unexpected command: ${command}`);
  } };
  await useNotesStore.getState().openTemporaryFile('C:/recovery-fixture/a.md');
  fixture.mount = document.createElement('div');
  document.body.append(fixture.mount);
  fixture.root = createRoot(fixture.mount);
  fixture.root.render(React.createElement(RecoveryBanner));
  await until(() => fixture.mount.querySelector('button'), 'Recovery retry action was not shown');
  if (!useNotesStore.getState().activeDocumentReadOnly) throw new Error('Pending recovery did not seal the editor');
  return recoveryRetryPoint();
}

export function recoveryRetryPoint() {
  const button = fixture.mount.querySelector('button');
  const rect = button.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export async function verifyRecoveryFailure() {
  await until(() => fixture.mount.textContent.includes('fixture recovery failure'), 'Recovery failure was hidden');
  if (!useNotesStore.getState().activeDocumentReadOnly) throw new Error('Failed recovery unlocked the document');
  fixture.fail = false;
  return recoveryRetryPoint();
}

export async function verifyRecoverySuccess() {
  await until(() => !fixture.mount.querySelector('button'), 'Completed recovery did not leave the recovery state');
  if (useNotesStore.getState().activeDocumentReadOnly || fixture.attempts !== 2) throw new Error('Recovery did not unlock only after success');
  return { passed: true, failedRecoveryStayedLocked: true, successfulRecoveryUnlocked: true };
}

export async function cleanupRecoveryFixture() {
  fixture?.root?.unmount();
  fixture?.mount?.remove();
  useNotesStore.getState().setRecoveryPaths([]);
  await useNotesStore.getState().closeAllTabs();
  if (fixture?.previous === undefined) delete window.__TAURI_INTERNALS__;
  else window.__TAURI_INTERNALS__ = fixture.previous;
  fixture = null;
}
