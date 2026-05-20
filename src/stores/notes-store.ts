import { create } from 'zustand';
import type { NoteMetadata, NoteContent, Project, SortMode, SortDirection } from '../types';
import {
  getAllNotes,
  getNotesInFolder,
  getProjects,
  readNote,
  writeNote,
  searchNotes,
} from '../services/tauri-bridge';

interface NotesState {
  projects: Project[];
  notes: NoteMetadata[];
  activeNote: NoteMetadata | null;
  activeContent: string;
  activeFolder: string | null;
  searchQuery: string;
  sortMode: SortMode;
  sortDirection: SortDirection;
  isLoading: boolean;
  isDirty: boolean;
  saveTimer: ReturnType<typeof setTimeout> | null;

  loadProjects: (rootPath: string) => Promise<void>;
  loadNotes: (rootPath: string) => Promise<void>;
  loadNotesInFolder: (folderPath: string, rootPath: string) => Promise<void>;
  selectNote: (note: NoteMetadata) => Promise<void>;
  updateContent: (content: string, rootPath: string) => void;
  saveCurrentNote: () => Promise<void>;
  setSearchQuery: (query: string, rootPath: string) => Promise<void>;
  setActiveFolder: (folder: string | null, rootPath: string) => Promise<void>;
  setSortMode: (mode: SortMode) => void;
  toggleSortDirection: () => void;
  refreshNotes: (rootPath: string) => Promise<void>;
}

export const useNotesStore = create<NotesState>((set, get) => ({
  projects: [],
  notes: [],
  activeNote: null,
  activeContent: '',
  activeFolder: null,
  searchQuery: '',
  sortMode: 'modified',
  sortDirection: 'desc',
  isLoading: false,
  isDirty: false,
  saveTimer: null,

  loadProjects: async (rootPath) => {
    try {
      const projects = await getProjects(rootPath);
      set({ projects });
    } catch (e) {
      console.error('Failed to load projects:', e);
    }
  },

  loadNotes: async (rootPath) => {
    set({ isLoading: true });
    try {
      const notes = await getAllNotes(rootPath);
      set({ notes, isLoading: false });
    } catch (e) {
      console.error('Failed to load notes:', e);
      set({ isLoading: false });
    }
  },

  loadNotesInFolder: async (folderPath, rootPath) => {
    set({ isLoading: true });
    try {
      const notes = await getNotesInFolder(folderPath, rootPath);
      set({ notes, isLoading: false });
    } catch (e) {
      console.error('Failed to load notes in folder:', e);
      set({ isLoading: false });
    }
  },

  selectNote: async (note) => {
    // Save current note if dirty
    const state = get();
    if (state.isDirty && state.activeNote) {
      await get().saveCurrentNote();
    }

    set({ activeNote: note, isLoading: true });
    try {
      const result = await readNote(note.path);
      set({ activeContent: result.content, isLoading: false, isDirty: false });
    } catch (e) {
      console.error('Failed to read note:', e);
      set({ activeContent: '', isLoading: false });
    }
  },

  updateContent: (content, rootPath) => {
    const state = get();
    set({ activeContent: content, isDirty: true });

    // Debounced auto-save (1.5 seconds)
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
    }
    const timer = setTimeout(async () => {
      await get().saveCurrentNote();
    }, 1500);
    set({ saveTimer: timer });
  },

  saveCurrentNote: async () => {
    const { activeNote, activeContent, isDirty } = get();
    if (!activeNote || !isDirty) return;

    try {
      await writeNote(activeNote.path, activeContent);
      set({ isDirty: false });
    } catch (e) {
      console.error('Failed to save note:', e);
    }
  },

  setSearchQuery: async (query, rootPath) => {
    set({ searchQuery: query });
    if (query.trim()) {
      try {
        const notes = await searchNotes(rootPath, query);
        set({ notes });
      } catch (e) {
        console.error('Failed to search:', e);
      }
    } else {
      const { activeFolder } = get();
      if (activeFolder) {
        await get().loadNotesInFolder(activeFolder, rootPath);
      } else {
        await get().loadNotes(rootPath);
      }
    }
  },

  setActiveFolder: async (folder, rootPath) => {
    set({ activeFolder: folder, searchQuery: '' });
    if (folder) {
      await get().loadNotesInFolder(folder, rootPath);
    } else {
      await get().loadNotes(rootPath);
    }
  },

  setSortMode: (mode) => {
    set({ sortMode: mode });
  },

  toggleSortDirection: () => {
    set((state) => ({ sortDirection: state.sortDirection === 'asc' ? 'desc' : 'asc' }));
  },

  refreshNotes: async (rootPath) => {
    const { activeFolder, searchQuery } = get();
    if (searchQuery) {
      await get().setSearchQuery(searchQuery, rootPath);
    } else if (activeFolder) {
      await get().loadNotesInFolder(activeFolder, rootPath);
    } else {
      await get().loadNotes(rootPath);
    }
    await get().loadProjects(rootPath);
  },
}));
