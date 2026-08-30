import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../stores/settings-store';

export async function log(message: string) {
  const config = useSettingsStore.getState().config;
  // 始终打印到 console
  console.log(`[MiaoYan] ${message}`);
  // 如果开启日志，写入 ~/.miaoyan/log 文件
  if (config.debug_log) {
    try {
      await invoke('write_log', { message });
    } catch (e) {
      console.error('Log write failed:', e);
    }
  }
}
