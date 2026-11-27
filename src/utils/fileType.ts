export function isPdfPath(path: string): boolean {
  return path.toLowerCase().endsWith('.pdf');
}

export type SearchFileType = 'all' | 'md' | 'pdf' | 'html';

export function noteMatchesSearchType(note: { path: string }, type: SearchFileType): boolean {
  if (type === 'all') return true;
  const path = note.path.toLowerCase();
  if (type === 'pdf') return path.endsWith('.pdf');
  if (path.endsWith('.encrypted')) return type === 'md';
  const ext = path.slice(path.lastIndexOf('.') + 1);
  if (type === 'md') return ext === 'md' || ext === 'markdown' || ext === 'txt';
  return ext === 'html' || ext === 'htm';
}
