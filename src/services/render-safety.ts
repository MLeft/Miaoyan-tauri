export interface PreviewScope {
  path: string;
  identity: number;
  revision: number;
  generation: number;
}

export interface PreviewSnapshot extends PreviewScope {
  html: string;
  raw: boolean;
}

export function samePreviewScope(a: PreviewScope | null, b: unknown): b is PreviewScope {
  if (!a || !b || typeof b !== 'object') return false;
  const value = b as PreviewScope;
  return a.path === value.path && a.identity === value.identity &&
    a.revision === value.revision && a.generation === value.generation;
}

export function currentPreviewDocument(scope: PreviewScope, session: {
  path: string; identity: number; revision: number;
} | null, activePath: string | undefined): boolean {
  return !!session && activePath === scope.path && session.path === scope.path &&
    session.identity === scope.identity && session.revision === scope.revision;
}

export function validPreviewMessage(value: unknown): value is Record<string, unknown> & { type: string } {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  const text = (key: string, max = 100_000) => typeof m[key] === 'string' && (m[key] as string).length <= max;
  const integer = (key: string) => Number.isSafeInteger(m[key]) && (m[key] as number) >= 0;
  switch (m.type) {
    case 'preview-rendered': return true;
    case 'preview-error': return text('message', 1000);
    case 'checkbox-toggle': return integer('index');
    case 'previewScroll': return typeof m.line === 'number' && Number.isFinite(m.line) && m.line >= 0;
    case 'wikilink-navigate': return text('title', 1000);
    case 'annotation-selection': return text('quote') && text('heading', 1000) && integer('paragraphIndex');
    case 'annotation-click': return text('id', 200);
    case 'annotation-copy': return text('text');
    case 'plantuml-request': return text('source') && integer('index');
    case 'open-link': return text('url', 8192) && safeExternalUrl(m.url as string) !== null;
    default: return false;
  }
}

export function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

// The renderer sends the index of the task, never replacement source. The caller
// checks session identity/revision and uses the notes store's CAS for the write.
export function togglePreviewTask(content: string, index: number): string | null {
  if (!Number.isSafeInteger(index) || index < 0) return null;
  let task = 0;
  let fence: string | null = null;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const opening = lines[i].match(/^\s*(`{3,}|~{3,})/);
    if (opening) { fence = fence ? (opening[1][0] === fence[0] && opening[1].length >= fence.length ? null : fence) : opening[1]; continue; }
    if (fence) continue;
    const match = lines[i].match(/^(\s*(?:[-+*]|\d+[.)])\s+\[)([ xX])(\]\s)/);
    if (match && task++ === index) {
      lines[i] = lines[i].replace(/^(\s*(?:[-+*]|\d+[.)])\s+\[)([ xX])(\]\s)/, `$1${match[2] === ' ' ? 'x' : ' '}$3`);
      return lines.join('\n');
    }
  }
  return null;
}
