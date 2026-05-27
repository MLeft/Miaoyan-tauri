import { hoverTooltip } from '@codemirror/view';
import type { EditorView, TooltipView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { convertFileSrc } from '@tauri-apps/api/core';

// Resolve image path relative to the note's directory
function resolveImageUrl(rawPath: string, notePath: string | null): string {
  // Already an absolute path or a data URL
  if (rawPath.startsWith('/') || rawPath.startsWith('data:') || rawPath.startsWith('http')) {
    return convertFileSrc(rawPath);
  }

  if (!notePath) return rawPath;

  // notePath is the full path to the .md file; derive parent directory
  const lastSlash = Math.max(notePath.lastIndexOf('/'), notePath.lastIndexOf('\\'));
  const noteDir = lastSlash >= 0 ? notePath.slice(0, lastSlash) : notePath;
  const absolutePath = `${noteDir}/${rawPath}`.replace(/\\/g, '/');
  return convertFileSrc(absolutePath);
}

export function imagePreviewExtension(getNotePath: () => string | null): Extension {
  return hoverTooltip(
    (view: EditorView, pos: number) => {
      const line = view.state.doc.lineAt(pos);
      const lineText = line.text;
      const posInLine = pos - line.from;

      // Match standard markdown image: ![alt](url)
      const mdImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
      let match: RegExpExecArray | null;

      while ((match = mdImageRegex.exec(lineText)) !== null) {
        const matchStart = match.index;
        const matchEnd = matchStart + match[0].length;

        // Check if cursor is within this match
        if (posInLine >= matchStart && posInLine <= matchEnd) {
          const rawPath = match[2].trim();

          // Only handle image file extensions
          if (!isImagePath(rawPath)) continue;

          const resolvedUrl = resolveImageUrl(rawPath, getNotePath());

          return {
            pos: line.from + matchStart,
            end: line.from + matchEnd,
            above: true,
            create(_view: EditorView): TooltipView {
              const dom = document.createElement('div');
              dom.className = 'image-preview-tooltip';

              const img = document.createElement('img');
              img.src = resolvedUrl;
              img.style.maxWidth = '400px';
              img.style.maxHeight = '300px';
              img.style.borderRadius = '4px';
              img.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
              img.style.display = 'block';
              img.onerror = () => {
                dom.style.display = 'none';
              };

              dom.appendChild(img);
              return { dom };
            },
          };
        }
      }

      return null;
    },
    { hoverTime: 300 }
  );
}

function isImagePath(path: string): boolean {
  const lower = path.toLowerCase().split('?')[0]; // strip query string
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?)$/.test(lower);
}
