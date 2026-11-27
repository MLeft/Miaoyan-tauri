import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTypeScriptLoader } from './helpers/load-typescript.mjs';

function bridge(invoke, confirm) {
  const events = [];
  const window = new EventTarget();
  window.addEventListener('document-recovery-required', event => events.push(event.detail));
  const load = createTypeScriptLoader({ invoke, confirm, window, setTimeout, clearTimeout });
  return { api: load(fileURLToPath(new URL('../src/services/tauri-bridge.ts', import.meta.url))), events };
}

test('annotation mutations carry the persistent identity captured by the read', async () => {
  const calls = [];
  const { api } = bridge(async (command, args) => {
    calls.push({ command, args });
    if (command === 'read_annotations') return { document_id: 'document-a', json: '[]' };
  });
  const snapshot = await api.readAnnotations('C:/notes/a.md');
  const version = snapshot.disk_version ?? '';
  await api.writeAnnotations('C:/notes/a.md', snapshot.document_id, '[{"id":"new"}]', version);
  await api.deleteAnnotations('C:/notes/a.md', snapshot.document_id, version);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].args)), { notePath: 'C:/notes/a.md', documentId: 'document-a', json: '[{"id":"new"}]', expectedVersion: version });
  assert.equal(calls[2].args.documentId, 'document-a');
  assert.equal(calls[2].args.expectedVersion, version);
});

test('encrypted annotation requests carry only the explicitly supplied password', async () => {
  const calls = [];
  const { api } = bridge(async (command, args) => { calls.push({ command, args }); return { document_id: 'document-a', json: '[]' }; });
  const path = 'C:/notes/a.md.encrypted';
  await api.readAnnotations(path, 'fixture-password');
  await api.writeAnnotations(path, 'document-a', '[]', 'v1', 'fixture-password');
  await api.deleteAnnotations(path, 'document-a', 'v1', 'fixture-password');
  for (const call of calls) assert.equal(call.args.password, 'fixture-password');
  await api.readAnnotations('C:/notes/plain.md');
  assert.equal(calls.at(-1).args.password, undefined);
});

test('encryption recovery failures notify the same document recovery layer', async () => {
  const failure = { code: 'RecoveryRequired', message: 'Finish metadata cleanup', paths: ['C:/notes/a.md'], recovery_id: 'encryption-a', warnings: [] };
  const { api, events } = bridge(async () => { throw failure; });
  await assert.rejects(api.encryptNote('C:/notes/a.md', 'fixture-password'), error => error.recoveryId === 'encryption-a');
  assert.equal(events.length, 1);
});

test('file moves request warning confirmation before retrying the same operation', async () => {
  const approvals = [], calls = [];
  const { api } = bridge(async (command, args) => {
    calls.push({ command, args });
    if (!args.allowWarnings) throw { code: 'ConfirmationRequired', message: 'Unverified attachment', paths: [], recovery_id: null, warnings: [{ message: 'Keep the source attachment' }] };
    return 'C:/target/a.md';
  }, async (message) => { approvals.push(message); return true; });
  assert.equal(await api.moveNote('C:/notes/a.md', 'C:/target'), 'C:/target/a.md');
  assert.equal(approvals.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.allowWarnings, false);
  assert.equal(calls[1].args.allowWarnings, true);
  assert.equal(calls[1].args.sourcePath, calls[0].args.sourcePath);
});

test('rejected warning confirmation does not retry or mutate files', async () => {
  let calls = 0;
  const { api } = bridge(async () => {
    calls++;
    throw { code: 'ConfirmationRequired', message: 'Confirm references', paths: [], recovery_id: null, warnings: [] };
  }, async () => false);
  await assert.rejects(api.renameNote('C:/notes/a.md', 'b'), error => error.code === 'Cancelled');
  assert.equal(calls, 1);
});

test('structured recovery failures retain their message and notify the document lock layer', async () => {
  const failure = { code: 'RecoveryRequired', message: 'Restore the retained original', paths: ['C:/notes/a.md'], recovery_id: 'transaction-a', warnings: [] };
  const { api, events } = bridge(async () => { throw failure; });
  await assert.rejects(api.renameNote('C:/notes/a.md', 'b'), error => error.name === 'DocumentOperationError' && error.message === failure.message && error.recoveryId === 'transaction-a');
  assert.equal(events.length, 1);
  assert.equal(events[0].paths[0], 'C:/notes/a.md');
});

test('encrypted version operations carry the password with their owning identity', async () => {
  const calls = [];
  const { api } = bridge(async (command, args) => { calls.push({ command, args }); return ''; });
  const path = 'C:/notes/a.md.encrypted', password = 'fixture-password';
  const version = { document_id: 'document-a', filename: 'version.md.encrypted', timestamp: 'now', size: 5 };
  await api.getVersion(path, version, password);
  await api.restoreVersion(path, version, password);
  await api.saveVersion(path, version.document_id, 'body', password);
  for (const call of calls) {
    assert.equal(call.args.password, password);
    assert.equal(call.args.documentId, version.document_id);
  }
});

test('version reads and restores use the identity of the selected version', async () => {
  const calls = [];
  const { api } = bridge(async (command, args) => { calls.push({ command, args }); return ''; });
  const version = { document_id: 'document-a', filename: 'version.md', timestamp: 'now', size: 5 };
  await api.getVersion('C:/notes/a.md', version);
  await api.restoreVersion('C:/notes/a.md', version);
  for (const { args } of calls) {
    assert.equal(args.documentId, 'document-a');
    assert.equal(args.versionFilename, 'version.md');
  }
});
