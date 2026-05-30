import { useState, useEffect } from 'react';
import { useSettingsStore } from '../../stores/settings-store';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-dialog';
import { setAlwaysOnTop, detectCloudSync, type CloudSyncInfo } from '../../services/tauri-bridge';

type Tab = 'interface' | 'experience' | 'editor' | 'typography';

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
  const [cloudInfo, setCloudInfo] = useState<CloudSyncInfo | null>(null);

  useEffect(() => {
    detectCloudSync()
      .then(setCloudInfo)
      .catch(() => {});
  }, []);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'interface', label: t('settings.general') },
    { id: 'experience', label: t('settings.editor') },
    { id: 'editor', label: t('settings.preview') },
    { id: 'typography', label: t('settings.typography') },
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center dialog-overlay"
      style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}
      onClick={onClose}
    >
      <div
        className="flex rounded-xl overflow-hidden dialog-content"
        style={{
          width: 680,
          height: 480,
          backgroundColor: 'var(--bg-primary)',
          boxShadow: 'var(--shadow-lg), 0 0 0 0.5px var(--border)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── 左侧边栏 176px ── */}
        <div
          style={{
            width: 176,
            flexShrink: 0,
            backgroundColor: 'var(--bg-secondary)',
            borderRight: '0.5px solid var(--border)',
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
                color: activeTab === tab.id ? 'var(--text-inverse)' : 'var(--text-primary)',
                backgroundColor: activeTab === tab.id ? 'var(--system-blue)' : 'transparent',
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
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', backgroundColor: 'var(--bg-primary)', position: 'relative' }}>
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
              color: 'var(--text-tertiary)',
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
            color: 'var(--text-primary)',
            height: 44,
            display: 'flex',
            alignItems: 'center',
            borderBottom: '0.5px solid var(--border)',
          }}>
            {tabs.find(t => t.id === activeTab)?.label}
          </div>

          {/* 表单区域 */}
          <div style={{ flex: 1, overflowY: 'auto', paddingTop: PAGE_TOP, paddingLeft: 28, paddingRight: 28, paddingBottom: PAGE_H }}>
            {activeTab === 'interface' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: ROW_GAP }}>
                {/* Storage Path */}
                <Row label={`${t('settings.storagePath')}:`}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{
                        fontSize: 12,
                        color: 'var(--text-secondary)',
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
                    {/* iCloud sync hint */}
                    <ICloudSyncHint
                      cloudInfo={cloudInfo}
                      storagePath={config.storage_path}
                      onUseIcloud={async () => {
                        if (!cloudInfo?.icloud_path) return;
                        const miaoyanDir = `${cloudInfo.icloud_path}/MiaoYan`;
                        await updateConfig({ storage_path: miaoyanDir });
                      }}
                    />
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
                      { value: 'es', label: 'Español' },
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
                    onChange={async (v) => {
                      const enabled = v === 'yes';
                      await updateConfig({ always_on_top: enabled });
                      await setAlwaysOnTop(enabled);
                    }}
                    options={[
                      { value: 'yes', label: t('settings.yes') },
                      { value: 'no', label: t('settings.no') },
                    ]}
                  />
                </Row>

                <Row label={`${t('settings.quickLaunch')}:`}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div
                      style={{
                        width: CONTROL_WIDTH,
                        height: ROW_HEIGHT - 4,
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        backgroundColor: 'var(--bg-secondary)',
                        color: 'var(--text-primary)',
                        fontSize: 13,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {config.quick_launch_shortcut || '⌘⌥M'}
                    </div>
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
                    <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>ms</span>
                  </div>
                </Row>

                <Separator />

                <Row label={`${t('settings.lineEnding')}:`}>
                  <MacSelect
                    value={config.line_ending}
                    onChange={(v) => updateConfig({ line_ending: v as 'lf' | 'crlf' })}
                    options={[
                      { value: 'lf', label: `LF (${t('settings.lineEndingLF')})` },
                      { value: 'crlf', label: `CRLF (${t('settings.lineEndingCRLF')})` },
                    ]}
                  />
                </Row>
                <Row label={`${t('settings.lineSpacing')}:`}>
                  <MacInput
                    type="number"
                    value={String(config.line_spacing)}
                    onChange={(v) => {
                      const val = Number(v);
                      if (val >= 0.5 && val <= 10) updateConfig({ line_spacing: val });
                    }}
                    width={80}
                    step={0.5}
                  />
                </Row>
                <Row label={`${t('settings.letterSpacing')}:`}>
                  <MacInput
                    type="number"
                    value={String(config.letter_spacing)}
                    onChange={(v) => {
                      const val = Number(v);
                      if (val >= 0 && val <= 2) updateConfig({ letter_spacing: val });
                    }}
                    width={80}
                    step={0.1}
                  />
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

                <Separator />

                <Row label={`${t('settings.previewWidth')}:`}>
                  <MacSelect
                    value={config.preview_width}
                    onChange={(v) => updateConfig({ preview_width: v as any })}
                    options={[
                      { value: '600', label: '600px' },
                      { value: '800', label: '800px' },
                      { value: '1000', label: '1000px' },
                      { value: '1200', label: '1200px' },
                      { value: '1400', label: '1400px' },
                      { value: 'full', label: t('settings.previewWidthFull') },
                    ]}
                  />
                </Row>

                <Separator />

                <Row label={`${t('settings.imageUploadService')}:`}>
                  <MacSelect
                    value={config.image_upload_service}
                    onChange={(v) => updateConfig({ image_upload_service: v as any })}
                    options={[
                      { value: 'none', label: t('settings.imageUploadNone') },
                      { value: 'picgo', label: 'PicGo' },
                      { value: 'piclist', label: 'PicList' },
                      { value: 'upic', label: 'uPic' },
                      { value: 'picsee', label: 'Picsee' },
                    ]}
                  />
                </Row>

                <Separator />

                <Row label={`${t('settings.debugLog')}:`}>
                  <MacSelect
                    value={config.debug_log ? 'yes' : 'no'}
                    onChange={(v) => updateConfig({ debug_log: v === 'yes' })}
                    options={[
                      { value: 'yes', label: t('settings.yes') },
                      { value: 'no', label: t('settings.no') },
                    ]}
                  />
                </Row>
              </div>
            )}

            {activeTab === 'typography' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: ROW_GAP }}>
                <Row label={`${t('settings.titleFontSize')}:`}>
                  <MacInput
                    type="number"
                    value={String(config.title_font_size)}
                    onChange={(v) => {
                      const val = Number(v);
                      if (val >= 12 && val <= 48) updateConfig({ title_font_size: val });
                    }}
                    width={80}
                  />
                </Row>
                <Row label={`${t('settings.presentationFontSize')}:`}>
                  <MacInput
                    type="number"
                    value={String(config.presentation_font_size)}
                    onChange={(v) => {
                      const val = Number(v);
                      if (val >= 16 && val <= 72) updateConfig({ presentation_font_size: val });
                    }}
                    width={80}
                  />
                </Row>
                <Row label={`${t('settings.lineHeight')}:`}>
                  <MacInput
                    type="number"
                    value={String(config.line_height)}
                    onChange={(v) => {
                      const val = Number(v);
                      if (val >= 1.0 && val <= 3.0) updateConfig({ line_height: val });
                    }}
                    width={80}
                    step={0.1}
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
        color: 'var(--text-secondary)',
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
      <div style={{ flex: 1, height: '0.5px', backgroundColor: 'var(--border)' }} />
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
          border: '0.5px solid var(--border)',
          borderRadius: 6,
          backgroundColor: 'var(--bg-secondary)',
          color: 'var(--text-primary)',
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
        fill="none" stroke="var(--system-blue)" strokeWidth="2.5"
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
  step,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  width?: number;
  step?: number;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      step={step}
      style={{
        width: width ?? CONTROL_WIDTH,
        height: ROW_HEIGHT - 4,
        paddingLeft: 8,
        paddingRight: 8,
        fontSize: 13,
        border: '0.5px solid var(--border)',
        borderRadius: 6,
        backgroundColor: 'var(--bg-secondary)',
        color: 'var(--text-primary)',
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
        border: '0.5px solid var(--border)',
        borderRadius: 6,
        backgroundColor: 'var(--bg-secondary)',
        color: 'var(--text-primary)',
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
    { keys: '⌘⌥M', action: t('shortcuts.quickLaunch') || 'Quick Launch' },
  ];

  return (
    <div>
      <div style={{
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: 'var(--text-tertiary)',
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
            color: 'var(--text-secondary)',
            paddingRight: 16,
          }}>
            {s.action}
          </span>
          <kbd style={{
            fontSize: 12,
            fontFamily: 'ui-monospace, monospace',
            color: 'var(--text-secondary)',
            backgroundColor: 'var(--bg-secondary)',
            border: '0.5px solid var(--border)',
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

// iCloud 同步提示组件
function ICloudSyncHint({
  cloudInfo,
  storagePath,
  onUseIcloud,
}: {
  cloudInfo: CloudSyncInfo | null;
  storagePath: string;
  onUseIcloud: () => Promise<void>;
}) {
  const { t } = useTranslation();

  // macOS + iCloud 可用：判断是否已在 iCloud 目录
  if (cloudInfo && cloudInfo.status === 'Available' && cloudInfo.icloud_path) {
    const alreadyInIcloud = storagePath.startsWith(cloudInfo.icloud_path);
    if (alreadyInIcloud) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: 'var(--success-color)', display: 'inline-block' }} />
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
            {t('sync.icloudAvailable')}
          </span>
        </div>
      );
    }
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
          {t('sync.icloudAvailable')}
        </span>
        <button
          onClick={onUseIcloud}
          style={{
            fontSize: 11,
            color: 'var(--system-blue)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            textDecoration: 'underline',
          }}
        >
          {t('sync.useIcloud')}
        </button>
      </div>
    );
  }

  // 非 macOS 或 iCloud 不可用：显示灰色提示
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
        {t('sync.hint')}
      </span>
    </div>
  );
}
