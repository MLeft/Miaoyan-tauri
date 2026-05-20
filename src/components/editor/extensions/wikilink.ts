import { ViewPlugin, Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

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
      const builder = new RangeSetBuilder<Decoration>();
      const doc = view.state.doc.toString();
      const regex = /\[\[([^\]]+)\]\]/g;
      let match;

      while ((match = regex.exec(doc)) !== null) {
        const from = match.index;
        const to = from + match[0].length;
        const title = match[1];

        builder.add(from, to, Decoration.mark({
          class: 'cm-wikilink-mark',
          attributes: { 'data-wikilink': title },
        }));
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
