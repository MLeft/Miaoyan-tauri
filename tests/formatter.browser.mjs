import { formatMarkdown } from '../src/services/formatter';

export async function testMarkdownFormatting() {
  const blocks = [
    '```mermaid\ngraph LR\n    A-->B  \n```',
    '```plantuml\n@startuml\nA -> B: hello\n@enduml\n```',
    '```markmap\n# map\n## branch\n```',
    "```plantuml\n@startuml\nA -> B: $& $$ $` $'\n@enduml\n```",
    '~~~mermaid\ngraph LR\nA-->B  \n~~~',
    '````mermaid\ngraph LR\nA-->B\n```\n````',
  ];
  const input = '# Heading\n\n-   item\n\n' + blocks.join('\n\n') + '\n';
  const output = await formatMarkdown(input);
  if (!output.includes('- item\n')) throw new Error('Markdown list was not formatted');
  for (const block of blocks) {
    if (!output.includes(block)) throw new Error(`Diagram block changed during formatting: ${block}`);
  }
  if ((await formatMarkdown(output)) !== output) throw new Error('Markdown formatting was not idempotent');
  const issues = [];
  const nested = '-   outer\n    -   inner\n        ```markmap\n        # Map\n        ## Child\n        ```\n';
  const nestedOutput = await formatMarkdown(nested);
  const { parsers } = await import('prettier/plugins/markdown');
  const nodes = [await parsers.markdown.parse(nestedOutput, { parser: 'markdown' })];
  const diagrams = [];
  while (nodes.length) {
    const node = nodes.pop();
    if (node.type === 'code' && node.lang === 'markmap') diagrams.push(node.value);
    for (const child of node.children ?? []) nodes.push(child);
  }
  if (diagrams.length !== 1 || diagrams[0] !== '# Map\n## Child') issues.push('Nested list diagram delimiters became code content');
  const crlfBlock = '```mermaid\r\ngraph LR\r\nA-->B  \r\n```';
  const crlfOutput = await formatMarkdown('\uFEFF# 标题\r\n\r\n' + crlfBlock + '\r\n');
  if (!crlfOutput.startsWith('\uFEFF') || !crlfOutput.includes(crlfBlock)) issues.push('BOM/CRLF diagram bytes changed');
  if (issues.length) throw new Error(issues.join('; '));
  return { passed: true, listFormatted: true, diagramBlocksPreserved: blocks.length, nestedDiagramPreserved: true, crlfPreserved: true, idempotent: true };
}
