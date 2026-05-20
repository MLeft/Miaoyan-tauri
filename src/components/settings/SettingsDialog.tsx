import { useState, useEffect } from 'react';
import { useSettingsStore } from '../../stores/settings-store';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-dialog';

type Tab = 'interface' | 'experience' | 'editor';

// 原版 PrefsFormMetrics
const LABEL_WIDTH = 164;   // px
const CONTROL_WIDTH = 220; // px
const ROW_HEIGHT = 32;     // px (略高于原版 30 以适应 web)
const ROW_GAP = 14;        // px rowSpacing
const PAGE_TOP = 28;       // px (web 版不需要 titlebar 72px 空间)
const PAGE_H = 24;         // px bottom inset

interface Props {
  onClose: () => void;
}

export function SettingsDialog({ onClose }: Props) {
  const { t } = useTranslation();
  const { config, updateConfig } = useSettingsStore();
  const [activeTab, setActiveTab] = useState<Tab>('interface');
  const [shortcutRecording, setShortcutRecording] = useState(false);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'interface', label: t('settings.general') },
    { id: 'experience', label: t('settings.editor') },
    { id: 'editor', label: t('settings.preview') },
  ];

  const handleSelectFolder = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: t('app.selectFolder') });
      if (selected) {
        await updateConfig({ storage_path: selected as string });
      }
    } catch (e) {
      console.error('Failed to select folder:', e);
    }
  };

  // 快捷键录制
  useEffect(() => {
    if (!shortcutRecording) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const keys: string[] = [];
      if (e.metaKey) keys.push('⌘');
      if (e.ctrlKey) keys.push('⌃');
      if (e.altKey) keys.push('⌥');
      if (e.shiftKey) keys.push('⇧');
      if (e.key && !['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) {
        keys.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
      }
      if (keys.length > 0) {
        updateConfig({ quick_launch_shortcut: keys.join('') });
        setShortcutRecording(false);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [shortcutRecording, updateConfig]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}
      onClick={onClose}
    >
      <div
        className="flex rounded-xl overflow-hidden shadow-2xl"
        style={{
          width: 680,
          height: 480,
          backgroundColor: 'var(--bg-primary, #fff)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.25), 0 0 0 0.5px rgba(0,0,0,0.12)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── 左侧边栏 176px ── */}
        <div
          style={{
            width: 176,
            flexShrink: 0,
            backgroundColor: 'var(--bg-secondary, #f2f2f7)',
            borderRight: '0.5px solid var(--border, #d8d8d8)',
            paddingTop: 52, // 留出 titlebar 视觉空间
            paddingBottom: 12,
          }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                display: 'block',
                textAlign: 'left',
                padding: activeTab === tab.id ? '6px 16px' : '6px 24px',
                fontSize: 13,
                fontWeight: activeTab === tab.id ? 500 : 400,
                color: activeTab === tab.id ? '#fff' : 'var(--text-primary, #1d1d1f)',
                backgroundColor: activeTab === tab.id ? '#007AFF' : 'transparent',
                borderRadius: activeTab === tab.id ? 6 : 0,
                margin: activeTab === tab.id ? '1px 8px' : '1px 0',
                width: activeTab === tab.id ? 'calc(100% - 16px)' : '100%',
                border: 'none',
                cursor: 'pointer',
                outline: 'none',
                lineHeight: '22px',
                boxSizing: 'border-box',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* ── 右侧内容区 ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', backgroundColor: 'var(--bg-content, #fff)', position: 'relative' }}>
          {/* 关闭按钮 */}
          <button
            onClick={onClose}
            style={{
              position: 'absolute',
              top: 12,
              right: 14,
              width: 20,
              height: 20,
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              color: 'var(--text-tertiary, #aaa)',
              fontSize: 18,
              lineHeight: '20px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 4,
              padding: 0,
            }}
          >
            ×
          </button>

          {/* 标题 */}
          <div style={{
            paddingTop: 14,
            paddingLeft: 28,
            paddingBottom: 0,
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--text-primary, #1d1d1f)',
            height: 44,
            display: 'flex',
            alignItems: 'center',
            borderBottom: '0.5px solid var(--border, #e0e0e0)',
          }}>
            {tabs.find(t => t.id === activeTab)?.label}
          </div>

          {/* 表单区域 */}
          <div style={{ flex: 1, overflowY: 'auto', paddingTop: PAGE_TOP, paddingLeft: 28, paddingRight: 28, paddingBottom: PAGE_H }}>
            {activeTab === 'interface' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: ROW_GAP }}>
                {/* Storage Path */}
                <Row label={`${t('settings.storagePath')}:`}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                      fontSize: 12,
                      color: 'var(--text-secondary, #666)',
                      maxWidth: 160,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      display: 'inline-block',
                    }}>
                      {config.storage_path
                        ? config.storage_path.split('/').slice(-3).join('/')
                        : t('settings.notSet')}
                    </span>
                    <MacButton onClick={handleSelectFolder}>{t('settings.change')}</MacButton>
                  </div>
                </Row>

                <Separator />

                <Row label={`${t('settings.splitMode')}:`}>
                  <MacSelect
                    value={config.split_mode}
                    onChange={(v) => updateConfig({ split_mode: v as any })}
                    options={[
                      { value: 'split', label: t('settings.splitView') },
                      { value: 'editor', label: t('settings.editorOnly') },
                      { value: 'preview', label: t('settings.previewOnly') },
                    ]}
                  />
                </Row>

                <Row label={`${t('settings.theme')}:`}>
                  <MacSelect
                    value={config.theme}
                    onChange={(v) => updateConfig({ theme: v })}
                    options={[
                      { value: 'system', label: t('settings.themeSystem') },
                      { value: 'light', label: t('settings.themeLight') },
                      { value: 'dark', label: t('settings.themeDark') },
                    ]}
                  />
                </Row>

                <Row label={`${t('settings.language')}:`}>
                  <MacSelect
                    value={config.language}
                    onChange={(v) => updateConfig({ language: v })}
                    options={[
                      { value: 'zh-Hans', label: '简体中文' },
                      { value: 'zh-Hant', label: '繁體中文' },
                      { value: 'en', label: 'English' },
                      { value: 'ja', label: '日本語' },
                    ]}
                  />
                </Row>

                <Row label={`${t('settings.buttonDisplay')}:`}>
                  <MacSelect
                    value={config.button_display}
                    onChange={(v) => updateConfig({ button_display: v as any })}
                    options={[
                      { value: 'always', label: t('settings.buttonAlways') },
                      { value: 'hover', label: t('settings.buttonHover') },
                      { value: 'hide', label: t('settings.buttonHide') },
                    ]}
                  />
                </Row>

                <Row label={`${t('settings.alwaysOnTop')}:`}>
                  <MacSelect
                    value={config.always_on_top ? 'yes' : 'no'}
                    onChange={(v) => updateConfig({ always_on_top: v === 'yes' })}
                    options={[
                      { value: 'yes', label: t('settings.yes') },
                      { value: 'no', label: t('settings.no') },
                    ]}
                  />
                </Row>

                <Row label={`${t('settings.quickLaunch')}:`}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button
                      onClick={() => setShortcutRecording(true)}
                      style={{
                        width: CONTROL_WIDTH,
                        height: ROW_HEIGHT - 4,
                        border: `1px solid ${shortcutRecording ? '#007AFF' : 'var(--border, #ccc)'}`,
                        borderRadius: 6,
                        backgroundColor: shortcutRecording ? 'rgba(0,122,255,0.06)' : 'var(--bg-secondary, #f5f5f7)',
                        color: 'var(--text-primary, #333)',
                        fontSize: 13,
                        cursor: 'pointer',
                        outline: 'none',
                        textAlign: 'center',
                      }}
                    >
                      {shortcutRecording
                        ? t('settings.recording') || 'Recording...'
                        : config.quick_launch_shortcut || '-'}
                    </button>
                    {config.quick_launch_shortcut && !shortcutRecording && (
                      <button
                        onClick={() => updateConfig({ quick_launch_shortcut: '' })}
                        style={{
                          border: 'none', background: 'none', cursor: 'pointer',
                          color: 'var(--text-tertiary, #999)', fontSize: 16, padding: 0,
                          lineHeight: 1,
                        }}
                        title={t('settings.clear')}
                      >×</button>
                    )}
                  </div>
                </Row>
              </div>
            )}

            {activeTab === 'experience' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: ROW_GAP }}>
                <Row label={`${t('settings.fontFamily')}:`}>
                  <MacInput
                    value={config.editor_font_family}
                    onChange={(v) => updateConfig({ editor_font_family: v })}
                  />
                </Row>
                <Row label={`${t('settings.fontSize')}:`}>
                  <MacInput
                    type="number"
                    value={String(config.editor_font_size)}
                    onChange={(v) => updateConfig({ editor_font_size: Number(v) })}
                    width={80}
                  />
                </Row>
                <Row label={`${t('settings.autoSaveInterval')}:`}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <MacInput
                      type="number"
                      value={String(config.auto_save_interval)}
                      onChange={(v) => updateConfig({ auto_save_interval: Number(v) })}
                      width={80}
                    />
                    <span style={{ fontSize: 12, color: 'var(--text-tertiary, #999)' }}>ms</span>
                  </div>
                </Row>

                <Separator />

                <ShortcutList />
              </div>
            )}

            {activeTab === 'editor' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: ROW_GAP }}>
                <Row label={`${t('settings.previewFont')}:`}>
                  <MacInput
                    value={config.preview_font_family}
                    onChange={(v) => updateConfig({ preview_font_family: v })}
                  />
                </Row>
                <Row label={`${t('settings.previewFontSize')}:`}>
                  <MacInput
                    type="number"
                    value={String(config.preview_font_size)}
                    onChange={(v) => updateConfig({ preview_font_size: Number(v) })}
                    width={80}
                  />
                </Row>
                <Row label={`${t('settings.codeFont')}:`}>
                  <MacInput
                    value={config.code_font_family}
                    onChange={(v) => updateConfig({ code_font_family: v })}
                  />
                </Row>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 原版 makePreferencesRow 对应：164px 右对齐标签 + 16px 间距 + 控件 ──
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', minHeight: ROW_HEIGHT }}>
      <span style={{
        width: LABEL_WIDTH,
        flexShrink: 0,
        textAlign: 'right',
        fontSize: 13,
        color: 'var(--text-secondary, #555)',
        paddingRight: 16,
        lineHeight: `${ROW_HEIGHT}px`,
      }}>
        {label}
      </span>
      <div style={{ flex: 1 }}>
        {children}
      </div>
    </div>
  );
}

// 分隔线，与原版 makePreferencesSeparator 对应（从 label 右边开始）
function Separator() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', minHeight: 1 }}>
      <div style={{ width: LABEL_WIDTH + 16, flexShrink: 0 }} />
      <div style={{ flex: 1, height: '0.5px', backgroundColor: 'var(--border, #e0e0e0)' }} />
    </div>
  );
}

// macOS 风格 NSPopUpButton 对应的 select
function MacSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div style={{ position: 'relative', width: CONTROL_WIDTH }}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          appearance: 'none',
          WebkitAppearance: 'none',
          width: '100%',
          height: ROW_HEIGHT - 4,
          paddingLeft: 10,
          paddingRight: 28,
          fontSize: 13,
          border: '0.5px solid var(--border, #c7c7c7)',
          borderRadius: 6,
          backgroundColor: 'var(--bg-secondary, #f5f5f7)',
          color: 'var(--text-primary, #1d1d1f)',
          cursor: 'pointer',
          outline: 'none',
        }}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      {/* 蓝色 chevron */}
      <svg
        style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}
        width="11" height="11" viewBox="0 0 24 24"
        fill="none" stroke="#007AFF" strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </div>
  );
}

// macOS 风格文本输入
function MacInput({
  value,
  onChange,
  type = 'text',
  width,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  width?: number;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: width ?? CONTROL_WIDTH,
        height: ROW_HEIGHT - 4,
        paddingLeft: 8,
        paddingRight: 8,
        fontSize: 13,
        border: '0.5px solid var(--border, #c7c7c7)',
        borderRadius: 6,
        backgroundColor: 'var(--bg-secondary, #f5f5f7)',
        color: 'var(--text-primary, #1d1d1f)',
        outline: 'none',
      }}
    />
  );
}

// macOS 风格普通按钮
function MacButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        height: ROW_HEIGHT - 4,
        paddingLeft: 12,
        paddingRight: 12,
        fontSize: 13,
        border: '0.5px solid var(--border, #c7c7c7)',
        borderRadius: 6,
        backgroundColor: 'var(--bg-secondary, #f5f5f7)',
        color: 'var(--text-primary, #1d1d1f)',
        cursor: 'pointer',
        outline: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  );
}

// 快捷键列表
function ShortcutList() {
  const { t } = useTranslation();
  const shortcuts = [
    { keys: '⌘N', action: t('shortcuts.newNote') },
    { keys: '⌘F', action: t('shortcuts.search') },
    { keys: '⌘1', action: t('shortcuts.toggleSidebar') },
    { keys: '⌘2', action: t('shortcuts.toggleNotesList') },
    { keys: '⌘3', action: t('shortcuts.togglePreview') },
    { keys: '⌘\\', action: t('shortcuts.cycleViewMode') },
    { keys: '⌘4', action: t('shortcuts.presentation') },
    { keys: '⌘,', action: t('shortcuts.settings') },
    { keys: '⌘B', action: t('shortcuts.bold') },
    { keys: '⌘I', action: t('shortcuts.italic') },
    { keys: '⌘K', action: t('shortcuts.link') },
    { keys: '⌘E', action: t('shortcuts.codeBlock') },
  ];

  return (
    <div>
      <div style={{
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: 'var(--text-tertiary, #999)',
        paddingLeft: LABEL_WIDTH + 16,
        marginBottom: 10,
      }}>
        {t('settings.shortcuts')}
      </div>
      {shortcuts.map((s) => (
        <div
          key={s.keys}
          style={{
            display: 'flex',
            alignItems: 'center',
            minHeight: 26,
            marginBottom: 2,
          }}
        >
          <span style={{
            width: LABEL_WIDTH,
            flexShrink: 0,
            textAlign: 'right',
            fontSize: 13,
            color: 'var(--text-secondary, #555)',
            paddingRight: 16,
          }}>
            {s.action}
          </span>
          <kbd style={{
            fontSize: 12,
            fontFamily: 'ui-monospace, monospace',
            color: 'var(--text-secondary, #555)',
            backgroundColor: 'var(--bg-secondary, #f5f5f5)',
            border: '0.5px solid var(--border, #ddd)',
            borderRadius: 4,
            padding: '1px 6px',
          }}>
            {s.keys}
          </kbd>
        </div>
      ))}
    </div>
  );
}
