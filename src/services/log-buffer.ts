export const MAX_LOG_MESSAGES = 100;
export const MAX_LOG_MESSAGE_CHARS = 2048;
export const LOG_FLUSH_THRESHOLD = 50;
export const LOG_FLUSH_INTERVAL_MS = 3000;
export const LOG_FLUSH_WAIT_MS = 2000;

/** One bounded queue, including the immutable batch currently owned by IPC. */
export function createLogBuffer(send: (messages: string[]) => Promise<void>) {
  let enabled = false;
  let generation = 0;
  let pending: string[] = [];
  let inFlight = 0;
  let dropped = 0;
  let failedBatches = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let completion: Promise<void> | null = null;

  function cancelTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  async function drain(onComplete: () => void) {
    try {
      while (enabled && pending.length > 0) {
        const batch = pending;
        pending = [];
        const batchGeneration = generation;
        inFlight = batch.length;
        try {
          await send(batch);
        } catch {
          failedBatches = Math.min(Number.MAX_SAFE_INTEGER, failedBatches + 1);
          // No recursive logging or automatic retry. The reserved in-flight capacity
          // guarantees that restoring a failed batch cannot overflow the queue.
          if (enabled && generation === batchGeneration) pending = batch.concat(pending);
          break;
        } finally {
          inFlight = 0;
        }
      }
    } finally {
      // Release synchronously with the loop's last queue check: a Promise.finally
      // microtask would leave a gap in which new arrivals could get stranded.
      onComplete();
    }
  }

  function flush(): Promise<void> {
    cancelTimer();
    if (running) return completion!;
    if (!enabled || pending.length === 0) return Promise.resolve();
    running = true;
    let finish!: () => void;
    const result = new Promise<void>((resolve) => { finish = resolve; });
    completion = result;
    // Only the caller's wait expires: the IPC lock stays held until settlement.
    // Concurrent callers share this promise/timer, even after the deadline.
    const deadline = setTimeout(finish, LOG_FLUSH_WAIT_MS);
    void drain(() => {
      clearTimeout(deadline);
      running = false;
      completion = null;
      finish();
    });
    return result;
  }

  function enqueue(message: string) {
    if (!enabled) return;
    // Check length before encoding/serializing arbitrarily large input. At most
    // 100 * 2048 UTF-16 units also fits the backend's 1 MiB UTF-8 input budget.
    if (message.length > MAX_LOG_MESSAGE_CHARS) {
      dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1);
      return;
    }
    if (pending.length + inFlight >= MAX_LOG_MESSAGES) {
      dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1);
      if (pending.length === 0) return; // Never mutate an in-flight batch.
      pending.shift(); // Retain the newest pending diagnostics.
    }
    pending.push(message);
    if (running) return; // The active drain owns new arrivals too.
    if (pending.length >= LOG_FLUSH_THRESHOLD) void flush();
    else if (timer === null) timer = setTimeout(() => { void flush(); }, LOG_FLUSH_INTERVAL_MS);
  }

  return {
    enqueue,
    flush,
    setEnabled(value: boolean) {
      if (enabled === value) return;
      enabled = value;
      if (!enabled) {
        generation++;
        pending = [];
        cancelTimer();
      }
      // Already dispatched IPC cannot be recalled, but it cannot restore a
      // disabled generation or dispatch any cleared messages on completion.
    },
    stats: () => ({ pending: pending.length, inFlight, dropped, failedBatches }),
  };
}
