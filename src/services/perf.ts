import { enqueueLog } from './logger';

/*
 * 轻量性能遥测：只记录超过阈值的事件（长任务、慢按键、慢渲染等），
 * 与普通日志共用有界队列，尊重 debug_log；3s/阈值批量落盘（[perf] 前缀）。
 * 正常运行时开销趋近于零，用于定位真实使用中的卡顿点。
 */

/** 记录一次超阈值事件（调用方负责阈值判断） */
export function perfReport(metric: string, ms: number, detail = '') {
  const entry = `${new Date().toISOString()} ${metric} ${ms.toFixed(1)}ms${detail ? ' ' + detail : ''}`;
  console.warn(`[perf] ${entry}`);
  enqueueLog(`[perf] ${entry}`);
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
