import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { saveImage, uploadImage } from '../../../services/tauri-bridge';
import { useSettingsStore } from '../../../stores/settings-store';

export function imagePasteExtension(getNotePath: () => string | null): Extension {
  return EditorView.domEventHandlers({
    paste(event: ClipboardEvent, view: EditorView) {
      const items = event.clipboardData?.items;
      if (!items) return false;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          event.preventDefault();
          const file = item.getAsFile();
          if (!file) return false;

          const notePath = getNotePath();
          if (!notePath) return false;

          const ext = item.type.split('/')[1];
          const extension = ext === 'jpeg' ? 'jpg' : (ext || 'png');
          const filename = `image.${extension}`;

          // Read file as ArrayBuffer
          file.arrayBuffer().then(async (buffer) => {
            const uint8Array = new Uint8Array(buffer);
            const imageDataArray = Array.from(uint8Array);

            const service = useSettingsStore.getState().config.image_upload_service;

            try {
              let imageMarkdown: string;

              if (service !== 'none') {
                // Remote upload via configured service
                const remoteUrl = await uploadImage(imageDataArray, filename, service);
                imageMarkdown = `![](${remoteUrl})`;
              } else {
                // Local save (original behavior)
                const relativePath = await saveImage(notePath, imageDataArray, extension);
                imageMarkdown = `![](${relativePath})`;
              }

              const cursor = view.state.selection.main.head;
              view.dispatch({
                changes: { from: cursor, insert: imageMarkdown },
                selection: { anchor: cursor + imageMarkdown.length },
              });
            } catch (err) {
              console.error('Failed to handle image paste:', err);
            }
          });

          return true;
        }
      }
      return false;
    },
  });
}
