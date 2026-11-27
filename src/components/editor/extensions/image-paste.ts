import { EditorView, ViewPlugin } from '@codemirror/view';
import { EditorSelection, type Extension, type SelectionRange } from '@codemirror/state';
import { saveImage, uploadImage } from '../../../services/tauri-bridge';
import { useSettingsStore } from '../../../stores/settings-store';
import { useNotesStore } from '../../../stores/notes-store';

export function imagePasteExtension(getNotePath: () => string | null, isViewCurrent: (view: EditorView) => boolean): Extension {
  const pending = new Set<{ view: EditorView; range: SelectionRange; cancel: () => void }>();
  const warn = (message: string) => window.dispatchEvent(new CustomEvent('show-toast', { detail: { message, type: 'warning' } }));
  return [
    EditorView.updateListener.of(update => {
      if (!update.docChanged) return;
      for (const paste of pending) {
        // Keep the original insertion/selection through ordinary typing. At a
        // cursor, concurrent insertion goes before the eventual image (assoc=1).
        if (paste.view !== update.view) continue;
        const range = paste.range;
        let selectionEdited = false;
        if (!range.empty) update.changes.iterChangedRanges((from, to) => {
          if (from < range.to && to > range.from) selectionEdited = true;
        });
        // If typing already changed the selected body, insert after it rather
        // than replacing that new input when the upload eventually completes.
        paste.range = selectionEdited
          ? EditorSelection.cursor(update.changes.mapPos(range.to, 1))
          : range.map(update.changes, 1);
      }
    }),
    ViewPlugin.define(view => ({
      destroy() { for (const paste of pending) if (paste.view === view) paste.cancel(); },
    })),
    EditorView.domEventHandlers({
      paste(event: ClipboardEvent, view: EditorView) {
        const items = event.clipboardData?.items;
        if (!items) return false;

        for (const item of items) {
          if (!item.type.startsWith('image/')) continue;
          const file = item.getAsFile();
          if (!file) return false;
          event.preventDefault();
          const notePath = getNotePath();
          const identity = notePath ? useNotesStore.getState().getDocumentSession(notePath)?.identity : null;
          let cancelled = false;
          let unsubscribe = () => {};
          const cleanup = () => { unsubscribe(); pending.delete(paste); };
          const cancel = () => {
            if (cancelled) return;
            cancelled = true;
            cleanup();
            warn('图片粘贴已取消：文档已切换或不可写，请重新粘贴 / Image paste cancelled: document changed or is read-only. Paste again.');
          };
          const paste = { view, range: view.state.selection.main, cancel };
          const isCurrent = () => {
            const store = useNotesStore.getState();
            return !cancelled && notePath !== null && identity != null && isViewCurrent(view) && !view.state.readOnly &&
              getNotePath() === notePath && store.activeTabPath === notePath &&
              store.getDocumentSession(notePath)?.identity === identity && store.isDocumentWritable(notePath);
          };
          if (!isCurrent() || !notePath) { cancel(); return true; }
          pending.add(paste);
          // Latch invalidation, including a switch away/back or a temporary seal.
          // Revision changes alone are not cancellation: CM maps those edits.
          unsubscribe = useNotesStore.subscribe(() => { if (!isCurrent()) cancel(); });
          const ext = item.type.split('/')[1];
          const extension = ext === 'jpeg' ? 'jpg' : ext === 'svg+xml' ? 'svg' : (ext || 'png');
          const recover = (markdown: string) => warn(`图片粘贴已取消，图片已保存，可用此链接恢复 / Image paste cancelled; recover the saved image with: ${markdown} (${notePath})`);

          const workKey = `image:${crypto.randomUUID()}`;
          void useNotesStore.getState().runDocumentWork(notePath, identity!, workKey, async () => {
            let failed = false;
            try {
              const buffer = await file.arrayBuffer();
              if (!isCurrent()) { cancel(); return; }
              const data = Array.from(new Uint8Array(buffer));
              const service = useSettingsStore.getState().config.image_upload_service;
              const url = service !== 'none'
                ? await uploadImage(data, `image.${extension}`, service)
                : await saveImage(notePath, data, extension);
              const markdown = `![](${url})`;
              if (!isCurrent()) { cancel(); recover(markdown); return; }
              cleanup();
              const before = view.state.doc;
              const { from, to } = paste.range;
              view.dispatch({
                changes: { from, to, insert: markdown },
                selection: { anchor: from + markdown.length },
              });
              // The document dispatch gate can still reject a stale external
              // revision before React has synchronized it. Do not lose the asset.
              if (view.state.doc === before) { cancel(); recover(markdown); }
            } catch (err) {
              if (cancelled) return;
              failed = true;
              warn(`图片粘贴失败，可重试保存 / Image paste failed; retry saving: ${String(err)}`);
              throw err;
            } finally {
              if (!failed) cleanup();
            }
          }).then(saved => {
            if (!saved && !useNotesStore.getState().getDocumentWork(notePath, workKey)) cancel();
          });
          return true;
        }
        return false;
      },
    }),
  ];
}
