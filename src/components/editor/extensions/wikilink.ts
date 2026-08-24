import { ViewPlugin, Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

class WikilinkWidget extends WidgetType {
  constructor(readonly title: string) { super(); }

  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-wikilink';
    span.textContent = this.title;
    span.style.cssText = 'color: #0969da; cursor: pointer; text-decoration: underline; text-decoration-style: dotted;';
    span.addEventListener('click', () => {
      // Dispatch custom event for navigation
      window.dispatchEvent(new CustomEvent('wikilink-navigate', { detail: { title: this.title } }));
    });
    return span;
  }

  eq(other: WikilinkWidget) { return other.title === this.title; }
}

const wikilinkDecoration = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: any) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView) {
      // 只扫描可见区域而非全文：大文档（数百 KB）下每次按键都对全文
      // toString + 正则会导致明显输入延迟
      const builder = new RangeSetBuilder<Decoration>();
      const regex = /\[\[([^\]]+)\]\]/g;

      for (const { from, to } of view.visibleRanges) {
        const startLine = view.state.doc.lineAt(from);
        const endLine = view.state.doc.lineAt(to);
        for (let i = startLine.number; i <= endLine.number; i++) {
          const line = view.state.doc.line(i);
          regex.lastIndex = 0;
          let match;
          while ((match = regex.exec(line.text)) !== null) {
            const mFrom = line.from + match.index;
            const mTo = mFrom + match[0].length;
            const title = match[1];
            builder.add(mFrom, mTo, Decoration.mark({
              class: 'cm-wikilink-mark',
              attributes: { 'data-wikilink': title },
            }));
          }
        }
      }

      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

const wikilinkTheme = EditorView.baseTheme({
  '.cm-wikilink-mark': {
    color: '#0969da',
    cursor: 'pointer',
    borderBottom: '1px dotted #0969da',
  },
  '.dark .cm-wikilink-mark': {
    color: '#58a6ff',
    borderBottom: '1px dotted #58a6ff',
  },
});

// Click handler for wikilinks
const wikilinkClickHandler = EditorView.domEventHandlers({
  click(event, view) {
    const target = event.target as HTMLElement;
    if (target.classList.contains('cm-wikilink-mark') || target.closest('.cm-wikilink-mark')) {
      const el = target.classList.contains('cm-wikilink-mark') ? target : target.closest('.cm-wikilink-mark')!;
      const title = el.getAttribute('data-wikilink');
      if (title) {
        window.dispatchEvent(new CustomEvent('wikilink-navigate', { detail: { title } }));
        return true;
      }
    }
    return false;
  },
});

export function wikilinks() {
  return [wikilinkDecoration, wikilinkTheme, wikilinkClickHandler];
}
