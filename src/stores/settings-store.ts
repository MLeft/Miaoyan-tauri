import { create } from 'zustand';
import type { AppConfig } from '../types';
import { getConfig, saveConfig, setScanRoots } from '../services/tauri-bridge';
import { pathIdentity } from '../utils/path-identity';

interface SettingsState {
  config: AppConfig;
  draftConfig: AppConfig | null;
  storageRevision: number;
  loaded: boolean;
  loadError: string | null;
  saveStatus: 'idle' | 'saving' | 'error';
  saveError: string | null;
  loadConfig: () => Promise<void>;
  updateConfig: (partial: Partial<AppConfig>) => Promise<boolean>;
  retrySave: () => Promise<boolean>;
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

const numericSettings: Partial<Record<keyof AppConfig, [number, number]>> = {
  editor_font_size: [8, 96], preview_font_size: [8, 96],
  auto_save_interval: [0, 3_600_000], title_font_size: [12, 48],
  presentation_font_size: [16, 72], line_height: [1, 3],
  line_spacing: [0.5, 10], letter_spacing: [0, 2],
};

const choiceSettings: Partial<Record<keyof AppConfig, string[]>> = {
  theme: ['system', 'light', 'dark'], language: ['en', 'zh-Hans', 'zh-Hant', 'es', 'ja'],
  split_mode: ['editor', 'preview', 'split'], button_display: ['always', 'hover', 'hide'],
  preview_width: ['600', '800', '1000', '1200', '1400', 'full'], line_ending: ['lf', 'crlf'],
  image_upload_service: ['none', 'picgo', 'upic', 'picsee', 'piclist'],
};

function invalidSetting(partial: Partial<AppConfig>): string | null {
  for (const [key, [min, max]] of Object.entries(numericSettings)) {
    if (!(key in partial)) continue;
    const value = partial[key as keyof AppConfig];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return key;
    if (key === 'auto_save_interval' && !Number.isInteger(value)) return key;
  }
  for (const [key, choices] of Object.entries(choiceSettings)) {
    if (key in partial && !choices.includes(partial[key as keyof AppConfig] as string)) return key;
  }
  for (const key of ['editor_font_family', 'preview_font_family', 'code_font_family'] as const) {
    if (key in partial && (typeof partial[key] !== 'string' || !partial[key]!.trim())) return key;
  }
  return null;
}

export const useSettingsStore = create<SettingsState>((set, get) => {
  let saveQueue: Promise<unknown> = Promise.resolve();
  let revision = 0;
  const fail = (error: string) => {
    set({ saveStatus: 'error', saveError: error });
    window.dispatchEvent(new CustomEvent('show-toast', { detail: { message: error, type: 'warning' } }));
  };
  return {
    config: defaultConfig,
    draftConfig: null,
    storageRevision: 0,
    loaded: false,
    loadError: null,
    saveStatus: 'idle',
    saveError: null,

    loadConfig: async () => {
      set({ loaded: false });
      try {
        const config = await getConfig();
        const storageRevision = get().storageRevision + Number(pathIdentity(get().config.storage_path) !== pathIdentity(config.storage_path));
        setScanRoots(config.storage_path, config.extra_folders);
        set({ config, draftConfig: null, storageRevision, loaded: true, loadError: null });
      } catch (error) {
        set({ loaded: true, loadError: String(error) });
      }
    },

    updateConfig: (partial) => {
      if (get().loadError) {
        fail(get().loadError!);
        return Promise.resolve(false);
      }
      const invalid = invalidSetting(partial);
      if (invalid) {
        fail(`Invalid setting: ${invalid}`);
        return Promise.resolve(false);
      }
      const current = get().config;
      const config = { ...(get().draftConfig ?? current), ...partial };
      const request = ++revision;
      set({ config: { ...config, storage_path: current.storage_path, extra_folders: current.extra_folders }, draftConfig: config, saveStatus: 'saving', saveError: null });
      const saved = saveQueue.then(async () => {
        try {
          await saveConfig(config);
          const active = get();
          const storageRevision = active.storageRevision + Number(pathIdentity(active.config.storage_path) !== pathIdentity(config.storage_path));
          setScanRoots(config.storage_path, config.extra_folders);
          set({
            config: request === revision ? config : { ...active.config, storage_path: config.storage_path, extra_folders: config.extra_folders },
            storageRevision,
            ...(request === revision ? { draftConfig: null, saveStatus: 'idle' as const, saveError: null } : {}),
          });
          return true;
        } catch (error) {
          if (request === revision) fail(`Settings were not saved: ${String(error)}`);
          return false;
        }
      });
      saveQueue = saved;
      return saved;
    },

    retrySave: () => get().updateConfig({}),
  };
});
