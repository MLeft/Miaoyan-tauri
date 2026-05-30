import { create } from 'zustand';
import type { AppConfig } from '../types';
import { getConfig, saveConfig } from '../services/tauri-bridge';

interface SettingsState {
  config: AppConfig;
  loaded: boolean;
  loadConfig: () => Promise<void>;
  updateConfig: (partial: Partial<AppConfig>) => Promise<void>;
}

const defaultConfig: AppConfig = {
  storage_path: '',
  theme: 'system',
  language: 'en',
  editor_font_family: 'ui-monospace',
  editor_font_size: 15,
  preview_font_family: 'system-ui',
  preview_font_size: 15,
  code_font_family: 'Menlo, monospace',
  show_sidebar: true,
  show_notes_list: true,
  split_mode: 'split',
  auto_save_interval: 1500,
  button_display: 'always',
  always_on_top: false,
  quick_launch_shortcut: '',
  preview_width: '800',
  line_ending: 'lf',
  title_font_size: 20,
  presentation_font_size: 24,
  line_height: 1.3,
  line_spacing: 3.0,
  letter_spacing: 0.5,
  image_upload_service: 'none',
  extra_folders: [],
  debug_log: false,
};

export const useSettingsStore = create<SettingsState>((set, get) => ({
  config: defaultConfig,
  loaded: false,

  loadConfig: async () => {
    try {
      const config = await getConfig();
      set({ config, loaded: true });
    } catch {
      set({ config: defaultConfig, loaded: true });
    }
  },

  updateConfig: async (partial) => {
    const current = get().config;
    const newConfig = { ...current, ...partial };
    set({ config: newConfig });
    try {
      await saveConfig(newConfig);
    } catch (e) {
      console.error('Failed to save config:', e);
    }
  },
}));
