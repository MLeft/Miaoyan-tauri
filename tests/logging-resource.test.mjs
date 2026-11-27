import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTypeScriptLoader } from './helpers/load-typescript.mjs';

const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function harness(t, transport = async () => {}) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  let now = 0, id = 0;
  const timers = new Map();
  const calls = [];
  const load = createTypeScriptLoader({
    invoke: (command, args) => {
      calls.push({ command, args: JSON.parse(JSON.stringify(args)) });
      return transport(command, args);
    },
    setTimeout: (fn, ms) => { timers.set(++id, { fn, at: now + ms }); return id; },
    clearTimeout: (key) => timers.delete(key),
    window: { dispatchEvent() {} },
  });
  const source = (path) => load(fileURLToPath(new URL(`../src/${path}`, import.meta.url)));
  const { useSettingsStore: store } = source('stores/settings-store.ts');
  const logger = source('services/logger.ts');
  const perf = source('services/perf.ts');
  const enable = (debug_log) => store.setState({ config: { ...store.getState().config, debug_log } });
  return {
    logger, perf, enable, calls, timers,
    async advance(ms) {
      now += ms;
      for (const [key, timer] of [...timers]) {
        if (timer.at <= now && timers.delete(key)) timer.fn();
      }
      await tick();
    },
  };
}

test('ordinary and perf logs share one IPC after three seconds', async (t) => {
  const h = harness(t);
  h.enable(true);
  void h.logger.log('first');
  void h.logger.log('second');
  h.perf.perfReport('slow', 123);
  assert.equal(h.calls.length, 0, 'enqueue must not write individual messages');
  await h.advance(2999);
  assert.equal(h.calls.length, 0);
  await h.advance(1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].command, 'write_logs');
  assert.deepEqual(h.calls[0].args.messages.slice(0, 2), ['first', 'second']);
  assert.match(h.calls[0].args.messages[2], /^\[perf\] .* slow 123\.0ms$/);
  assert.equal(h.timers.size, 0, 'idle logger must not poll');
});

test('threshold flush uses one IPC rather than fifty writes', async (t) => {
  const h = harness(t);
  h.enable(true);
  for (let i = 0; i < 50; i++) void h.logger.log(`line-${i}`);
  await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].command, 'write_logs');
  assert.equal(h.calls[0].args.messages.length, 50);
  assert.equal(h.timers.size, 0);
});

test('concurrent flushes join in-flight work and drain new arrivals', async (t) => {
  const gate = deferred();
  const h = harness(t, () => h.calls.length === 1 ? gate.promise : Promise.resolve());
  h.enable(true);
  void h.logger.log('first');
  assert.equal(typeof h.logger.flushLogs, 'function', 'exit flush API is required');
  const first = h.logger.flushLogs();
  await tick();
  void h.logger.log('arrived-during-IPC');
  const second = h.logger.flushLogs();
  await tick();
  assert.equal(h.calls.length, 1);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(h.calls.map((c) => c.args.messages), [['first'], ['arrived-during-IPC']]);
  assert.equal(h.logger.getLogStats().pending, 0);
  assert.equal(h.timers.size, 0);
});

test('messages arriving in settlement microtasks are scheduled rather than stranded', async (t) => {
  // Cross-realm promise adoption adds microtasks in the source loader. Exercise
  // each boundary around transport settlement, not just the in-flight period.
  for (let steps = 1; steps <= 8; steps++) {
    const h = harness(t);
    h.enable(true);
    void h.logger.log('first');
    const flushing = h.logger.flushLogs();
    for (let i = 0; i < steps; i++) await Promise.resolve();
    void h.logger.log('settlement-arrival');
    await flushing;
    await h.advance(3000);
    assert.deepEqual(h.calls.map((c) => c.args.messages), [['first'], ['settlement-arrival']], `microtask ${steps}`);
    assert.equal(h.logger.getLogStats().pending, 0);
  }
});

test('overflow bounds pending plus in-flight at 100 and exposes dropped count', async (t) => {
  const gate = deferred();
  const h = harness(t, () => h.calls.length === 1 ? gate.promise : Promise.resolve());
  h.enable(true);
  for (let i = 0; i < 200; i++) void h.logger.log(`line-${i}`);
  await tick();
  assert.equal(typeof h.logger.getLogStats, 'function', 'overflow must be observable');
  const stats = h.logger.getLogStats();
  assert.equal(stats.pending + stats.inFlight, 100);
  assert.equal(stats.dropped, 100);
  assert.equal(h.calls.length, 1);
  gate.resolve();
  await h.logger.flushLogs();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].args.messages[0], 'line-150');
  assert.equal(h.calls[1].args.messages.at(-1), 'line-199');
});

test('disabled logs retain console behavior but never queue perf or ordinary writes', async (t) => {
  const h = harness(t);
  void h.logger.log('disabled');
  h.perf.perfReport('slow', 90);
  await h.advance(3000);
  assert.equal(h.calls.length, 0);
  assert.equal(console.log.mock.callCount(), 1);
  assert.equal(console.warn.mock.callCount(), 1);
  h.enable(true);
  void h.logger.log('discard-on-disable');
  h.enable(false);
  assert.equal(h.timers.size, 0);
  h.enable(true);
  await h.logger.flushLogs();
  assert.equal(h.calls.length, 0, 're-enable must not resurrect cleared logs');
});

test('failed batches wait for new messages, then recover without recursive logging', async (t) => {
  let fail = true;
  const h = harness(t, async () => { if (fail) throw new Error('disk full'); });
  h.enable(true);
  void h.logger.log('retry-me');
  await h.advance(3000);
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 0, 'failure must disarm automatic retry');
  await h.advance(30000);
  assert.equal(h.calls.length, 1);
  fail = false;
  void h.logger.log('new-message');
  await h.advance(3000);
  assert.deepEqual(h.calls.map((c) => c.args.messages), [['retry-me'], ['retry-me', 'new-message']]);
  assert.equal(h.logger.getLogStats().failedBatches, 1);
  assert.equal(h.logger.getLogStats().pending, 0);
});

test('explicit flush never rejects on transport failure and can retry once requested', async (t) => {
  let fail = true;
  const h = harness(t, () => { if (fail) throw new Error('sync transport failure'); return Promise.resolve(); });
  h.enable(true);
  void h.logger.log('retry-explicitly');
  assert.equal(typeof h.logger.flushLogs, 'function');
  await assert.doesNotReject(h.logger.flushLogs());
  assert.equal(h.calls.length, 1);
  fail = false;
  await h.logger.flushLogs();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].args.messages, ['retry-explicitly']);
});

test('disable during IPC prevents failed old-generation messages from returning', async (t) => {
  const gate = deferred();
  const h = harness(t, () => h.calls.length === 1 ? gate.promise : Promise.resolve());
  h.enable(true);
  void h.logger.log('old');
  assert.equal(typeof h.logger.flushLogs, 'function');
  const flushing = h.logger.flushLogs();
  await tick();
  void h.logger.log('also-old');
  h.enable(false);
  h.enable(true);
  void h.logger.log('new-generation');
  gate.reject(new Error('old IPC failed'));
  await flushing;
  await h.logger.flushLogs();
  assert.deepEqual(h.calls.map((c) => c.args.messages), [['old'], ['new-generation']]);
});

test('oversized messages are discarded before transport with a visible counter', async (t) => {
  const h = harness(t);
  h.enable(true);
  void h.logger.log('x'.repeat(2049));
  assert.equal(typeof h.logger.getLogStats, 'function');
  assert.equal(h.logger.getLogStats().dropped, 1);
  await h.logger.flushLogs();
  assert.equal(h.calls.length, 0);
  assert.equal(h.timers.size, 0);
});

test('a stalled IPC cannot block exit indefinitely or permit overlapping batches', async (t) => {
  const gate = deferred();
  const h = harness(t, () => h.calls.length === 1 ? gate.promise : Promise.resolve());
  h.enable(true);
  void h.logger.log('stalled');
  assert.equal(typeof h.logger.flushLogs, 'function');
  let done = false;
  const flushing = h.logger.flushLogs().then(() => { done = true; });
  await tick();
  await h.advance(2000);
  assert.equal(done, true, 'exit wait is capped at two seconds');
  await flushing;
  void h.logger.log('after-timeout');
  await h.advance(3000);
  assert.equal(h.calls.length, 1, 'timeout must not release the transport lock');
  gate.resolve();
  await h.logger.flushLogs();
  assert.deepEqual(h.calls.map((c) => c.args.messages), [['stalled'], ['after-timeout']]);
});
