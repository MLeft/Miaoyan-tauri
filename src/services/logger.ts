import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../stores/settings-store';
import { createLogBuffer } from './log-buffer';

const buffer = createLogBuffer((messages) => invoke<void>('write_logs', { messages }));
buffer.setEnabled(useSettingsStore.getState().config.debug_log);
useSettingsStore.subscribe((state, previous) => {
  if (state.config.debug_log !== previous.config.debug_log) buffer.setEnabled(state.config.debug_log);
});

/** Shared disk-only entry for sources (such as perf) with their own console output. */
export function enqueueLog(message: string): void {
  buffer.enqueue(message);
}

/** Best-effort exit drain; never rejects, and waits at most two seconds for IPC. */
export function flushLogs(): Promise<void> {
  return buffer.flush();
}

/** Bounded-queue overflow and transport failures remain observable without logging recursively. */
export const getLogStats = buffer.stats;

export async function log(message: string): Promise<void> {
  console.log(`[MiaoYan] ${message}`);
  enqueueLog(message);
}
