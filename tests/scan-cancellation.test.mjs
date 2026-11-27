import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createTypeScriptLoader } from './helpers/load-typescript.mjs';
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function harness({ delayedSession = false, delayedCancel = false } = {}) {
  const jobs = [], controls = [], cancellations = [];
  let openSession;
  const session = delayedSession ? new Promise(resolve => { openSession = resolve; }) : Promise.resolve('fixture-session');
  const load = createTypeScriptLoader({ window: new EventTarget(), setTimeout, clearTimeout,
    invoke: (command, args = {}) => {
      if (command === 'start_scan_session') return session;
      if (command === 'release_scan_lane') { controls.push({ command, ...args }); return Promise.resolve(); }
      if (command === 'invalidate_scan') {
        controls.push({ command, ...args });
        const cancel = () => { for (const job of jobs) if (!job.done && job.args.lane === args.lane && job.args.generation < args.generation) { job.done = true; job.reject(new Error('Scan canceled')); } };
        if (delayedCancel) return new Promise(resolve => cancellations.push(() => { cancel(); resolve(); }));
        cancel(); return Promise.resolve();
      }
      return new Promise((resolve, reject) => jobs.push({ command, args, resolve, reject, done: false }));
    },
  });
  const bridge = load(fileURLToPath(new URL('../src/services/tauri-bridge.ts', import.meta.url)));
  return { bridge, jobs, controls, cancellations, open: () => openSession?.('fixture-session'),
    finish: () => jobs.forEach(job => { if (!job.done) { job.done = true; job.resolve([]); } }),
  };
}

const A = 'C:/library-A', B = 'C:/library-B', E = 'C:/extra-E', F = 'C:/extra-F';

test('switching roots requests native cancellation and releases the retired channel', async () => {
  const h = harness();
  try {
    h.bridge.setScanRoots(A, []); const old = h.bridge.getAllNotes(A, []); void old.catch(() => {});
    await tick(); const running = h.jobs[0];
    h.bridge.setScanRoots(B, []); await tick();
    const cancel = h.controls.find(control => control.command === 'invalidate_scan');
    assert.ok(cancel, 'Root switch must cancel native work, not only hide its result');
    assert.equal(cancel.lane, running.args.lane);
    assert.ok(cancel.generation > running.args.generation);
    await assert.rejects(old, /canceled/); await tick();
    assert.ok(h.controls.some(control => control.command === 'release_scan_lane'));
  } finally { h.finish(); }
});

test('removing one import cancels only its channel and leaves projects and other imports running', async () => {
  const h = harness();
  try {
    h.bridge.setScanRoots(A, [E, F]);
    const removed = h.bridge.scanFolder(E); void removed.catch(() => {});
    const retained = h.bridge.scanFolder(F), projects = h.bridge.getProjects(A, [E, F]);
    await tick();
    h.bridge.setScanRoots(A, [F]); await tick();
    assert.ok(h.controls.some(control => control.command === 'invalidate_scan'), 'Removed import must request cancellation');
    await assert.rejects(removed, /canceled/);
    assert.equal(h.jobs.find(job => job.args.folder === F).done, false);
    assert.equal(h.jobs.find(job => job.command === 'get_projects').done, false);
    h.finish(); await Promise.all([retained, projects]);
  } finally { h.finish(); }
});

test('retired work cannot start after a delayed native session initialization', async () => {
  const h = harness({ delayedSession: true });
  try {
    h.bridge.setScanRoots(A, []); const old = h.bridge.getAllNotes(A, []); void old.catch(() => {});
    h.bridge.setScanRoots(B, []); const fresh = h.bridge.getAllNotes(B, []);
    h.open(); await tick();
    assert.equal(h.jobs.some(job => job.args.rootPath === A), false, 'Obsolete work started after session setup');
    assert.equal(h.jobs.filter(job => job.args.rootPath === B).length, 1);
    await assert.rejects(old, /canceled/); h.finish(); await fresh;
  } finally { h.open(); h.finish(); }
});

test('a late cancellation cannot cancel the replacement or release its barrier while old work is pending', async () => {
  const h = harness({ delayedCancel: true });
  try {
    h.bridge.setScanRoots(A, []); const old = h.bridge.getAllNotes(A, []); void old.catch(() => {});
    await tick();
    const fresh = h.bridge.getAllNotes(A, [E]); await tick();
    assert.equal(h.cancellations.length, 1, 'Replacement must cancel the previous scan');
    const replacement = h.jobs.at(-1);
    replacement.done = true; replacement.resolve([]); await fresh; await tick();
    assert.equal(h.controls.some(control => control.command === 'release_scan_lane'), false, 'Channel barrier was forgotten while an old invocation was pending');
    h.cancellations[0](); await assert.rejects(old, /canceled/); await tick();
    assert.ok(h.controls.some(control => control.command === 'release_scan_lane'));
  } finally { for (const cancel of h.cancellations) cancel(); h.finish(); }
});
