import { useEffect, useState, useRef, lazy, Suspense } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { stat } from '@tauri-apps/plugin-fs';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import { Allotment } from 'allotment';
import 'allotment/dist/style.css';
import { TabBar } from './components/editor/TabBar';
import { Preview } from './components/preview/Preview';
import { isPdfPath } from './utils/fileType';
import { SettingsDialog } from './components/settings/SettingsDialog';
import { PresentationMode } from './components/presentation/PresentationMode';
import { TableOfContents } from './components/shared/TableOfContents';
import { Backlinks } from './components/shared/Backlinks';
import { ExportMenu } from './components/shared/ExportMenu';
import { Toast, type ToastType } from './components/shared/Toast';
import { RecoveryBanner } from './components/shared/RecoveryBanner';
import { SaveFailureBanner } from './components/shared/SaveFailureBanner';
import type { OperationWarning } from './services/tauri-bridge';
import { UnifiedTree } from './components/sidebar/UnifiedTree';
import { formatMarkdown } from './services/formatter';
import { createFolder, setAlwaysOnTop, getPendingOpenFiles, scanFolder, isCurrentScan, type ScanEvent } from './services/tauri-bridge';
import { onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { flushLogs, log } from './services/logger';
import { createDocumentCloseHandler, useNotesStore } from './stores/notes-store';
import { useSettingsStore } from './stores/settings-store';
import { useEditorStore } from './stores/editor-store';
import type { ViewMode } from './stores/editor-store';
import { open } from '@tauri-apps/plugin-dialog';
import i18n from './i18n';

const Editor = lazy(() => import('./components/editor/Editor').then(module => ({ default: module.Editor })));
const PdfViewer = lazy(() => import('./components/pdf/PdfViewer').then(module => ({ default: module.PdfViewer })));

const formatMessages: Record<string, { busy: string; done: string; changed: string; failed: string }> = {
  en: { busy: 'Formatting', done: 'Formatting complete', changed: 'Document changed or is busy; formatting was not applied', failed: 'Formatting failed' },
  'zh-Hans': { busy: '正在排版', done: '排版完成', changed: '文档已改变或正在操作，本次排版未应用', failed: '排版失败' },
  'zh-Hant': { busy: '正在排版', done: '排版完成', changed: '文件已變更或正在操作，本次排版未套用', failed: '排版失敗' },
  ja: { busy: '整形中', done: '整形が完了しました', changed: '文書が変更されたか処理中のため、整形を適用しませんでした', failed: '整形に失敗しました' },
  es: { busy: 'Formateando', done: 'Formato completado', changed: 'El documento cambió o está ocupado; no se aplicó el formato', failed: 'Error de formato' },
};

/* ── Original MiaoYan SVG Icons (inline for currentColor theme support) ── */
const IconSidebar = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
    <path d="M6.835 4c-.451.004-.82.012-1.137.038-.386.032-.659.085-.876.162l-.2.086c-.44.224-.807.564-1.063.982l-.103.184c-.126.247-.206.562-.248 1.076-.043.523-.043 1.19-.043 2.135v2.664c0 .944 0 1.612.043 2.135.042.515.122.829.248 1.076l.103.184c.256.418.624.758 1.063.982l.2.086c.217.077.49.13.876.162.316.026.685.034 1.136.038zm11.33 7.327c0 .922 0 1.654-.048 2.243-.043.522-.125.977-.305 1.395l-.082.177a4 4 0 0 1-1.473 1.593l-.276.155c-.465.237-.974.338-1.57.387-.59.048-1.322.048-2.244.048H7.833c-.922 0-1.654 0-2.243-.048-.522-.042-.977-.126-1.395-.305l-.176-.082a4 4 0 0 1-1.594-1.473l-.154-.275c-.238-.466-.34-.975-.388-1.572-.048-.589-.048-1.32-.048-2.243V8.663c0-.922 0-1.654.048-2.243.049-.597.15-1.106.388-1.571l.154-.276a4 4 0 0 1 1.594-1.472l.176-.083c.418-.18.873-.263 1.395-.305.589-.048 1.32-.048 2.243-.048h4.334c.922 0 1.654 0 2.243.048.597.049 1.106.15 1.571.388l.276.154a4 4 0 0 1 1.473 1.594l.082.176c.18.418.262.873.305 1.395.048.589.048 1.32.048 2.243zm-10 4.668h4.002c.944 0 1.612 0 2.135-.043.514-.042.829-.122 1.076-.248l.184-.103c.418-.256.758-.624.982-1.063l.086-.2c.077-.217.13-.49.162-.876.043-.523.043-1.19.043-2.135V8.663c0-.944 0-1.612-.043-2.135-.032-.386-.085-.659-.162-.876l-.086-.2a2.67 2.67 0 0 0-.982-1.063l-.184-.103c-.247-.126-.562-.206-1.076-.248-.523-.043-1.19-.043-2.135-.043H8.164L8.165 4z"/>
  </svg>
);
const IconSplit = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
    <path d="M8.502 17.5v-1.002H6.5c-.69 0-1.246 0-1.696-.036-.401-.033-.762-.098-1.098-.242l-.143-.067a3.17 3.17 0 0 1-1.261-1.165l-.122-.217c-.192-.377-.271-.784-.309-1.242-.037-.45-.036-1.007-.036-1.696V8.167c0-.689 0-1.246.036-1.696.038-.458.117-.865.309-1.242l.122-.217c.304-.496.74-.9 1.261-1.165l.143-.067c.336-.144.697-.21 1.098-.242.45-.037 1.007-.036 1.696-.036h2.002V2.5a.665.665 0 0 1 1.33 0v15a.665.665 0 0 1-1.33 0m8.333-5.667V8.167c0-.71 0-1.204-.032-1.588a2.4 2.4 0 0 0-.112-.615l-.056-.13a1.84 1.84 0 0 0-.676-.731l-.126-.072c-.158-.08-.37-.137-.745-.168-.384-.031-.877-.031-1.588-.031h-1a.665.665 0 0 1 0-1.33h1c.69 0 1.246 0 1.696.036.458.038.864.117 1.24.309l.22.122c.495.304.899.74 1.164 1.26l.067.143c.144.337.21.698.242 1.099.037.45.036 1.007.036 1.696v3.666c0 .689 0 1.246-.036 1.696-.033.401-.098.762-.242 1.099l-.067.143c-.265.52-.67.956-1.165 1.26l-.219.122c-.376.192-.782.271-1.24.309-.45.037-1.007.036-1.696.036h-1a.665.665 0 1 1 0-1.33h1c.711 0 1.204 0 1.588-.031.376-.031.587-.088.745-.168l.126-.071c.288-.177.522-.43.676-.732l.056-.13a2.4 2.4 0 0 0 .112-.615c.031-.384.032-.877.032-1.588m-13.67 0c0 .71.001 1.204.032 1.588.03.376.088.587.168.745l.07.127c.177.287.43.522.732.676l.13.055c.144.052.333.09.615.113.384.031.877.031 1.588.031h2.002V4.832H6.5c-.711 0-1.204 0-1.588.031a2.4 2.4 0 0 0-.615.113l-.13.055a1.84 1.84 0 0 0-.731.676l-.07.127c-.081.158-.138.37-.169.745-.031.384-.032.877-.032 1.588z"/>
  </svg>
);
const IconPreview = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
    <path d="M10 2.335c2.612 0 4.664 1.282 6.147 2.733 1.48 1.45 2.443 3.113 2.898 4.003l.098.225c.168.455.168.953 0 1.408l-.098.225c-.455.89-1.418 2.553-2.898 4.003-1.483 1.451-3.535 2.733-6.147 2.733s-4.665-1.282-6.147-2.733c-1.296-1.268-2.194-2.7-2.704-3.635l-.194-.368c-.3-.586-.3-1.272 0-1.858l.194-.368c.51-.935 1.408-2.367 2.704-3.635C5.335 3.617 7.388 2.335 10 2.335m0 1.33c-2.146 0-3.882 1.047-5.217 2.354C3.613 7.163 2.79 8.473 2.32 9.336l-.18.34a.7.7 0 0 0 0 .647l.18.341c.47.863 1.295 2.173 2.464 3.317 1.335 1.307 3.071 2.354 5.217 2.354s3.882-1.047 5.217-2.354c1.336-1.308 2.221-2.831 2.643-3.658l.035-.078c.059-.16.059-.33 0-.49l-.035-.078c-.422-.827-1.307-2.35-2.643-3.658S12.146 3.665 10 3.665M12.252 10a2.252 2.252 0 1 0-4.504 0 2.252 2.252 0 0 0 4.504 0m1.33 0a3.582 3.582 0 1 1-7.164 0 3.582 3.582 0 0 1 7.163 0"/>
  </svg>
);
const IconPresentation = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
    <path d="M13.998 9.088v1.823l3.254 2.366V6.722zm4.584 4.268c0 .988-1.052 1.586-1.886 1.145l-.163-.102-2.545-1.85q-.006.306-.026.564c-.033.4-.098.762-.242 1.098l-.067.143c-.265.52-.669.957-1.165 1.26l-.217.123c-.377.192-.784.27-1.242.308-.45.037-1.007.036-1.696.036H6.5c-.69 0-1.246.001-1.696-.036-.401-.033-.762-.098-1.098-.242l-.143-.066a3.17 3.17 0 0 1-1.261-1.165l-.122-.218c-.192-.377-.271-.783-.309-1.241-.037-.45-.036-1.008-.036-1.697V8.583c0-.689 0-1.246.036-1.696.038-.458.117-.864.309-1.24l.122-.219c.304-.496.74-.9 1.261-1.165l.143-.066c.336-.145.697-.21 1.098-.243.45-.036 1.007-.036 1.696-.036h2.833c.689 0 1.246 0 1.696.036.458.038.865.117 1.242.309l.217.122c.496.304.9.74 1.165 1.262l.067.142c.144.337.21.697.242 1.098q.02.258.026.564l2.545-1.85.163-.103c.834-.44 1.886.158 1.886 1.146zm-15.417-1.94c0 .711.001 1.205.032 1.588.03.376.088.587.168.745l.07.127c.177.288.43.522.732.676l.13.056c.144.051.333.089.615.112.384.031.877.031 1.588.031h2.833c.71 0 1.204 0 1.588-.03.375-.032.587-.088.745-.169l.127-.071c.287-.176.522-.43.676-.732l.055-.13c.052-.143.09-.333.113-.615.031-.383.031-.877.031-1.588V8.583c0-.71 0-1.204-.031-1.588a2.4 2.4 0 0 0-.113-.615l-.055-.13a1.84 1.84 0 0 0-.676-.731l-.127-.07c-.158-.08-.37-.138-.745-.168-.384-.032-.877-.033-1.588-.033H6.5c-.711 0-1.204.001-1.588.033-.282.023-.471.06-.615.11l-.13.058a1.84 1.84 0 0 0-.731.675l-.07.126c-.081.158-.138.37-.169.745-.031.384-.032.877-.032 1.588z"/>
  </svg>
);

/* ── Inline SVG icons (no original equivalent) ── */
const IconSearch = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const IconFormat = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
    <path d="M15.668 3.516A2.33 2.33 0 0 1 18 5.848v8.333a2.333 2.333 0 0 1-2.332 2.332h-.833a.666.666 0 0 1 0-1.33h.833c.553 0 1.002-.45 1.002-1.002V5.848c0-.554-.449-1.002-1.002-1.002h-.833a.665.665 0 0 1 0-1.33zM5.299 3.516a.665.665 0 0 1 0 1.302l-.134.014h-.833c-.553 0-1.002.449-1.002 1.002v8.333c0 .553.449 1.002 1.002 1.002h.833l.134.014a.665.665 0 0 1 0 1.302l-.134.014h-.833A2.333 2.333 0 0 1 2 14.167V5.834a2.33 2.33 0 0 1 2.332-2.332h.833zM7.083 9.752c.367 0 .665.298.665.665V12a.665.665 0 0 1-1.33 0v-1.583c0-.367.298-.665.665-.665M10 7.335c.367 0 .665.298.665.665v4a.665.665 0 0 1-1.33 0V8c0-.367.298-.665.665-.665M12.916 8.918c.367 0 .665.298.665.665V12a.665.665 0 0 1-1.33 0V9.583c0-.367.298-.665.665-.665"/>
  </svg>
);

const IconNewNote = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="12" y1="11" x2="12" y2="17" />
    <line x1="9" y1="14" x2="15" y2="14" />
  </svg>
);

const IconTOC = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
    <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
  </svg>
);

const IconExport = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

const IconSettings = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const IconEditor = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

function ToolbarButton({ onClick, active, title, disabled, children }: {
  onClick: () => void; active?: boolean; title: string; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      title={title}
      className="rounded flex items-center justify-center btn-hover-transition"
      style={{
        width: '28px',
        height: '28px',
        color: active ? 'var(--accent-icon)' : 'var(--toolbar-icon-inactive)',
        backgroundColor: 'transparent',
        opacity: disabled ? 0.35 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
      onMouseEnter={(e) => {
        if (!active && !disabled) {
          e.currentTarget.style.color = 'var(--toolbar-icon)';
          e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)';
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.color = 'var(--toolbar-icon-inactive)';
          e.currentTarget.style.backgroundColor = 'transparent';
        }
      }}
    >
      {children}
    </button>
  );
}

function Toolbar({ onOpenSettings, onTogglePresentation, onToggleExport, showExport, onFormat, onNewNote }: {
  onOpenSettings: () => void;
  onTogglePresentation: () => void;
  onToggleExport: () => void;
  showExport: boolean;
  onFormat: () => void;
  onNewNote: () => void;
}) {
  const { t } = useTranslation();
  const { config } = useSettingsStore();
  // 窄订阅：全量订阅会包含 editorScrollLine，导致滚动时工具栏逐帧重渲染
  const viewMode = useEditorStore((s) => s.viewMode);
  const setViewMode = useEditorStore((s) => s.setViewMode);
  const showToc = useEditorStore((s) => s.showToc);
  const toggleToc = useEditorStore((s) => s.toggleToc);
  const activeNotePath = useNotesStore((s) => s.activeNote?.path);
  const isPdfActive = !!activeNotePath && isPdfPath(activeNotePath);
  const { updateConfig } = useSettingsStore();

  const toggleSidebar = () => {
    updateConfig({ show_sidebar: !config.show_sidebar });
  };

  return (
    <div
      className="h-[40px] flex items-center select-none"
      style={{ backgroundColor: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)' }}
    >
      {/* 左侧拖动区 - macOS 交通灯空间 */}
      <div className="w-20 h-full" data-tauri-drag-region onMouseDown={() => getCurrentWindow().startDragging()} />

      {/* 中间拖动区 - 弹性扩展填满剩余空间 */}
      <div className="flex-1 h-full" data-tauri-drag-region onMouseDown={() => getCurrentWindow().startDragging()} />

      {/* 右侧按钮组 - 不设置 drag-region */}
      {/* Order mirrors original MiaoYan: List → Format → Split → Preview → Presentation */}
      <div className="flex items-center gap-0.5 px-2 flex-shrink-0">
        <ToolbarButton onClick={toggleSidebar} active={config.show_sidebar} title={`${t('toolbar.toggleSidebar')} (Cmd+1)`}>
          <IconSidebar />
        </ToolbarButton>
        <span className="w-px h-4 mx-1" style={{ backgroundColor: 'var(--border)' }} />
        <ToolbarButton onClick={onFormat} title={`${t('toolbar.format')} (Cmd+Shift+L)`} disabled={isPdfActive}>
          <IconFormat />
        </ToolbarButton>
        <ToolbarButton onClick={() => setViewMode(viewMode === 'split' ? 'editor' : 'split')} active={viewMode === 'split'} title={t('toolbar.split')} disabled={isPdfActive}>
          <IconSplit />
        </ToolbarButton>
        <ToolbarButton onClick={() => setViewMode('preview')} active={viewMode === 'preview'} title={`${t('toolbar.view')} (Cmd+3)`} disabled={isPdfActive}>
          <IconPreview />
        </ToolbarButton>
        <span className="w-px h-4 mx-1" style={{ backgroundColor: 'var(--border)' }} />
        <ToolbarButton onClick={toggleToc} active={showToc} title={t('toolbar.toc')} disabled={isPdfActive}>
          <IconTOC />
        </ToolbarButton>
        <ToolbarButton onClick={onTogglePresentation} title={`${t('toolbar.presentation')} (Cmd+4)`} disabled={isPdfActive}>
          <IconPresentation />
        </ToolbarButton>
        <ToolbarButton onClick={onToggleExport} title={`${t('toolbar.export')} (Cmd+Shift+E)`} disabled={isPdfActive}>
          <IconExport />
        </ToolbarButton>
        <ToolbarButton onClick={onOpenSettings} title={`${t('toolbar.settings')} (Cmd+,)`}>
          <IconSettings />
        </ToolbarButton>
      </div>
    </div>
  );
}

function EditorPane() {
  const { t } = useTranslation();
  // 窄订阅：同上，避免 editorScrollLine 逐帧触发整个编辑区重渲染
  const viewMode = useEditorStore((s) => s.viewMode);
  const showToc = useEditorStore((s) => s.showToc);
  const toggleToc = useEditorStore((s) => s.toggleToc);
  const activeNote = useNotesStore((s) => s.activeNote);
  const isPdfActive = !!activeNote && isPdfPath(activeNote.path);
  const { config } = useSettingsStore();
  const [showBacklinks, setShowBacklinks] = useState(false);

  const handleTocNavigate = (line: number) => {
    // Always try to scroll the editor (works in editor/split modes)
    window.dispatchEvent(new CustomEvent('editor-scroll-to-line', { detail: { line } }));
    // Also directly scroll preview iframe (needed in preview mode where editor is hidden)
    const iframe = document.querySelector('iframe[src="/preview.html"]') as HTMLIFrameElement;
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'scrollToLine', line }, '*');
    }
  };

  useEffect(() => {
    const handler = () => setShowBacklinks((v) => !v);
    window.addEventListener('toggle-backlinks', handler);
    return () => window.removeEventListener('toggle-backlinks', handler);
  }, []);

  const handleBacklinkNavigate = (path: string) => {
    const notes = useNotesStore.getState().notes;
    const target = notes.find((n) => n.path === path);
    if (target) {
      useNotesStore.getState().selectNote(target);
    }
  };

  return (
    <div className="h-full flex flex-col relative">
      <TabBar />
      <SaveFailureBanner />
      <div className="flex-1 relative min-h-0 overflow-hidden">
        <Suspense fallback={<div role="status" className="h-full flex items-center justify-center" style={{ color: 'var(--text-secondary)' }}>{t('app.loading')}</div>}>
        {!activeNote ? (
          <div className="h-full flex items-center justify-center" style={{ color: 'var(--text-tertiary)' }}>{t('editor.selectNote')}</div>
        ) : isPdfActive ? (
          <div className="h-full">
            <PdfViewer key={activeNote!.path} path={activeNote!.path} />
          </div>
        ) : viewMode === 'split' ? (
          <Allotment>
            <Allotment.Pane minSize={300}>
              <Editor />
            </Allotment.Pane>
            <Allotment.Pane minSize={300}>
              <Preview />
            </Allotment.Pane>
          </Allotment>
        ) : viewMode === 'preview' ? (
          <div className="h-full">
            <Preview />
          </div>
        ) : (
          <div className="h-full">
            <Editor />
          </div>
        )}
        </Suspense>
        {showToc && !isPdfActive && <TableOfContents onNavigate={handleTocNavigate} onClose={toggleToc} />}
      </div>
      <Backlinks
        noteTitle={activeNote?.title || ''}
        rootPath={config.storage_path}
        onNavigate={handleBacklinkNavigate}
        visible={showBacklinks && !isPdfActive}
      />
    </div>
  );
}

function WelcomeScreen() {
  const { t } = useTranslation();
  const { updateConfig, retrySave, saveStatus, saveError } = useSettingsStore();

  const handleSelectFolder = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: 'Select notes folder' });
      if (selected) {
        await updateConfig({ storage_path: selected as string });
      }
    } catch (e) {
      console.error('Failed to select folder:', e);
    }
  };

  return (
    <div className="h-screen flex items-center justify-center" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <div className="text-center">
        <h1 className="text-3xl font-light mb-2" style={{ color: 'var(--text-primary)' }}>MiaoYan</h1>
        <p className="mb-6" style={{ color: 'var(--text-secondary)' }}>A lightweight Markdown editor</p>
        <button
          onClick={handleSelectFolder}
          disabled={saveStatus === 'saving'}
          className="px-6 py-2 text-white rounded-lg transition-colors"
          style={{ backgroundColor: 'var(--accent)' }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--accent-hover)')}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'var(--accent)')}
        >
          {saveStatus === 'saving' ? t('settings.saving') : t('app.selectFolder')}
        </button>
        {saveError && <div role="alert" className="mt-4 max-w-lg space-y-2 text-sm" style={{ color: 'var(--text-primary)' }}>
          <p>{t('settings.saveFailed')}</p>
          <p className="break-all">{saveError}</p>
          <button className="rounded border px-3 py-1" disabled={saveStatus === 'saving'} onClick={() => void retrySave()}>{t('settings.retrySave')}</button>
        </div>}
      </div>
    </div>
  );
}

// 路径归一化比较：统一为 / 并小写（资源管理器传入 / 配置存储 / 拖拽来源的分隔符与盘符大小写可能不一致）
const normPath = (p: string) => p.replace(/\\/g, '/').toLowerCase();

// WebView2 合成残影缓解：窗口缩放/最小化恢复等事件后旧帧可能残留屏幕（重影），
// 瞬时改变根节点 opacity 强制全屏合成重绘以清除残影
function forceRepaint() {
  const el = document.documentElement;
  el.style.opacity = '0.99';
  requestAnimationFrame(() => { el.style.opacity = ''; });
}

function showToastEvent(message: string, busy = false, type: ToastType = 'success') {
  window.dispatchEvent(new CustomEvent('show-toast', { detail: { message, busy, type } }));
}

// 判断文件是否已在文库内（主库或任一额外文件夹之下）
function isInsideLibrary(path: string): boolean {
  const cfg = useSettingsStore.getState().config;
  const np = normPath(path);
  const roots = [cfg.storage_path, ...(cfg.extra_folders || [])].filter(Boolean).map(normPath);
  return roots.some(r => np === r || np.startsWith(r + '/'));
}

// 把外部文件夹纳入文库：长驻进度 Toast + 实时显示已扫描文件数（Rust 单文件夹扫描每 200 个发一次事件）
async function importExternalFolder(folder: string, isCurrent = () => true): Promise<boolean> {
  if (!isCurrent()) return false;
  const cfg = useSettingsStore.getState().config;
  if (cfg.extra_folders.some(f => normPath(f) === normPath(folder))) return false;
  const scanId = crypto.randomUUID();
  let unlisten: (() => void) | undefined;
  try {
    unlisten = await listen<ScanEvent<number>>('miaoyan://scan-progress', (e) => {
      const current = useSettingsStore.getState().config;
      if (e.payload.scan_id === scanId && isCurrent() && isCurrentScan(scanId, 'progress', current.storage_path, current.extra_folders)) {
        showToastEvent(i18n.t('toast.importingProgress', { count: e.payload.data }), true);
      }
    });
  } catch { /* 监听失败仅退化为无计数 */ }
  try {
    if (!isCurrent()) return false;
    const settings = useSettingsStore.getState();
    const current = settings.draftConfig ?? settings.config;
    if (current.extra_folders.some(f => normPath(f) === normPath(folder))) return false;
    showToastEvent(i18n.t('toast.importingFolder'), true);
    const saved = await useSettingsStore.getState().updateConfig({ extra_folders: [...current.extra_folders, folder] });
    if (!saved || !isCurrent()) return false;
    // 增量导入：只扫新文件夹（chunk 事件自动并入树），不重扫全库
    await scanFolder(folder, scanId);
    const scope = useSettingsStore.getState().config;
    if (!isCurrent() || !isCurrentScan(scanId, 'progress', scope.storage_path, scope.extra_folders)) return false;
    showToastEvent(i18n.t('toast.importDone'), false);
    return true;
  } catch (error) {
    const scope = useSettingsStore.getState().config;
    if (!isCurrent() || !isCurrentScan(scanId, 'progress', scope.storage_path, scope.extra_folders)) return false;
    throw error;
  } finally {
    unlisten?.();
  }
}

// 外部 .md 文件打开：已在树内的文件秒开（不重扫全库）；树外文件先秒开文件，再带进度导入父文件夹（复用拖拽逻辑）
async function openExternalFile(rawPath: string) {
  const path = rawPath.replace(/\\/g, '/'); // 保留实际文件名大小写，比较时才归一化
  const folder = path.substring(0, path.lastIndexOf('/'));
  const requestId = await useNotesStore.getState().openTemporaryFile(path, 'preview');
  if (requestId === null) return;
  const isCurrent = () => useNotesStore.getState().isCurrentOpen(requestId);
  if (!isCurrent() || !folder) return;
  if (!isInsideLibrary(path)) {
    const imported = await importExternalFolder(folder, isCurrent);
    if (!isCurrent() || !imported) return;
  }
  const storage = useSettingsStore.getState().config.storage_path;
  const store = useNotesStore.getState();
  // Revealing the folder replaces the tree; keep an active search instead of
  // silently dropping it when a file is opened from outside the tree.
  if (!store.searchQuery.trim()) await store.setActiveFolder(folder, storage, requestId);
}

export default function App() {
  const { t } = useTranslation();
  const { loaded, loadError, loadConfig } = useSettingsStore();
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    let mounted = true;
    void loadConfig().then(() => { if (mounted) setInitialized(true); });
    return () => { mounted = false; };
  }, [loadConfig]);

  if (!initialized || !loaded) {
    return <div role="status" className="h-screen flex items-center justify-center" style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-secondary)' }}>{t('app.loading')}</div>;
  }
  if (loadError) {
    return <div className="h-screen flex items-center justify-center p-8" style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
      <div role="alert" className="max-w-xl space-y-4">
        <h1 className="text-lg font-medium">{t('app.configLoadFailed')}</h1>
        <p>{t('app.configPreserved')}</p>
        <p className="text-sm break-all" style={{ color: 'var(--text-secondary)' }}>{loadError}</p>
        <button className="rounded px-4 py-2" style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)' }} onClick={() => void loadConfig()}>{t('app.retryConfig')}</button>
      </div>
    </div>;
  }
  return <AppContent />;
}

function AppContent() {
  const { t } = useTranslation();
  const { config, loaded, storageRevision } = useSettingsStore();
  const loadProjects = useNotesStore((s) => s.loadProjects);
  const loadNotes = useNotesStore((s) => s.loadNotes);
  const closing = useNotesStore((s) => s.closing);
  const [themeClass, setThemeClass] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showPresentation, setShowPresentation] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [toastVisible, setToastVisible] = useState(false);
  const [toastBusy, setToastBusy] = useState(false);
  const [toastType, setToastType] = useState<ToastType>('success');

  // Listen for global show-toast events (from Preview, iframe, etc.)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const msg = typeof detail === 'string' ? detail : detail?.message;
      if (msg) {
        setToastMessage(msg);
        setToastBusy(typeof detail === 'object' && !!detail?.busy);
        setToastType(typeof detail === 'object' && detail?.type === 'warning' ? 'warning' : 'success');
        setToastVisible(true);
      }
    };
    window.addEventListener('show-toast', handler);
    return () => window.removeEventListener('show-toast', handler);
  }, []);
  // Drain sessions before native destroy; errors (including ACL denial) retain
  // the window. Never recursively call close() or bypass the native permissions.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const appWindow = getCurrentWindow();
    const handleClose = createDocumentCloseHandler(async () => {
      await flushLogs();
      if (!disposed) await appWindow.destroy();
    });
    appWindow.onCloseRequested(event => {
      if (disposed) { event.preventDefault(); return; }
      return handleClose(event);
    }).then(fn => {
      if (disposed) fn();
      else unlisten = fn;
    }).catch(error => {
      showToastEvent(`无法监听窗口关闭 / Close listener unavailable: ${String(error)}`, false, 'warning');
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<OperationWarning[]>('document-operation-warning', event => {
      showToastEvent(event.payload.map(warning => `${warning.message}: ${warning.path}`).join('\n'), false, 'warning');
      window.dispatchEvent(new CustomEvent('document-recovery-refresh'));
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(console.error);
    return () => { disposed = true; unlisten?.(); };
  }, []);


  const formatInFlight = useRef(new Set<number>());
  const handleFormat = async () => {
    const store = useNotesStore.getState();
    const note = store.activeNote;
    if (!note || isPdfPath(note.path) || /\.(html|htm)$/i.test(note.path)) return;
    const session = store.getDocumentSession(note.path);
    if (!session?.content || formatInFlight.current.has(session.identity)) return;
    const messages = formatMessages[useSettingsStore.getState().config.language] ?? formatMessages.en;
    formatInFlight.current.add(session.identity);
    showToastEvent(`${messages.busy}: ${note.title}`, true);
    try {
      const formatted = await formatMarkdown(session.content);
      if (!store.updateDocumentContent(note.path, formatted, session.revision)) {
        showToastEvent(`${messages.changed}: ${note.title}`, false, 'warning');
        return;
      }
      showToastEvent(`${messages.done}: ${note.title}`);
    } catch (error) {
      showToastEvent(`${messages.failed}: ${String(error)}`, false, 'warning');
    } finally {
      formatInFlight.current.delete(session.identity);
    }
  };

  const handleNewNote = async () => {
    const { createDocument } = useNotesStore.getState();
    const folder = useNotesStore.getState().creationParent();
    if (!folder) return;
    try {
      const created = await createDocument(folder, `Untitled-${Date.now()}`);
      if (!created || created.requestId === null || !useNotesStore.getState().isCurrentOpen(created.requestId)) return;
      // Enter inline rename on the new note once its row appears in the tree
      window.dispatchEvent(new CustomEvent('sidebar-rename-note'));
    } catch (e) { console.error('Failed to create note:', e); }
  };

  function handleDeepLink(url: string) {
    try {
      const parsed = new URL(url);
      const action = parsed.hostname;
      const params = parsed.searchParams;
      const store = useNotesStore.getState();
      const settingsStore = useSettingsStore.getState();
      const storagePath = settingsStore.config.storage_path;

      switch (action) {
        case 'open': {
          const title = params.get('title');
          if (title && storagePath) {
            const target = store.notes.find(n => n.title.toLowerCase() === title.toLowerCase());
            if (target) {
              store.selectNote(target);
            }
          }
          break;
        }
        case 'new': {
          const newTitle = params.get('title') || 'Untitled';
          const content = params.get('content') || '';
          const folder = store.activeFolder || storagePath;
          if (folder) {
            store.createDocument(folder, newTitle, content)
              .catch(e => console.error('Deep-link: failed to create note:', e));
          }
          break;
        }
        case 'search': {
          const query = params.get('q');
          if (query && storagePath) {
            store.setSearchQuery(query, storagePath);
            // Ensure sidebar is visible
            if (!settingsStore.config.show_sidebar) {
              settingsStore.updateConfig({ show_sidebar: true });
            }
          }
          break;
        }
      }
    } catch (e) {
      console.error('Failed to handle deep link:', e);
    }
  }

  // 清理 extra_folders 历史遗留的空字符串条目（旧版对反斜杠拖拽路径误写入 ''）
  useEffect(() => {
    if (!loaded) return;
    const folders = useSettingsStore.getState().config.extra_folders || [];
    if (folders.some(f => !f)) {
      useSettingsStore.getState().updateConfig({ extra_folders: folders.filter(Boolean) });
    }
  }, [loaded]);

  // WebView2 合成残影清理：窗口缩放 / 从后台恢复时强制重绘一次
  useEffect(() => {
    // 启动首帧完成后也强制重绘，清除启动期陈旧帧（工具栏缺失/重影）
    forceRepaint();
    const t = setTimeout(forceRepaint, 800);
    const onVisible = () => { if (document.visibilityState === 'visible') forceRepaint(); }
    window.addEventListener('resize', forceRepaint);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(t);
      window.removeEventListener('resize', forceRepaint);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const applyTheme = () => {
      if (config.theme === 'dark') setThemeClass('dark');
      else if (config.theme === 'light') setThemeClass('');
      else setThemeClass(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : '');
    };
    applyTheme();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => { if (config.theme === 'system') applyTheme(); };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [config.theme, loaded]);

  useEffect(() => {
    if (config.language && config.language !== i18n.language) {
      i18n.changeLanguage(config.language);
    }
  }, [config.language]);

  useEffect(() => {
    if (config.storage_path) {
      loadProjects(config.storage_path);
      loadNotes(config.storage_path);
    }
  }, [config.storage_path, storageRevision]);

  // Apply always_on_top on startup or config change
  useEffect(() => {
    if (loaded) {
      setAlwaysOnTop(config.always_on_top).catch(console.error);
    }
  }, [config.always_on_top, loaded]);

  // 窗口级文件拖放
  const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico',
    '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.flac',
    '.zip', '.tar', '.gz', '.rar', '.7z',
    '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.exe', '.dmg', '.app', '.dylib', '.so', '.dll',
  ]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type === 'drop') {
        const paths = [...new Set(event.payload.paths)];
        log(`Drop paths: ${JSON.stringify(paths)}`);
        for (const path of paths) {
          try {
            log(`Processing path: ${path}`);
            const info = await stat(path);
            log(`stat result: isDirectory=${info.isDirectory}`);
            if (info.isDirectory) {
              const imported = await importExternalFolder(path);
              if (imported) {
                log(`Added extra folder: ${path}`);
              }
            } else {
              const dotIdx = path.lastIndexOf('.');
              const ext = dotIdx >= 0 ? path.substring(dotIdx).toLowerCase() : '';
              if (ext && BINARY_EXTENSIONS.has(ext)) {
                setToastMessage(t('toast.unsupportedFile'));
                setToastType('warning');
                setToastVisible(true);
                log(`Unsupported binary file: ${path}`);
              } else {
                await openExternalFile(path);
                log(`Opened dropped file: ${path}`);
              }
            }
          } catch (e) {
            log(`Drop error for ${path}: ${e}`);
            console.error('Drop handling error:', e);
          }
        }
      }
    }).then(fn => { unlisten = fn; log('DragDrop listener registered'); }).catch(e => { log(`DragDrop listener registration FAILED: ${e}`); });
    return () => { unlisten?.(); };
  }, []);

  // 文件关联打开：冷启动参数 + 单实例转发（双击 .md 文件）
  useEffect(() => {
    if (!loaded) return;
    let unlisten: (() => void) | undefined;
    const processPending = async () => {
      forceRepaint(); // 单实例唤起窗口时旧帧可能未失效，强制重绘
      try {
        const paths = await getPendingOpenFiles();
        for (const path of paths) {
          try {
            const info = await stat(path);
            if (info.isDirectory) continue;
            await openExternalFile(path);
            log(`Opened file from association: ${path}`);
          } catch (e) {
            log(`Failed to open associated file ${path}: ${e}`);
          }
        }
      } catch (e) {
        console.error('Failed to get pending open files:', e);
      }
    };
    processPending();
    listen('miaoyan://open-files', processPending)
      .then((fn) => { unlisten = fn; })
      .catch((e) => console.error('Failed to listen open-files event:', e));
    return () => { unlisten?.(); };
  }, [loaded]);

  // Deep-link handler
  useEffect(() => {
    const unlisten = onOpenUrl((urls) => {
      for (const url of urls) {
        handleDeepLink(url);
      }
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const { title } = (e as CustomEvent).detail;
      const notes = useNotesStore.getState().notes;
      const target = notes.find(n => n.title.toLowerCase() === title.toLowerCase());
      if (target) useNotesStore.getState().selectNote(target);
    };
    window.addEventListener('wikilink-navigate', handler);
    return () => window.removeEventListener('wikilink-navigate', handler);
  }, []);

  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      if (useNotesStore.getState().closing) { e.preventDefault(); return; }
      const mod = e.metaKey || e.ctrlKey;
      const pdfActivePath = useNotesStore.getState().activeNote?.path;
      const pdfActive = !!pdfActivePath && isPdfPath(pdfActivePath);
      if (mod && e.key === '1') {
        e.preventDefault();
        const cfg = useSettingsStore.getState().config;
        useSettingsStore.getState().updateConfig({ show_sidebar: !cfg.show_sidebar });
      }
      if (mod && e.key === 'n' && !e.shiftKey) { e.preventDefault(); handleNewNote(); }
      if (mod && e.key === '3' && !pdfActive) { e.preventDefault(); const { viewMode, setViewMode } = useEditorStore.getState(); setViewMode(viewMode === 'preview' ? 'split' : 'preview'); }
      if (mod && e.key === '4' && !pdfActive) { e.preventDefault(); setShowPresentation(p => !p); }
      if (mod && e.key === '\\' && !pdfActive) { e.preventDefault(); const { viewMode, setViewMode } = useEditorStore.getState(); const modes: ViewMode[] = ['editor', 'split', 'preview']; const idx = modes.indexOf(viewMode); setViewMode(modes[(idx + 1) % modes.length]); }
      if (mod && e.key === 'i' && e.altKey) { e.preventDefault(); window.dispatchEvent(new CustomEvent('toggle-backlinks')); }
      if (mod && e.key === ',') { e.preventDefault(); setShowSettings(true); }
      if (mod && e.key === 'e' && e.shiftKey && !pdfActive) { e.preventDefault(); setShowExport(p => !p); }
      if (mod && e.key === 'l' && e.shiftKey) {
        e.preventDefault();
        if (!pdfActive) handleFormat();
      }
      // Cmd/Ctrl+S: explicitly retry/drain the active document's save queue.
      if (mod && !e.shiftKey && e.key === 's') {
        e.preventDefault();
        void useNotesStore.getState().saveCurrentNote();
      }
      // Cmd+W: close active tab
      if (mod && !e.shiftKey && e.key === 'w') {
        e.preventDefault();
        const { activeTabPath, closeTab } = useNotesStore.getState();
        if (activeTabPath) closeTab(activeTabPath);
      }
      // Ctrl+Tab: switch to next tab
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        const { openTabs, activeTabPath, switchTab } = useNotesStore.getState();
        if (openTabs.length < 2) return;
        const idx = openTabs.findIndex(t => t.path === activeTabPath);
        const nextIdx = e.shiftKey ? (idx - 1 + openTabs.length) % openTabs.length : (idx + 1) % openTabs.length;
        switchTab(openTabs[nextIdx].path);
      }
      // Cmd+F: PDF 内搜索 / 侧边栏搜索
      if (mod && !e.shiftKey && e.key === 'f') {
        e.preventDefault();
        if (pdfActive) {
          window.dispatchEvent(new CustomEvent('pdf-focus-search'));
          return;
        }
        // Ensure sidebar is visible
        if (!useSettingsStore.getState().config.show_sidebar) {
          useSettingsStore.getState().updateConfig({ show_sidebar: true });
        }
        window.dispatchEvent(new CustomEvent('sidebar-focus-search'));
      }
      // Cmd+Shift+N: create new folder
      if (mod && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        const name = prompt('New folder name:');
        if (!name) return;
        const parent = useNotesStore.getState().creationParent();
        if (!parent) return;
        try {
          await useNotesStore.getState().withDocumentPathChange(`${parent}/${name}`, true, async () => {
            const newPath = await createFolder(parent, name);
            // 本地插行，避免为新增一个空目录触发全库重扫
            window.dispatchEvent(new CustomEvent('folder-created', { detail: { path: newPath } }));
          });
        } catch (err) { console.error('Failed to create folder:', err); }
      }
      // Cmd+R: rename active note
      if (mod && !e.shiftKey && e.key === 'r') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('sidebar-rename-note'));
      }
      // Cmd+D: duplicate active note
      if (mod && !e.shiftKey && e.key === 'd') {
        e.preventDefault();
        const storagePath = useSettingsStore.getState().config.storage_path;
        await useNotesStore.getState().duplicateNote(storagePath);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [config.language]);

  if (!loaded) {
    return (
      <div className="h-screen flex items-center justify-center" style={{ backgroundColor: 'var(--bg-primary)' }}>
        <span style={{ color: 'var(--text-tertiary)' }}>Loading...</span>
      </div>
    );
  }

  if (!config.storage_path) {
    return <div className={themeClass}><WelcomeScreen /></div>;
  }

  return (
    <div inert={closing !== null} className={`h-screen flex flex-col ${themeClass}`} style={{ backgroundColor: 'var(--bg-primary)' }}>
      <Toolbar
        onOpenSettings={() => setShowSettings(true)}
        onTogglePresentation={() => setShowPresentation(true)}
        onToggleExport={() => setShowExport(p => !p)}
        showExport={showExport}
        onFormat={handleFormat}
        onNewNote={handleNewNote}
      />
      <RecoveryBanner />
      <div className="flex-1 overflow-hidden relative">
        <Allotment>
          <Allotment.Pane minSize={160} preferredSize={220} maxSize={350} visible={config.show_sidebar}>
            <UnifiedTree />
          </Allotment.Pane>
          <Allotment.Pane minSize={400}>
            <EditorPane />
          </Allotment.Pane>
        </Allotment>
        {showExport && <ExportMenu onClose={() => setShowExport(false)} showToast={(msg) => { setToastMessage(msg); setToastType('success'); setToastVisible(true); }} />}
      </div>
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {showPresentation && <PresentationMode onClose={() => setShowPresentation(false)} />}
      <Toast message={toastMessage} visible={toastVisible} busy={toastBusy} type={toastType} onClose={() => setToastVisible(false)} />
    </div>
  );
}

