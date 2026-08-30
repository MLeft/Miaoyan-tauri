import { invoke } from '@tauri-apps/api/core';

/*
 * 轻量性能遥测：只记录超过阈值的事件（长任务、慢按键、慢渲染等），
 * 内存缓冲 + 3s 防抖批量落盘到 ~/.miaoyan/log/<日期>.log（[perf] 前缀）。
 * 正常运行时开销趋近于零，用于定位真实使用中的卡顿点。
 */

const buffer: string[] = [];
const MAX_BUFFER = 100;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  flushTimer = null;
  const lines = buffer.splice(0, buffer.length);
  if (lines.length === 0) return;
  for (const line of lines) {
    invoke('write_log', { message: `[perf] ${line}` }).catch(() => {});
  }
}

/** 记录一次超阈值事件（调用方负责阈值判断） */
export function perfReport(metric: string, ms: number, detail = '') {
  const entry = `${new Date().toISOString()} ${metric} ${ms.toFixed(1)}ms${detail ? ' ' + detail : ''}`;
  console.warn(`[perf] ${entry}`);
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  if (!flushTimer) flushTimer = setTimeout(flush, 3000);
}

/** 主线程长任务（>80ms）监听 */
export function startPerfObserver() {
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration > 80) perfReport('longtask', e.duration);
      }
    });
    obs.observe({ entryTypes: ['longtask'] });
  } catch {
    /* 环境不支持 longtask */
  }
}
