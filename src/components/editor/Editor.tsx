import { useEffect, useRef, useState, useCallback } from 'react';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { languages } from '@codemirror/language-data';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
import { searchKeymap } from '@codemirror/search';
import { useNotesStore } from '../../stores/notes-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useEditorStore } from '../../stores/editor-store';
import { renameNote } from '../../services/tauri-bridge';
import { smartListKeymap } from './extensions/smart-lists';
import { textFormattingKeymap, wrapSelection, toggleUnorderedList, toggleOrderedList, toggleTodoList, insertLink, insertImage, insertCodeBlock } from './extensions/text-formatting';
import { tabSnippets } from './extensions/tab-snippets';
import { wikilinks } from './extensions/wikilink';
import { imagePasteExtension } from './extensions/image-paste';
import { perfReport } from '../../services/perf';
import { imagePreviewExtension } from './extensions/image-preview';
import { ContextMenu } from './ContextMenu';

const themeCompartment = new Compartment();
const langCompartment = new Compartment();

function getEditorTheme(isDark: boolean, config: { line_height: number; line_spacing: number; letter_spacing: number }) {
  // CodeMirror 官方文档：非零 letter-spacing 会强制行布局逐词测量宽度，
  // 大文档 + 折行下每次输入/滚动都显著变慢。排版收益（默认 0.5px 几乎
  // 不可见）远小于性能损失，故编辑器内始终不设置该属性；设置项保留，
  // 仅在值大于 0 时提示用户
  const contentStyle: Record<string, string> = {
    fontFamily: "'TsangerJinKai02', -apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", sans-serif",
    padding: '16px 0',
    caretColor: isDark ? '#E8E8EB' : '#262626',
  };
  return EditorView.theme({
    '&': {
      height: '100%',
      fontSize: '16px',
      color: isDark ? '#E8E8EB' : '#262626',
      backgroundColor: isDark ? '#232832' : '#FFFFFF',
    },
    '.cm-content': contentStyle,
    '.cm-line': {
      padding: `0 20px ${config.line_spacing}px 20px`,
      lineHeight: String(config.line_height),
    },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      border: 'none',
      color: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.12)',
      fontSize: '11px',
      paddingRight: '8px',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)',
    },
    '&.cm-focused .cm-cursor': {
      borderLeftColor: isDark ? '#E8E8EB' : '#262626',
      borderLeftWidth: '1px',
    },
    '.cm-activeLine': {
      backgroundColor: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.015)',
    },
    '.cm-selectionBackground': {
      backgroundColor: isDark ? '#343A43' : '#D9D9D9',
    },
    '&.cm-focused .cm-selectionBackground': {
      backgroundColor: isDark ? '#343A43' : '#D9D9D9',
    },
    /* Markdown heading colors matching original */
    '.cm-header-1, .cm-header-2, .cm-header-3': {
      color: isDark ? '#A077FF' : '#7B3DB0',
      fontWeight: 'bold',
      letterSpacing: '0.05em',
    },
    '.cm-header-4, .cm-header-5, .cm-header-6': {
      color: isDark ? '#A077FF' : '#7B3DB0',
      fontWeight: 'bold',
    },
    /* Link color matching original */
    '.cm-link': {
      color: isDark ? '#61FFC9' : '#05A69A',
    },
    '.cm-url': {
      color: isDark ? '#61FFC9' : '#05A69A',
    },
    /* List marker color */
    '.cm-list': {
      color: isDark ? '#C4C7C4' : '#826B28',
    },
    /* HTML tag color */
    '.cm-meta, .cm-comment': {
      color: isDark ? '#FFD185' : '#F2891F',
    },
  }, { dark: isDark });
}

export function Editor() {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // 窄订阅：避免 store 其他字段（openTabs 等）变化引发编辑器重渲染
  const activeNote = useNotesStore((s) => s.activeNote);
  const activeContent = useNotesStore((s) => s.activeContent);
  const updateContent = useNotesStore((s) => s.updateContent);
  const refreshNotes = useNotesStore((s) => s.refreshNotes);
  const config = useSettingsStore((s) => s.config);
  // 窄订阅：editorScrollLine 每个滚动帧都变，全量订阅会让编辑器在滚动时逐帧重渲染
  const setEditorScrollLine = useEditorStore((s) => s.setEditorScrollLine);
  // Suppress editor→preview sync while preview is driving editor scroll
  const suppressEditorSync = useRef(false);
  const scrollRafRef = useRef<number | null>(null);
  // 编辑器自身产出的最新内容：用于跳过自己触发的 activeContent 同步，
  // 避免每次按键都对全文做 toString 比较
  const lastEditorContentRef = useRef<string>('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; visible: boolean }>({ x: 0, y: 0, visible: false });
  const [title, setTitle] = useState('');

  const isDark = config.theme === 'dark' ||
    (config.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  const isHtmlFile = !!activeNote && /\.(html|htm)$/i.test(activeNote.path);
  // 超大 HTML（如 graphify 生成的依赖图，可达数 MB）不进 CodeMirror，
  // 否则语法高亮/折行会把主线程卡死，只保留预览
  const HTML_EDIT_LIMIT = 512 * 1024;
  const isHugeHtml = isHtmlFile && activeContent.length > HTML_EDIT_LIMIT;

  // Initialize editor
  useEffect(() => {
    if (!editorRef.current || isHugeHtml) return;

    const state = EditorState.create({
      doc: activeContent,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        indentOnInput(),
        bracketMatching(),
        // 不启用 highlightSelectionMatches：它每次光标移动都全文扫描匹配项，
        // 大文档下会明显拖慢输入
        tabSnippets(),
        langCompartment.of(isHtmlFile ? html() : markdown({ base: markdownLanguage, codeLanguages: languages })),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        wikilinks(),
        imagePasteExtension(() => activeNote?.path ?? null),
        imagePreviewExtension(() => activeNote?.path ?? null),
        keymap.of([
          ...smartListKeymap,
          ...textFormattingKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),
        themeCompartment.of(getEditorTheme(isDark, { line_height: config.line_height, line_spacing: config.line_spacing, letter_spacing: config.letter_spacing })),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const t0 = performance.now();
            const content = update.state.doc.toString();
            lastEditorContentRef.current = content;
            updateContent(content, config.storage_path);
            // 每键同步处理超过一帧（16ms）即为可感知卡顿，记录以便定位
            const dt = performance.now() - t0;
            if (dt > 16) perfReport('editor-key', dt, `doc=${content.length}`);
          }
          if ((update.geometryChanged || update.viewportChanged) && !suppressEditorSync.current) {
            // RAF-throttle to avoid flooding preview with scroll messages
            if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
            scrollRafRef.current = requestAnimationFrame(() => {
              scrollRafRef.current = null;
              const view = update.view;
              const pos = view.elementAtHeight(view.scrollDOM.scrollTop);
              const line = view.state.doc.lineAt(pos.from).number;
              // 仅行号变化时更新 store，避免滚动每帧触发订阅组件重渲染
              if (useEditorStore.getState().editorScrollLine !== line) {
                setEditorScrollLine(line);
              }
            });
          }
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: editorRef.current,
    });
    viewRef.current = view;
    lastEditorContentRef.current = activeContent;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [activeNote?.id, isHugeHtml]);

  // Update content when active note changes (external)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // 编辑器自己产生的内容变更直接跳过，无需全文 toString 比较
    if (activeContent === lastEditorContentRef.current) return;
    const current = view.state.doc.toString();
    if (current !== activeContent) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: activeContent },
      });
      lastEditorContentRef.current = activeContent;
    }
  }, [activeContent]);

  // Update theme & spacing
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.reconfigure(getEditorTheme(isDark, { line_height: config.line_height, line_spacing: config.line_spacing, letter_spacing: config.letter_spacing })),
    });
  }, [isDark, config.line_height, config.line_spacing, config.letter_spacing]);

  // TOC → Editor scroll
  useEffect(() => {
    const handler = (e: Event) => {
      const view = viewRef.current;
      if (!view) return;
      const line = (e as CustomEvent).detail.line as number;
      const lineNum = Math.max(1, Math.min(Math.round(line), view.state.doc.lines));
      const lineInfo = view.state.doc.line(lineNum);
      suppressEditorSync.current = true;
      view.dispatch({
        effects: EditorView.scrollIntoView(lineInfo.from, { y: 'start', yMargin: 0 }),
      });
      setTimeout(() => { suppressEditorSync.current = false; }, 500);
    };
    window.addEventListener('editor-scroll-to-line', handler);
    return () => window.removeEventListener('editor-scroll-to-line', handler);
  }, []);

  // Preview → Editor scroll sync (with suppression to avoid echo loop)
  useEffect(() => {
    const handler = (e: Event) => {
      const view = viewRef.current;
      if (!view) return;
      const line = (e as CustomEvent).detail.line as number;
      const lineNum = Math.max(1, Math.min(Math.round(line), view.state.doc.lines));
      const lineInfo = view.state.doc.line(lineNum);
      suppressEditorSync.current = true;
      view.dispatch({
        effects: EditorView.scrollIntoView(lineInfo.from, { y: 'start', yMargin: 0 }),
      });
      setTimeout(() => { suppressEditorSync.current = false; }, 500);
    };
    window.addEventListener('preview-scroll-to-line', handler);
    return () => window.removeEventListener('preview-scroll-to-line', handler);
  }, []);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, visible: true });
  };

  const handleCloseContextMenu = () => {
    setContextMenu(prev => ({ ...prev, visible: false }));
  };

  const handleContextMenuAction = (action: string) => {
    const view = viewRef.current;
    if (!view) return;

    switch (action) {
      case 'bold': wrapSelection(view, '**', '**'); break;
      case 'italic': wrapSelection(view, '*', '*'); break;
      case 'strikethrough': wrapSelection(view, '~~', '~~'); break;
      case 'inlineCode': wrapSelection(view, '`', '`'); break;
      case 'unorderedList': toggleUnorderedList(view); break;
      case 'orderedList': toggleOrderedList(view); break;
      case 'todo': toggleTodoList(view); break;
      case 'link': insertLink(view); break;
      case 'image': insertImage(view); break;
      case 'codeBlock': insertCodeBlock(view); break;
    }
  };

  // Sync title state when activeNote changes
  useEffect(() => {
    setTitle(activeNote?.title ?? '');
  }, [activeNote?.title]);

  const handleTitleCommit = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed || !activeNote || trimmed === activeNote.title) return;
    try {
      await renameNote(activeNote.path, trimmed);
      await refreshNotes(config.storage_path);
    } catch (err) {
      console.error('Failed to rename note:', err);
      setTitle(activeNote.title);
    }
  }, [title, activeNote, config.storage_path, refreshNotes]);

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    }
  }, []);

  if (!activeNote) {
    return (
      <div className="h-full flex items-center justify-center empty-state" style={{ backgroundColor: 'var(--bg-secondary)' }}>
        <div className="text-center">
          <p className="text-4xl font-light" style={{ color: 'var(--text-primary)' }}>MiaoYan</p>
          <p className="text-sm mt-2" style={{ color: 'var(--text-tertiary)' }}>Select a note or create a new one</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-hidden relative flex flex-col" onContextMenu={handleContextMenu}>
      {/* Title editor */}
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={handleTitleCommit}
        onKeyDown={handleTitleKeyDown}
        className="w-full border-none bg-transparent outline-none"
        style={{
          fontSize: '18px',
          fontWeight: 600,
          padding: '12px 20px',
          color: 'var(--text-primary)',
        }}
      />
      {isHugeHtml ? (
        <div className="flex-1 min-h-0 flex items-center justify-center">
          <div className="text-center text-sm px-8" style={{ color: 'var(--text-tertiary)' }}>
            <p style={{ fontSize: '28px', marginBottom: '8px' }}>⚠️</p>
            <p>HTML 文件过大（超过 512 KB），不提供编辑</p>
            <p className="mt-1">请使用右侧预览，或点击右上角按钮在浏览器中打开</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0" ref={editorRef} />
      )}
      <ContextMenu
        x={contextMenu.x}
        y={contextMenu.y}
        visible={contextMenu.visible}
        onClose={handleCloseContextMenu}
        onAction={handleContextMenuAction}
      />
    </div>
  );
}
