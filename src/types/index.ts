export interface NoteMetadata {
  id: string;
  title: string;
  path: string;
  folder: string;
  created_at: string;
  modified_at: string;
  pinned: boolean;
  size: number;
  is_encrypted: boolean;
}

export interface NoteContent {
  id: string;
  content: string;
}

export interface Project {
  name: string;
  path: string;
  children: Project[];
  is_root: boolean;
}

export interface AppConfig {
  storage_path: string;
  theme: string;
  language: string;
  editor_font_family: string;
  editor_font_size: number;
  preview_font_family: string;
  preview_font_size: number;
  code_font_family: string;
  show_sidebar: boolean;
  show_notes_list: boolean;
  split_mode: 'editor' | 'preview' | 'split';
  auto_save_interval: number;
  button_display: 'always' | 'hover' | 'hide';
  always_on_top: boolean;
  quick_launch_shortcut: string;
  preview_width: '600' | '800' | '1000' | '1200' | '1400' | 'full';
  line_ending: 'lf' | 'crlf';
  title_font_size: number;
  presentation_font_size: number;
  line_height: number;
  line_spacing: number;
  letter_spacing: number;
  image_upload_service: 'none' | 'picgo' | 'upic' | 'picsee' | 'piclist';
}

export type SortMode = 'modified' | 'created' | 'title' | 'custom';
export type SortDirection = 'asc' | 'desc';
