import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Allotment } from 'allotment';
import 'allotment/dist/style.css';
import { Editor } from './components/editor/Editor';
import { Preview } from './components/preview/Preview';
import { SettingsDialog } from './components/settings/SettingsDialog';
import { PresentationMode } from './components/presentation/PresentationMode';
import { TableOfContents } from './components/shared/TableOfContents';
import { ExportMenu } from './components/shared/ExportMenu';
import { CombinedSidebar } from './components/sidebar/CombinedSidebar';
import { useNotesStore } from './stores/notes-store';
import { useSettingsStore } from './stores/settings-store';
import { useEditorStore } from './stores/editor-store';
import type { ViewMode } from './stores/editor-store';
import { open } from '@tauri-apps/plugin-dialog';
import i18n from './i18n';

/* ── Original MiaoYan SVG Icons (inline for currentColor theme support) ── */
const IconSidebar = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
    <path d="M6.835 4c-.451.004-.82.012-1.137.038-.386.032-.659.085-.876.162l-.2.086c-.44.224-.807.564-1.063.982l-.103.184c-.126.247-.206.562-.248 1.076-.043.523-.043 1.19-.043 2.135v2.664c0 .944 0 1.612.043 2.135.042.515.122.829.248 1.076l.103.184c.256.418.624.758 1.063.982l.2.086c.217.077.49.13.876.162.316.026.685.034 1.136.038zm11.33 7.327c0 .922 0 1.654-.048 2.243-.043.522-.125.977-.305 1.395l-.082.177a4 4 0 0 1-1.473 1.593l-.276.155c-.465.237-.974.338-1.57.387-.59.048-1.322.048-2.244.048H7.833c-.922 0-1.654 0-2.243-.048-.522-.042-.977-.126-1.395-.305l-.176-.082a4 4 0 0 1-1.594-1.473l-.154-.275c-.238-.466-.34-.975-.388-1.572-.048-.589-.048-1.32-.048-2.243V8.663c0-.922 0-1.654.048-2.243.049-.597.15-1.106.388-1.571l.154-.276a4 4 0 0 1 1.594-1.472l.176-.083c.418-.18.873-.263 1.395-.305.589-.048 1.32-.048 2.243-.048h4.334c.922 0 1.654 0 2.243.048.597.049 1.106.15 1.571.388l.276.154a4 4 0 0 1 1.473 1.594l.082.176c.18.418.262.873.305 1.395.048.589.048 1.32.048 2.243zm-10 4.668h4.002c.944 0 1.612 0 2.135-.043.514-.042.829-.122 1.076-.248l.184-.103c.418-.256.758-.624.982-1.063l.086-.2c.077-.217.13-.49.162-.876.043-.523.043-1.19.043-2.135V8.663c0-.944 0-1.612-.043-2.135-.032-.386-.085-.659-.162-.876l-.086-.2a2.67 2.67 0 0 0-.982-1.063l-.184-.103c-.247-.126-.562-.206-1.076-.248-.523-.043-1.19-.043-2.135-.043H8.164L8.165 4z"/>
  </svg>
);
const IconSplit = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
    <path d="M8.502 17.5v-1.002H6.5c-.69 0-1.246 0-1.696-.036-.401-.033-.762-.098-1.098-.242l-.143-.067a3.17 3.17 0 0 1-1.261-1.165l-.122-.217c-.192-.377-.271-.784-.309-1.242-.037-.45-.036-1.007-.036-1.696V8.167c0-.689 0-1.246.036-1.696.038-.458.117-.865.309-1.242l.122-.217c.304-.496.74-.9 1.261-1.165l.143-.067c.336-.144.697-.21 1.098-.242.45-.037 1.007-.036 1.696-.036h2.002V2.5a.665.665 0 0 1 1.33 0v15a.665.665 0 0 1-1.33 0m8.333-5.667V8.167c0-.71 0-1.204-.032-1.588a2.4 2.4 0 0 0-.112-.615l-.056-.13a1.84 1.84 0 0 0-.676-.731l-.126-.072c-.158-.08-.37-.137-.745-.168-.384-.031-.877-.031-1.588-.031h-1a.665.665 0 0 1 0-1.33h1c.69 0 1.246 0 1.696.036.458.038.864.117 1.24.309l.22.122c.495.304.899.74 1.164 1.26l.067.143c.144.337.21.698.242 1.099.037.45.036 1.007.036 1.696v3.666c0 .689 0 1.246-.036 1.696-.033.401-.098.762-.242 1.099l-.067.143c-.265.52-.67.956-1.165 1.26l-.219.122c-.376.192-.782.271-1.24.309-.45.037-1.007.036-1.696.036h-1a.665.665 0 1 1 0-1.33h1c.711 0 1.204 0 1.588-.031.376-.031.587-.088.745-.168l.126-.071c.288-.177.522-.43.676-.732l.056-.13a2.4 2.4 0 0 0 .112-.615c.031-.384.032-.877.032-1.588m-13.67 0c0 .71.001 1.204.032 1.588.03.376.088.587.168.745l.07.127c.177.287.43.522.732.676l.13.055c.144.052.333.09.615.113.384.031.877.031 1.588.031h2.002V4.832H6.5c-.711 0-1.204 0-1.588.031a2.4 2.4 0 0 0-.615.113l-.13.055a1.84 1.84 0 0 0-.731.676l-.07.127c-.081.158-.138.37-.169.745-.031.384-.032.877-.032 1.588z"/>
  </svg>
);
const IconPreview = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
    <path d="M10 2.335c2.612 0 4.664 1.282 6.147 2.733 1.48 1.45 2.443 3.113 2.898 4.003l.098.225c.168.455.168.953 0 1.408l-.098.225c-.455.89-1.418 2.553-2.898 4.003-1.483 1.451-3.535 2.733-6.147 2.733s-4.665-1.282-6.147-2.733c-1.296-1.268-2.194-2.7-2.704-3.635l-.194-.368c-.3-.586-.3-1.272 0-1.858l.194-.368c.51-.935 1.408-2.367 2.704-3.635C5.335 3.617 7.388 2.335 10 2.335m0 1.33c-2.146 0-3.882 1.047-5.217 2.354C3.613 7.163 2.79 8.473 2.32 9.336l-.18.34a.7.7 0 0 0 0 .647l.18.341c.47.863 1.295 2.173 2.464 3.317 1.335 1.307 3.071 2.354 5.217 2.354s3.882-1.047 5.217-2.354c1.336-1.308 2.221-2.831 2.643-3.658l.035-.078c.059-.16.059-.33 0-.49l-.035-.078c-.422-.827-1.307-2.35-2.643-3.658S12.146 3.665 10 3.665M12.252 10a2.252 2.252 0 1 0-4.504 0 2.252 2.252 0 0 0 4.504 0m1.33 0a3.582 3.582 0 1 1-7.164 0 3.582 3.582 0 0 1 7.163 0"/>
  </svg>
);
const IconPresentation = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
    <path d="M13.998 9.088v1.823l3.254 2.366V6.722zm4.584 4.268c0 .988-1.052 1.586-1.886 1.145l-.163-.102-2.545-1.85q-.006.306-.026.564c-.033.4-.098.762-.242 1.098l-.067.143c-.265.52-.669.957-1.165 1.26l-.217.123c-.377.192-.784.27-1.242.308-.45.037-1.007.036-1.696.036H6.5c-.69 0-1.246.001-1.696-.036-.401-.033-.762-.098-1.098-.242l-.143-.066a3.17 3.17 0 0 1-1.261-1.165l-.122-.218c-.192-.377-.271-.783-.309-1.241-.037-.45-.036-1.008-.036-1.697V8.583c0-.689 0-1.246.036-1.696.038-.458.117-.864.309-1.24l.122-.219c.304-.496.74-.9 1.261-1.165l.143-.066c.336-.145.697-.21 1.098-.243.45-.036 1.007-.036 1.696-.036h2.833c.689 0 1.246 0 1.696.036.458.038.865.117 1.242.309l.217.122c.496.304.9.74 1.165 1.262l.067.142c.144.337.21.697.242 1.098q.02.258.026.564l2.545-1.85.163-.103c.834-.44 1.886.158 1.886 1.146zm-15.417-1.94c0 .711.001 1.205.032 1.588.03.376.088.587.168.745l.07.127c.177.288.43.522.732.676l.13.056c.144.051.333.089.615.112.384.031.877.031 1.588.031h2.833c.71 0 1.204 0 1.588-.03.375-.032.587-.088.745-.169l.127-.071c.287-.176.522-.43.676-.732l.055-.13c.052-.143.09-.333.113-.615.031-.383.031-.877.031-1.588V8.583c0-.71 0-1.204-.031-1.588a2.4 2.4 0 0 0-.113-.615l-.055-.13a1.84 1.84 0 0 0-.676-.731l-.127-.07c-.158-.08-.37-.138-.745-.168-.384-.032-.877-.033-1.588-.033H6.5c-.711 0-1.204.001-1.588.033-.282.023-.471.06-.615.11l-.13.058a1.84 1.84 0 0 0-.731.675l-.07.126c-.081.158-.138.37-.169.745-.031.384-.032.877-.032 1.588z"/>
  </svg>
);

/* ── Inline SVG icons (no original equivalent) ── */
const IconSearch = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const IconTOC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
    <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
  </svg>
);

const IconExport = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

const IconSettings = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const IconEditor = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

function ToolbarButton({ onClick, active, title, children }: {
  onClick: () => void; active?: boolean; title: string; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="rounded transition-colors flex items-center justify-center"
      style={{
        width: '28px',
        height: '28px',
        color: active ? 'var(--accent-icon)' : 'var(--toolbar-icon-inactive)',
      }}
      onMouseEnter={(e) => {
        if (!active) {
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

function Toolbar({ onOpenSettings, onTogglePresentation, onToggleExport, showExport }: {
  onOpenSettings: () => void;
  onTogglePresentation: () => void;
  onToggleExport: () => void;
  showExport: boolean;
}) {
  const { t } = useTranslation();
  const { config } = useSettingsStore();
  const { viewMode, setViewMode, showToc, toggleToc } = useEditorStore();
  const { updateConfig } = useSettingsStore();

  const toggleSidebar = () => {
    updateConfig({ show_sidebar: !config.show_sidebar });
  };

  return (
    <div
      className="h-10 flex items-center select-none"
      style={{ backgroundColor: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)' }}
      data-tauri-drag-region
    >
      {/* Left space - macOS traffic lights (~80px) + drag region */}
      <div className="flex-1" data-tauri-drag-region />

      {/* Right - all buttons, right-aligned */}
      <div className="flex items-center gap-0.5 px-2 flex-shrink-0">
        <ToolbarButton onClick={() => setViewMode('editor')} active={viewMode === 'editor'} title={`${t('toolbar.edit')} (Cmd+\\)`}>
          <IconEditor />
        </ToolbarButton>
        <ToolbarButton onClick={() => setViewMode('split')} active={viewMode === 'split'} title={t('toolbar.split')}>
          <IconSplit />
        </ToolbarButton>
        <ToolbarButton onClick={() => setViewMode('preview')} active={viewMode === 'preview'} title={`${t('toolbar.view')} (Cmd+3)`}>
          <IconPreview />
        </ToolbarButton>
        <span className="w-px h-4 mx-1" style={{ backgroundColor: 'var(--border)' }} />
        <ToolbarButton onClick={toggleToc} active={showToc} title={t('toolbar.toc')}>
          <IconTOC />
        </ToolbarButton>
        <ToolbarButton onClick={onTogglePresentation} title={`${t('toolbar.presentation')} (Cmd+4)`}>
          <IconPresentation />
        </ToolbarButton>
        <ToolbarButton onClick={onToggleExport} title={`${t('toolbar.export')} (Cmd+Shift+E)`}>
          <IconExport />
        </ToolbarButton>
        <ToolbarButton onClick={onOpenSettings} title={`${t('toolbar.settings')} (Cmd+,)`}>
          <IconSettings />
        </ToolbarButton>
        <span className="w-px h-4 mx-1" style={{ backgroundColor: 'var(--border)' }} />
        <ToolbarButton onClick={toggleSidebar} active={config.show_sidebar} title={`${t('toolbar.toggleSidebar')} (Cmd+1)`}>
          <IconSidebar />
        </ToolbarButton>
      </div>
    </div>
  );
}

function EditorPane() {
  const { viewMode, showToc, toggleToc } = useEditorStore();

  const handleTocNavigate = (line: number) => {
    // Always try to scroll the editor (works in editor/split modes)
    window.dispatchEvent(new CustomEvent('editor-scroll-to-line', { detail: { line } }));
    // Also directly scroll preview iframe (needed in preview mode where editor is hidden)
    const iframe = document.querySelector('iframe[src="/preview.html"]') as HTMLIFrameElement;
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'scrollToLine', line }, '*');
    }
  };

  return (
    <div className="h-full relative">
      {viewMode === 'split' ? (
        <Allotment>
          <Allotment.Pane minSize={300}>
            <Editor />
          </Allotment.Pane>
          <Allotment.Pane minSize={300}>
            <Preview />
          </Allotment.Pane>
        </Allotment>
      ) : viewMode === 'preview' ? (
        <Preview />
      ) : (
        <Editor />
      )}
      {showToc && <TableOfContents onNavigate={handleTocNavigate} onClose={toggleToc} />}
    </div>
  );
}

function WelcomeScreen() {
  const { updateConfig } = useSettingsStore();

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
          className="px-6 py-2 text-white rounded-lg transition-colors"
          style={{ backgroundColor: 'var(--accent)' }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--accent-hover)')}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'var(--accent)')}
        >
          Select Notes Folder
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const { config, loaded, loadConfig } = useSettingsStore();
  const { loadProjects, loadNotes } = useNotesStore();
  const [themeClass, setThemeClass] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showPresentation, setShowPresentation] = useState(false);
  const [showExport, setShowExport] = useState(false);

  useEffect(() => { loadConfig(); }, []);

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
  }, [config.storage_path]);

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
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === '1') { e.preventDefault(); useSettingsStore.getState().updateConfig({ show_sidebar: !useSettingsStore.getState().config.show_sidebar }); }
      if (mod && e.key === '3') { e.preventDefault(); const { viewMode, setViewMode } = useEditorStore.getState(); setViewMode(viewMode === 'preview' ? 'split' : 'preview'); }
      if (mod && e.key === '4') { e.preventDefault(); setShowPresentation(p => !p); }
      if (mod && e.key === '\\') { e.preventDefault(); const { viewMode, setViewMode } = useEditorStore.getState(); const modes: ViewMode[] = ['editor', 'split', 'preview']; const idx = modes.indexOf(viewMode); setViewMode(modes[(idx + 1) % modes.length]); }
      if (mod && e.key === ',') { e.preventDefault(); setShowSettings(true); }
      if (mod && e.key === 'e' && e.shiftKey) { e.preventDefault(); setShowExport(p => !p); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

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
    <div className={`h-screen flex flex-col ${themeClass}`} style={{ backgroundColor: 'var(--bg-primary)' }}>
      <Toolbar
        onOpenSettings={() => setShowSettings(true)}
        onTogglePresentation={() => setShowPresentation(true)}
        onToggleExport={() => setShowExport(p => !p)}
        showExport={showExport}
      />
      <div className="flex-1 overflow-hidden relative">
        <Allotment>
          {config.show_sidebar && (
            <Allotment.Pane minSize={200} preferredSize={260} maxSize={380}>
              <CombinedSidebar />
            </Allotment.Pane>
          )}
          <Allotment.Pane minSize={400}>
            <EditorPane />
          </Allotment.Pane>
        </Allotment>
        {showExport && <ExportMenu onClose={() => setShowExport(false)} />}
      </div>
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {showPresentation && <PresentationMode onClose={() => setShowPresentation(false)} />}
    </div>
  );
}
