import type { Options, Plugin } from 'prettier';

let prettierModule: typeof import('prettier') | null = null;

async function getPrettier() {
  if (!prettierModule) prettierModule = await import('prettier');
  return prettierModule;
}

const prettierOptions: Options = {
  parser: 'markdown', printWidth: 80, tabWidth: 2, useTabs: false, proseWrap: 'preserve', endOfLine: 'auto',
};

interface MarkdownNode {
  type: string;
  lang?: string | null;
  children?: MarkdownNode[];
}

function originalOffsetMapper(content: string, normalized: string) {
  const bom = content.charCodeAt(0) === 0xfeff && normalized.charCodeAt(0) !== 0xfeff ? 1 : 0;
  const removedCr: number[] = [];
  for (const match of content.matchAll(/\r\n/g)) removedCr.push(match.index - removedCr.length - bom);
  return (offset: number) => {
    let low = 0;
    let high = removedCr.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (removedCr[middle] < offset) low = middle + 1;
      else high = middle;
    }
    return offset + low + bom;
  };
}

export async function formatMarkdown(content: string): Promise<string> {
  const [prettier, markdownPlugin] = await Promise.all([
    getPrettier(), import('prettier/plugins/markdown'),
  ]);
  const parser = markdownPlugin.parsers.markdown;
  const marker = crypto.randomUUID();
  const protectedBlocks = new Map<string, string>();
  const plugin: Plugin = {
    ...markdownPlugin,
    parsers: {
      ...markdownPlugin.parsers,
      markdown: {
        ...parser,
        async preprocess(text, options) {
          const input = parser.preprocess ? await parser.preprocess(text, options) : text;
          if (!/\b(?:mermaid|plantuml|markmap)\b/i.test(input)) return input;
          const tree: MarkdownNode = await parser.parse(input, options);
          const rawOffset = originalOffsetMapper(content, input);
          const ranges: Array<{ start: number; end: number }> = [];
          for (const container of tree.children ?? []) {
            const nodes = [container];
            while (nodes.length) {
              const node = nodes.pop()!;
              if (node.type === 'code' && node.lang && ['mermaid', 'plantuml', 'markmap'].includes(node.lang.toLowerCase())) {
                // Preserve the container so list/quote indentation cannot invalidate a diagram's fences.
                ranges.push({ start: input.lastIndexOf('\n', parser.locStart(container) - 1) + 1, end: parser.locEnd(container) });
                break;
              }
              for (const child of node.children ?? []) nodes.push(child);
            }
          }
          const parts: string[] = [];
          let cursor = 0;
          for (const { start, end } of ranges.sort((a, b) => a.start - b.start)) {
            const placeholder = `<!-- miaoyan-${marker}-${protectedBlocks.size} -->`;
            protectedBlocks.set(placeholder, content.slice(rawOffset(start), rawOffset(end)));
            parts.push(input.slice(cursor, start), placeholder);
            cursor = end;
          }
          parts.push(input.slice(cursor));
          return parts.join('');
        },
      },
    },
  };
  const formatted = await prettier.format(content, { ...prettierOptions, plugins: [plugin] });
  return formatted.replace(new RegExp(`<!-- miaoyan-${marker}-\\d+ -->`, 'g'), placeholder => protectedBlocks.get(placeholder)!);
}
