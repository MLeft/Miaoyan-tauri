import { useEffect, useRef } from 'react';
import { useNotesStore } from '../../stores/notes-store';
import { useSettingsStore } from '../../stores/settings-store';
import { parseMarkdown } from '../../services/tauri-bridge';

const PPT_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@4/dist/reveal.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@4/dist/theme/white.css" id="theme">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>
<style>
.reveal { font-size: 32px; }
.reveal h1 { font-size: 2em; }
.reveal h2 { font-size: 1.5em; }
.reveal h3 { font-size: 1.2em; }
.reveal pre { font-size: 0.55em; }
.reveal code { font-size: 0.9em; }
.reveal ul, .reveal ol { text-align: left; }
.reveal section { padding: 20px; }
</style>
</head>
<body>
<div class="reveal">
  <div class="slides" id="slides"></div>
</div>
<script src="https://cdn.jsdelivr.net/npm/reveal.js@4/dist/reveal.js"></script>
<script src="https://cdn.jsdelivr.net/npm/reveal.js@4/plugin/highlight/highlight.js"></script>
<script>
var deck = null;

function setSlides(slidesHtml, isDark) {
  document.getElementById('slides').innerHTML = slidesHtml;
  document.getElementById('theme').href = isDark
    ? 'https://cdn.jsdelivr.net/npm/reveal.js@4/dist/theme/night.css'
    : 'https://cdn.jsdelivr.net/npm/reveal.js@4/dist/theme/white.css';
  
  if (deck) {
    deck.destroy();
  }
  deck = new Reveal({
    hash: false,
    controls: true,
    progress: true,
    center: true,
    transition: 'slide',
    plugins: [RevealHighlight]
  });
  deck.initialize().then(function() {
    // Render KaTeX in slides
    try {
      renderMathInElement(document.querySelector('.reveal'), {
        delimiters: [
          {left: '$$', right: '$$', display: true},
          {left: '$', right: '$', display: false}
        ],
        throwOnError: false
      });
    } catch(e) {}
  });
}
</script>
</body>
</html>`;

interface Props {
  onClose: () => void;
}

export function PresentationMode({ onClose }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { activeContent, activeNote } = useNotesStore();
  const { config } = useSettingsStore();

  const isDark = config.theme === 'dark' ||
    (config.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    if (!activeNote || !activeContent) return;

    const convertToSlides = async () => {
      // Split content by --- (horizontal rule) into slides
      const sections = activeContent.split(/\n---\n/);
      const slidesHtml = await Promise.all(
        sections.map(async (section) => {
          const html = await parseMarkdown(section.trim());
          return `<section>${html}</section>`;
        })
      );
      
      const iframe = iframeRef.current;
      if (iframe?.contentWindow) {
        try {
          (iframe.contentWindow as any).setSlides?.(slidesHtml.join('\n'), isDark);
        } catch {}
      }
    };

    // Wait for iframe to load
    const timer = setTimeout(convertToSlides, 500);
    return () => clearTimeout(timer);
  }, [activeContent, activeNote?.id, isDark]);

  // ESC to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-black">
      <button
        onClick={onClose}
        className="absolute top-4 right-4 z-50 text-white/50 hover:text-white text-2xl"
        title="Exit presentation (Esc)"
      >
        &times;
      </button>
      <iframe
        ref={iframeRef}
        srcDoc={PPT_HTML}
        className="w-full h-full border-none"
        sandbox="allow-scripts allow-same-origin"
        title="presentation"
      />
    </div>
  );
}
