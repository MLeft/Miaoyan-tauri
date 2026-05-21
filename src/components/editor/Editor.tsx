import { useEffect, useRef } from 'react';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { useNotesStore } from '../../stores/notes-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useEditorStore } from '../../stores/editor-store';
import { smartListKeymap } from './extensions/smart-lists';
import { textFormattingKeymap } from './extensions/text-formatting';
import { tabSnippets } from './extensions/tab-snippets';
import { wikilinks } from './extensions/wikilink';

const themeCompartment = new Compartment();

function getEditorTheme(isDark: boolean) {
  return EditorView.theme({
    '&': {
      height: '100%',
      fontSize: '16px',
      color: isDark ? '#E8E8EB' : '#262626',
      backgroundColor: isDark ? '#232832' : '#FFFFFF',
    },
    '.cm-content': {
      fontFamily: "'TsangerJinKai02', -apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", sans-serif",
      padding: '16px 0',
      caretColor: isDark ? '#E8E8EB' : '#262626',
      letterSpacing: '0.5px',
    },
    '.cm-line': {
      padding: '0 20px',
      lineHeight: '1.45',
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
  const { activeNote, activeContent, updateContent } = useNotesStore();
  const { config } = useSettingsStore();
  const { setEditorScrollLine } = useEditorStore();
  // Suppress editor→preview sync while preview is driving editor scroll
  const suppressEditorSync = useRef(false);
  const scrollRafRef = useRef<number | null>(null);

  const isDark = config.theme === 'dark' ||
    (config.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  // Initialize editor
  useEffect(() => {
    if (!editorRef.current) return;

    const state = EditorState.create({
      doc: activeContent,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        indentOnInput(),
        bracketMatching(),
        highlightSelectionMatches(),
        tabSnippets(),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        wikilinks(),
        keymap.of([
          ...smartListKeymap,
          ...textFormattingKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),
        themeCompartment.of(getEditorTheme(isDark)),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const content = update.state.doc.toString();
            updateContent(content, config.storage_path);
          }
          if ((update.geometryChanged || update.viewportChanged) && !suppressEditorSync.current) {
            // RAF-throttle to avoid flooding preview with scroll messages
            if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
            scrollRafRef.current = requestAnimationFrame(() => {
              scrollRafRef.current = null;
              const view = update.view;
              const pos = view.elementAtHeight(view.scrollDOM.scrollTop);
              const line = view.state.doc.lineAt(pos.from).number;
              setEditorScrollLine(line);
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

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [activeNote?.id]);

  // Update content when active note changes (external)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== activeContent) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: activeContent },
      });
    }
  }, [activeContent]);

  // Update theme
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.reconfigure(getEditorTheme(isDark)),
    });
  }, [isDark]);

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

  if (!activeNote) {
    return (
      <div className="h-full flex items-center justify-center" style={{ backgroundColor: isDark ? '#232832' : '#FFFFFF' }}>
        <div className="text-center">
          <p className="text-4xl font-light" style={{ color: isDark ? '#E8E8EB' : '#262626' }}>MiaoYan</p>
          <p className="text-sm mt-2" style={{ color: isDark ? '#6B737D' : '#999' }}>Select a note or create a new one</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-hidden" ref={editorRef} />
  );
}
