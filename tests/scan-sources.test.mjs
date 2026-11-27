import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createTypeScriptLoader } from './helpers/load-typescript.mjs';
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function harness() {
  const calls = [];
  const load = createTypeScriptLoader({ window: new EventTarget(), setTimeout, clearTimeout,
    invoke: (command, args) => {
      if (command === 'start_scan_session') return Promise.resolve('fixture-session');
      if (['invalidate_scan', 'release_scan_lane'].includes(command)) return Promise.resolve();
      return new Promise(resolve => calls.push({ command, args, resolve }));
    },
  });
  const bridge = load(fileURLToPath(new URL('../src/services/tauri-bridge.ts', import.meta.url)));
  return { bridge, calls, keep: promise => { void promise.catch(() => {}); return promise; }, finish: () => calls.forEach(call => call.resolve([])) };
}

const A = 'C:/library-A', B = 'C:/library-B', E = 'C:/extra';

test('each scan sends an owner ID and identical concurrent requests share that operation', async () => {
  const h = harness();
  try {
    const first = h.keep(h.bridge.getAllNotes(A, [])), duplicate = h.keep(h.bridge.getAllNotes('c:\\LIBRARY-A', []));
    assert.equal(first, duplicate);
    await tick();
    assert.equal(h.calls.length, 1);
    assert.equal(typeof h.calls[0].args.scanId, 'string');
    assert.ok(h.calls[0].args.scanId.length > 0);
    assert.equal(h.bridge.getScanId(first), h.calls[0].args.scanId);
    h.keep(h.bridge.getProjects(A, [])); await tick();
    assert.notEqual(h.calls[1].args.scanId, h.calls[0].args.scanId);
  } finally { h.finish(); }
});

test('POSIX case and separator-containing arguments do not collide in scan deduplication', async () => {
  const h = harness();
  try {
    const upper = h.keep(h.bridge.getAllNotes('/Library', [])), lower = h.keep(h.bridge.getAllNotes('/library', []));
    assert.notEqual(upper, lower);
    const single = h.keep(h.bridge.getProjects('/a', ['/b|/c'])), multiple = h.keep(h.bridge.getProjects('/a', ['/b', '/c']));
    assert.notEqual(single, multiple);
    await tick();
    assert.equal(h.calls.find(call => call.command === 'get_all_notes').args.rootPath, '/library');
    assert.deepEqual(Array.from(h.calls.find(call => call.command === 'get_projects').args.extraFolders), ['/b', '/c']);
  } finally { h.finish(); }
});

test('main-root A/B/A commits invalidate old owner IDs and do not reuse an old A scan', async () => {
  const h = harness();
  try {
    h.bridge.setScanRoots(A, []); h.keep(h.bridge.getAllNotes(A, [])); await tick();
    const old = h.calls[0].args.scanId;
    h.bridge.setScanRoots(B, []); h.bridge.setScanRoots(A, []);
    assert.equal(h.bridge.isCurrentScan(old, 'notes', A, []), false);
    h.keep(h.bridge.getAllNotes(A, [])); await tick();
    assert.equal(h.calls.length, 2);
    const fresh = h.calls[1].args.scanId;
    assert.notEqual(fresh, old);
    assert.equal(h.bridge.isCurrentScan(fresh, 'notes', A, []), true);
    assert.equal(h.bridge.isCurrentScan(fresh, 'projects', A, []), false);
    assert.equal(h.bridge.isCurrentScan('unknown', 'notes', A, []), false);
  } finally { h.finish(); }
});

test('independent folder imports remain isolated and removed roots lose their source', async () => {
  const h = harness(), F = 'C:/second-extra';
  try {
    h.bridge.setScanRoots(A, [E, F]);
    h.keep(h.bridge.scanFolder(E)); h.keep(h.bridge.scanFolder(F)); await tick();
    const first = h.calls[0].args.scanId, second = h.calls[1].args.scanId;
    assert.notEqual(first, second);
    assert.equal(h.bridge.isCurrentScan(first, 'notes', A, [E, F]), true);
    assert.equal(h.bridge.isCurrentScan(second, 'notes', A, [E, F]), true);
    h.bridge.setScanRoots(A, [F]);
    assert.equal(h.bridge.isCurrentScan(first, 'notes', A, [F]), false);
    assert.equal(h.bridge.isCurrentScan(second, 'notes', A, [F]), true);
  } finally { h.finish(); }
});

test('a newer full scan supersedes older import data without stealing its progress', async () => {
  const h = harness();
  try {
    h.bridge.setScanRoots(A, [E]); h.keep(h.bridge.scanFolder(E)); await tick();
    const importId = h.calls[0].args.scanId;
    h.keep(h.bridge.getAllNotes(A, [E])); await tick();
    const fullId = h.calls[1].args.scanId;
    assert.equal(h.bridge.isCurrentScan(importId, 'notes', A, [E]), false);
    assert.equal(h.bridge.isCurrentScan(importId, 'progress', A, [E]), true);
    assert.equal(h.bridge.isCurrentScan(fullId, 'notes', A, [E]), true);
    h.keep(h.bridge.scanFolder(E)); await tick();
    const freshImport = h.calls[2].args.scanId;
    assert.equal(h.bridge.isCurrentScan(freshImport, 'notes', A, [E]), true);
    assert.equal(h.bridge.isCurrentScan(importId, 'progress', A, [E]), false);
  } finally { h.finish(); }
});

test('changing extras preserves an in-flight main scan while its result is clipped to current roots', async () => {
  const h = harness();
  try {
    h.bridge.setScanRoots(A, [E]); h.keep(h.bridge.getAllNotes(A, [E])); await tick();
    const source = h.calls[0].args.scanId;
    h.bridge.setScanRoots(A, []);
    assert.equal(h.bridge.isCurrentScan(source, 'notes', A, []), true);
    assert.equal(h.bridge.isCurrentScan(source, 'notes', B, []), false);
  } finally { h.finish(); }
});
