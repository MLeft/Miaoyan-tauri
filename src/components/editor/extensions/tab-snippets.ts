import { CompletionContext, autocompletion, Completion } from '@codemirror/autocomplete';

const snippets: Record<string, string> = {
  '/time': new Date().toLocaleString(),
  '/table': `| Column 1 | Column 2 | Column 3 |
| -------- | -------- | -------- |
| Cell 1   | Cell 2   | Cell 3   |
| Cell 4   | Cell 5   | Cell 6   |`,
  '/img': '![description](url)',
  '/video': '<video src="url" controls></video>',
  '/mermaid': '```mermaid\ngraph TD\n    A[Start] --> B[Process]\n    B --> C[End]\n```',
  '/plantuml': '```plantuml\n@startuml\nAlice -> Bob: Hello\nBob --> Alice: Hi!\n@enduml\n```',
  '/markmap': '```markmap\n# Root\n## Branch 1\n### Leaf 1\n### Leaf 2\n## Branch 2\n### Leaf 3\n```',
  '/fold': '<details>\n<summary>Click to expand</summary>\n\nContent here...\n\n</details>',
  '/task': '- [ ] Task 1\n- [ ] Task 2\n- [ ] Task 3',
};

function snippetCompletion(context: CompletionContext) {
  const word = context.matchBefore(/\/\w*/);
  if (!word || word.from === word.to) return null;

  const options: Completion[] = Object.entries(snippets).map(([trigger, template]) => ({
    label: trigger,
    type: 'snippet',
    apply: (view, completion, from, to) => {
      // For /time, always use current time
      const text = trigger === '/time'
        ? new Date().toLocaleString()
        : template;
      view.dispatch({
        changes: { from: word.from, to, insert: text },
      });
    },
    detail: trigger === '/time' ? 'Insert timestamp' :
            trigger === '/table' ? 'Insert table' :
            trigger === '/img' ? 'Insert image' :
            trigger === '/video' ? 'Insert video' :
            trigger === '/mermaid' ? 'Mermaid diagram' :
            trigger === '/plantuml' ? 'PlantUML diagram' :
            trigger === '/markmap' ? 'Mind map' :
            trigger === '/fold' ? 'Collapsible section' :
            trigger === '/task' ? 'Task list' : '',
  }));

  return {
    from: word.from,
    options,
    filter: true,
  };
}

export function tabSnippets() {
  return autocompletion({
    override: [snippetCompletion],
    activateOnTyping: true,
  });
}
