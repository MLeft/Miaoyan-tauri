import type { Options } from 'prettier';

let prettierModule: typeof import('prettier') | null = null;

async function getPrettier() {
  if (!prettierModule) {
    prettierModule = await import('prettier');
  }
  return prettierModule;
}

const prettierOptions: Options = {
  parser: 'markdown',
  printWidth: 80,
  tabWidth: 2,
  useTabs: false,
  proseWrap: 'preserve' as const,
};

/**
 * Format Markdown document using Prettier.
 * Preserves special code blocks (mermaid, plantuml, markmap) that Prettier may mangle.
 */
export async function formatMarkdown(content: string): Promise<string> {
  const prettier = await getPrettier();

  // Protect special diagram blocks from Prettier reformatting
  const protectedBlocks: { placeholder: string; original: string }[] = [];
  let protectedContent = content.replace(
    /```(?:mermaid|plantuml|markmap)[\s\S]*?```/g,
    (match) => {
      const placeholder = `___DIAGRAM_BLOCK_${protectedBlocks.length}___`;
      protectedBlocks.push({ placeholder, original: match });
      return placeholder;
    }
  );

  // Run prettier
  const formatted = await prettier.format(protectedContent, prettierOptions);

  // Restore protected blocks
  let result = formatted;
  for (const { placeholder, original } of protectedBlocks) {
    result = result.replace(placeholder, original);
  }

  return result;
}
