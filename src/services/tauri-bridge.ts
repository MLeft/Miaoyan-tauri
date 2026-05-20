import { invoke } from '@tauri-apps/api/core';
import type { NoteMetadata, NoteContent, Project, AppConfig } from '../types';

export async function getProjects(rootPath: string): Promise<Project[]> {
  return invoke('get_projects', { rootPath });
}

export async function getAllNotes(rootPath: string): Promise<NoteMetadata[]> {
  return invoke('get_all_notes', { rootPath });
}

export async function getNotesInFolder(folderPath: string, rootPath: string): Promise<NoteMetadata[]> {
  return invoke('get_notes_in_folder', { folderPath, rootPath });
}

export async function readNote(path: string): Promise<NoteContent> {
  return invoke('read_note', { path });
}

export async function writeNote(path: string, content: string): Promise<void> {
  return invoke('write_note', { path, content });
}

export async function createNote(folderPath: string, title: string): Promise<NoteMetadata> {
  return invoke('create_note', { folderPath, title });
}

export async function deleteNote(path: string): Promise<void> {
  return invoke('delete_note', { path });
}

export async function renameNote(oldPath: string, newTitle: string): Promise<string> {
  return invoke('rename_note', { oldPath, newTitle });
}

export async function createFolder(parentPath: string, name: string): Promise<string> {
  return invoke('create_folder', { parentPath, name });
}

export async function searchNotes(rootPath: string, query: string): Promise<NoteMetadata[]> {
  return invoke('search_notes', { rootPath, query });
}

export async function getConfig(): Promise<AppConfig> {
  return invoke('get_config');
}

export async function saveConfig(config: AppConfig): Promise<void> {
  return invoke('save_config', { config });
}

export async function parseMarkdown(content: string): Promise<string> {
  return invoke('parse_markdown', { content });
}

export async function startWatching(path: string): Promise<void> {
  return invoke('start_watching', { path });
}

// Version History
export interface VersionEntry {
  timestamp: string;
  filename: string;
  size: number;
}

export async function saveVersion(notePath: string, content: string): Promise<void> {
  return invoke('save_version', { notePath, content });
}

export async function listVersions(notePath: string): Promise<VersionEntry[]> {
  return invoke('list_versions', { notePath });
}

export async function getVersion(notePath: string, versionFilename: string): Promise<string> {
  return invoke('get_version', { notePath, versionFilename });
}

export async function restoreVersion(notePath: string, versionFilename: string): Promise<void> {
  return invoke('restore_version', { notePath, versionFilename });
}

// Pin Management
export async function getPinnedNotes(): Promise<string[]> {
  return invoke('get_pinned_notes');
}

export async function togglePin(notePath: string): Promise<string[]> {
  return invoke('toggle_pin', { notePath });
}
