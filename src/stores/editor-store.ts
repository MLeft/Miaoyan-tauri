import { create } from 'zustand';

export type ViewMode = 'editor' | 'preview' | 'split';

interface EditorState {
  viewMode: ViewMode;
  isPresentation: boolean;
  showToc: boolean;
  editorScrollLine: number;

  setViewMode: (mode: ViewMode) => void;
  togglePresentation: () => void;
  toggleToc: () => void;
  setEditorScrollLine: (line: number) => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  viewMode: 'split',
  isPresentation: false,
  showToc: false,
  editorScrollLine: 0,

  setViewMode: (mode) => set({ viewMode: mode }),
  togglePresentation: () => set((s) => ({ isPresentation: !s.isPresentation })),
  toggleToc: () => set((s) => ({ showToc: !s.showToc })),
  setEditorScrollLine: (line) => set({ editorScrollLine: line }),
}));
