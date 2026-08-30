import { invoke } from '@tauri-apps/api/core';
import type { NoteMetadata, NoteContent, Project, AppConfig } from '../types';

/* ── 全量扫描并发去重：同参数并发调用共享同一次在途扫描，
   避免双重磁盘扫描互相争抢、chunk 到达时序与完成态不一致（顺序调用不受影响）。
   去重键含参数：extra_folders 变更后的新调用不得复用旧参数在途 Promise（旧结果缺新文件夹，
   全量替换会抹掉增量导入的行/笔记） ── */
const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
const scanKey = (rootPath: string, extraFolders: string[]) =>
  norm(rootPath) + '|' + extraFolders.map(norm).join('|');
let inflightProjects: { key: string; p: Promise<Project[]> } | null = null;
let inflightNotes: { key: string; p: Promise<NoteMetadata[]> } | null = null;

export function getProjects(rootPath: string, extraFolders: string[] = []): Promise<Project[]> {
  const key = scanKey(rootPath, extraFolders);
  if (!inflightProjects || inflightProjects.key !== key) {
    const p = invoke<Project[]>('get_projects', { rootPath, extraFolders })
      .finally(() => { if (inflightProjects && inflightProjects.p === p) inflightProjects = null; });
    inflightProjects = { key, p };
  }
  return inflightProjects.p;
}

export function getAllNotes(rootPath: string, extraFolders: string[] = []): Promise<NoteMetadata[]> {
  const key = scanKey(rootPath, extraFolders);
  if (!inflightNotes || inflightNotes.key !== key) {
    const p = invoke<NoteMetadata[]>('get_all_notes', { rootPath, extraFolders })
      .finally(() => { if (inflightNotes && inflightNotes.p === p) inflightNotes = null; });
    inflightNotes = { key, p };
  }
  return inflightNotes.p;
}

/* ── 增量导入单个外部文件夹：只扫新目录，chunk 事件由 UnifiedTree 监听自动合并（不触发全库重扫） ── */
export function scanFolder(folder: string): Promise<NoteMetadata[]> {
  return invoke<NoteMetadata[]>('scan_folder', { folder });
}

export async function getNotesInFolder(folderPath: string, rootPath: string): Promise<NoteMetadata[]> {
  return invoke('get_notes_in_folder', { folderPath, rootPath });
}

export async function getNotesMetadata(paths: string[], rootPath: string, extraFolders: string[] = []): Promise<NoteMetadata[]> {
  return invoke('get_notes_metadata', { paths, rootPath, extraFolders });
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

export async function startWatching(paths: string[]): Promise<void> {
  return invoke('start_watching', { paths });
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

// Image Paste
export async function saveImage(notePath: string, imageData: number[], extension: string): Promise<string> {
  return invoke<string>('save_image', { notePath, imageData, extension });
}

// Image Upload
export async function uploadImage(imageData: number[], filename: string, service: string): Promise<string> {
  return invoke<string>('upload_image', { imageData, filename, service });
}

// Window Management
export async function setAlwaysOnTop(enabled: boolean): Promise<void> {
  return invoke('set_always_on_top', { enabled });
}

// Backlinks
export interface BacklinkItem {
  title: string;
  path: string;
  context: string;
}

export async function getBacklinks(rootPath: string, noteTitle: string): Promise<BacklinkItem[]> {
  return invoke<BacklinkItem[]>('get_backlinks', { rootPath, noteTitle });
}

// Sort Order
export async function saveSortOrder(rootPath: string, folder: string, order: string[]): Promise<void> {
  return invoke('save_sort_order', { rootPath, folder, order });
}

export async function getSortOrder(rootPath: string, folder: string): Promise<string[]> {
  return invoke<string[]>('get_sort_order', { rootPath, folder });
}

// Encryption
export async function encryptNote(path: string, password: string): Promise<void> {
  return invoke('encrypt_note', { path, password });
}

export async function decryptNote(path: string, password: string): Promise<string> {
  return invoke<string>('decrypt_note', { path, password });
}

export async function verifyPassword(path: string, password: string): Promise<boolean> {
  return invoke<boolean>('verify_password', { path, password });
}

export async function saveEncryptedNote(path: string, content: string, password: string): Promise<void> {
  return invoke('save_encrypted_note', { path, content, password });
}

export async function removeEncryption(path: string, password: string): Promise<void> {
  return invoke('remove_encryption', { path, password });
}

// Cloud Sync
export interface CloudSyncInfo {
  status: 'Available' | 'Unavailable' | 'Syncing' | 'Synced' | { Error: string };
  icloud_path: string | null;
}

export async function detectCloudSync(): Promise<CloudSyncInfo> {
  return invoke<CloudSyncInfo>('detect_cloud_sync');
}

export async function getSyncStatus(path: string): Promise<string> {
  return invoke<string>('get_sync_status', { path });
}

export async function moveNote(sourcePath: string, targetFolder: string): Promise<string> {
  return invoke('move_note', { sourcePath, targetFolder });
}

export async function renameFolder(oldPath: string, newName: string): Promise<string> {
  return invoke('rename_folder', { oldPath, newName });
}

export async function deleteFolder(path: string): Promise<void> {
  return invoke('delete_folder', { path });
}

export async function revealInFinder(path: string): Promise<void> {
  return invoke('reveal_in_finder', { path });
}

export async function openInTerminal(path: string): Promise<void> {
  return invoke('open_in_terminal', { path });
}

/* ── Annotations ── */

export async function readAnnotations(notePath: string): Promise<string> {
  return invoke('read_annotations', { notePath });
}

export async function writeAnnotations(notePath: string, json: string): Promise<void> {
  return invoke('write_annotations', { notePath, json });
}

export async function deleteAnnotations(notePath: string): Promise<void> {
  return invoke('delete_annotations', { notePath });
}

/* ── File association / open-with (Windows) ── */

export async function getPendingOpenFiles(): Promise<string[]> {
  return invoke<string[]>('get_pending_open_files');
}

export async function getMdAssociationStatus(): Promise<boolean> {
  return invoke<boolean>('get_md_association_status');
}

export async function setMdAssociation(enabled: boolean): Promise<void> {
  return invoke('set_md_association', { enabled });
}
