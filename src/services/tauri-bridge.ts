import { invoke } from '@tauri-apps/api/core';
import { confirm } from '@tauri-apps/plugin-dialog';
import type { NoteMetadata, NoteContent, Project, AppConfig } from '../types';
import { pathIdentity } from '../utils/path-identity';

export interface OperationWarning { code: string; path: string; message: string }
export interface RecoveryInfo { transaction_id: string; kind: string; paths: string[]; committed: boolean }

export class DocumentOperationError extends Error {
  readonly name = 'DocumentOperationError';
  constructor(readonly code: string, message: string, readonly paths: string[] = [], readonly recoveryId: string | null = null, readonly warnings: OperationWarning[] = []) {
    super(message);
  }
}

async function invokeDocument<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (failure) {
    if (failure && typeof failure === 'object' && 'code' in failure && 'message' in failure && typeof failure.code === 'string' && typeof failure.message === 'string') {
      const data = failure as { code: string; message: string; paths?: string[]; recovery_id?: string | null; warnings?: OperationWarning[] };
      const error = new DocumentOperationError(data.code, data.message, data.paths, data.recovery_id, data.warnings);
      if (error.code === 'RecoveryRequired') window.dispatchEvent(new CustomEvent('document-recovery-required', { detail: error }));
      throw error;
    }
    throw failure;
  }
}

async function invokePathMutation<T = string>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invokeDocument<T>(command, { ...args, allowWarnings: false });
  } catch (error) {
    if (!(error instanceof DocumentOperationError) || error.code !== 'ConfirmationRequired') throw error;
    const message = [error.message, ...error.warnings.map(warning => `${warning.path}: ${warning.message}`)].join('\n');
    if (!(await confirm(message, { title: 'MiaoYan', kind: 'warning' }))) {
      throw new DocumentOperationError('Cancelled', 'Operation cancelled');
    }
    return invokeDocument<T>(command, { ...args, allowWarnings: true });
  }
}

export const resolveDocument = (path: string) => invokeDocument<string>('resolve_document', { path });
export const getDocumentRecoveries = () => invokeDocument<RecoveryInfo[]>('get_document_recoveries');
export const retryDocumentRecovery = (transactionId: string) => invokeDocument<void>('retry_document_recovery', { transactionId });

export interface ScanEvent<T> { scan_id: string; data: T }
interface ScanSource { id: string; order: number; epoch: number; root: string; roots: string[]; lane: string; retired: boolean }
interface ScanLane { generation: number; sources: Set<ScanSource>; invalidations: number; releasing: boolean }
const scanKey = (rootPath: string, extraFolders: string[]) => JSON.stringify([pathIdentity(rootPath), ...extraFolders.map(pathIdentity)]);
let sourceOrder = 0, sourceEpoch = 0;
let configuredRoot: string | null = null;
let projectSource: ScanSource | null = null, noteSource: ScanSource | null = null;
const folderSources = new Map<string, ScanSource>();
const scanIds = new WeakMap<Promise<unknown>, string>();
const scanLanes = new Map<string, ScanLane>();
let scanSession: Promise<string> | null = null;

function getScanSession(): Promise<string> {
  if (scanSession === null) {
    const pending = invoke<string>('start_scan_session');
    scanSession = pending;
    void pending.catch(() => { if (scanSession === pending) scanSession = null; });
  }
  return scanSession;
}

async function releaseScanLane(lane: string, state: ScanLane) {
  if (state.sources.size > 0 || state.invalidations > 0 || state.releasing) return;
  state.releasing = true;
  const generation = state.generation;
  try {
    if (scanSession !== null) {
      const sessionId = await scanSession;
      await invoke('release_scan_lane', { sessionId, lane, generation });
    }
  } catch (error) { console.warn('Scan cleanup failed:', error); }
  finally {
    state.releasing = false;
    if (scanLanes.get(lane) === state && state.sources.size === 0 && state.invalidations === 0) {
      if (state.generation === generation) scanLanes.delete(lane);
      else void releaseScanLane(lane, state);
    }
  }
}

function retireScan(source: ScanSource | null) {
  if (!source || source.retired) return;
  source.retired = true;
  const state = scanLanes.get(source.lane);
  if (!state || !state.sources.has(source)) return;
  const generation = ++sourceOrder;
  state.generation = generation;
  state.invalidations++;
  const session = getScanSession();
  void session.then(sessionId => invoke('invalidate_scan', { sessionId, lane: source.lane, generation }))
    .catch(error => window.dispatchEvent(new CustomEvent('show-toast', { detail: { type: 'warning', message: `Scan cancellation failed: ${String(error)}` } })))
    .finally(() => { state.invalidations--; void releaseScanLane(source.lane, state); });
}

function invokeScan<T>(command: string, args: Record<string, unknown>, source: ScanSource): Promise<T> {
  const session = getScanSession();
  let state = scanLanes.get(source.lane);
  if (!state) { state = { generation: source.order, sources: new Set(), invalidations: 0, releasing: false }; scanLanes.set(source.lane, state); }
  state.generation = Math.max(state.generation, source.order);
  state.sources.add(source);
  const laneState = state;
  return (async () => {
    const sessionId = await session;
    if (source.retired) throw new Error('Scan canceled');
    const result = await invoke<T>(command, { ...args, scanId: source.id, sessionId, lane: source.lane, generation: source.order });
    if (source.retired) throw new Error('Scan canceled');
    return result;
  })().finally(() => { laneState.sources.delete(source); void releaseScanLane(source.lane, laneState); });
}

export function getScanId(promise: Promise<unknown>): string { return scanIds.get(promise)!; }
let inflightProjects: { key: string; p: Promise<Project[]> } | null = null;
let inflightNotes: { key: string; p: Promise<NoteMetadata[]> } | null = null;

function newScanSource(root: string, extras: string[], lane: string, id: string = crypto.randomUUID()): ScanSource {
  return { id, order: ++sourceOrder, epoch: sourceEpoch, root: pathIdentity(root), roots: [root, ...extras].filter(Boolean).map(pathIdentity), lane, retired: false };
}

function pruneFolderSources(root: string, extras: string[]) {
  const allowed = new Set([root, ...extras].filter(Boolean).map(pathIdentity));
  for (const [folder, source] of folderSources) if (!allowed.has(folder)) { retireScan(source); folderSources.delete(folder); }
}

export function setScanRoots(root: string, extras: string[]) {
  const key = pathIdentity(root);
  if (configuredRoot !== key) {
    configuredRoot = key;
    sourceEpoch++;
    retireScan(projectSource); retireScan(noteSource);
    projectSource = null; noteSource = null;
    inflightProjects = null; inflightNotes = null;
  }
  pruneFolderSources(root, extras);
}

export function isCurrentScan(id: string, domain: 'notes' | 'projects' | 'progress', root: string, extras: string[]): boolean {
  pruneFolderSources(root, extras);
  const whole = domain === 'projects' ? projectSource : noteSource;
  if (whole?.id === id && whole.epoch === sourceEpoch && whole.root === pathIdentity(root)) return true;
  const folder = [...folderSources.values()].find(source => source.id === id);
  if (!folder) return false;
  return domain === 'progress' || !whole || whole.epoch !== sourceEpoch || whole.root !== pathIdentity(root) || whole.order < folder.order || !whole.roots.includes(folder.root);
}

export function getProjects(rootPath: string, extraFolders: string[] = []): Promise<Project[]> {
  const key = scanKey(rootPath, extraFolders);
  if (!inflightProjects || inflightProjects.key !== key) {
    retireScan(projectSource);
    projectSource = newScanSource(rootPath, extraFolders, 'projects');
    const scanId = projectSource.id;
    const p = invokeScan<Project[]>('get_projects', { rootPath, extraFolders }, projectSource)
      .finally(() => { if (inflightProjects && inflightProjects.p === p) inflightProjects = null; });
    scanIds.set(p, scanId);
    inflightProjects = { key, p };
  }
  return inflightProjects.p;
}

export function getAllNotes(rootPath: string, extraFolders: string[] = []): Promise<NoteMetadata[]> {
  const key = scanKey(rootPath, extraFolders);
  if (!inflightNotes || inflightNotes.key !== key) {
    retireScan(noteSource);
    noteSource = newScanSource(rootPath, extraFolders, 'notes');
    const scanId = noteSource.id;
    const p = invokeScan<NoteMetadata[]>('get_all_notes', { rootPath, extraFolders }, noteSource)
      .finally(() => { if (inflightNotes && inflightNotes.p === p) inflightNotes = null; });
    scanIds.set(p, scanId);
    inflightNotes = { key, p };
  }
  return inflightNotes.p;
}

export function scanFolder(folder: string, scanId: string = crypto.randomUUID()): Promise<NoteMetadata[]> {
  const key = pathIdentity(folder);
  retireScan(folderSources.get(key) ?? null);
  const source = newScanSource(folder, [], `folder:${key}`, scanId);
  folderSources.set(key, source);
  const promise = invokeScan<NoteMetadata[]>('scan_folder', { folder }, source);
  scanIds.set(promise, scanId);
  return promise;
}

export async function getNotesInFolder(folderPath: string, rootPath: string): Promise<NoteMetadata[]> {
  return invoke('get_notes_in_folder', { folderPath, rootPath });
}

export async function scopeRootsOverlap(removedRoots: string[], roots: string[]): Promise<boolean> {
  return invoke('scope_roots_overlap', { removedRoots, roots });
}

export async function readDirectorySnapshot(path: string): Promise<{ project: Project | null; notes: NoteMetadata[] }> {
  return invoke('read_directory_snapshot', { path });
}

export async function getNotesMetadata(paths: string[], rootPath: string, extraFolders: string[] = []): Promise<NoteMetadata[]> {
  return invoke('get_notes_metadata', { paths, rootPath, extraFolders });
}

export async function readNote(path: string): Promise<NoteContent> {
  return invoke('read_note', { path });
}

export async function writeNote(path: string, content: string, expectedVersion: string): Promise<string> {
  return invokeDocument('write_note', { path, content, expectedVersion });
}

export async function saveDocumentCopy(sourcePath: string, targetPath: string, content: string, annotationDraft?: string, password?: string): Promise<NoteContent> {
  return invokePathMutation<NoteContent>('save_document_copy', { sourcePath, targetPath, content, annotationDraft, password });
}

export async function createNote(folderPath: string, title: string): Promise<NoteMetadata & { disk_version: string }> {
  return invokeDocument('create_note', { folderPath, title });
}

export async function deleteNote(path: string): Promise<void> {
  return invokeDocument('delete_note', { path });
}

export async function renameNote(oldPath: string, newTitle: string): Promise<string> {
  return invokePathMutation('rename_note', { oldPath, newTitle });
}

export async function createFolder(parentPath: string, name: string): Promise<string> {
  return invokeDocument('create_folder', { parentPath, name });
}

export async function startSearchSession(): Promise<string> {
  return invoke('start_search_session');
}

export async function invalidateSearch(sessionId: string, generation: number): Promise<void> {
  return invoke('invalidate_search', { sessionId, generation });
}

export async function searchNotes(rootPath: string, query: string, extraFolders: string[], sessionId: string, generation: number): Promise<NoteMetadata[]> {
  return invoke('search_notes', { rootPath, query, extraFolders, sessionId, generation });
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
  document_id: string;
  timestamp: string;
  filename: string;
  size: number;
}

export async function saveVersion(notePath: string, documentId: string, content: string, password?: string): Promise<VersionEntry> {
  return invokeDocument('save_version', { notePath, documentId, content, ...(password === undefined ? {} : { password }) });
}

export async function listVersions(notePath: string): Promise<VersionEntry[]> {
  return invokeDocument('list_versions', { notePath });
}

export async function getVersion(notePath: string, version: VersionEntry, password?: string): Promise<string> {
  return invokeDocument('get_version', { notePath, documentId: version.document_id, versionFilename: version.filename, ...(password === undefined ? {} : { password }) });
}

export async function restoreVersion(notePath: string, version: VersionEntry, password?: string): Promise<void> {
  return invokeDocument('restore_version', { notePath, documentId: version.document_id, versionFilename: version.filename, ...(password === undefined ? {} : { password }) });
}

// Pin Management
export async function getPinnedNotes(): Promise<string[]> {
  return invokeDocument('get_pinned_notes');
}

export async function togglePin(notePath: string): Promise<string[]> {
  return invokeDocument('toggle_pin', { notePath });
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
export async function encryptNote(path: string, password: string, expectedVersion?: string): Promise<NoteContent> {
  return invokeDocument('encrypt_note', { path, password, expectedVersion });
}

export async function decryptNote(path: string, password: string): Promise<NoteContent> {
  return invokeDocument<NoteContent>('decrypt_note', { path, password });
}

export async function verifyPassword(path: string, password: string): Promise<boolean> {
  return invoke<boolean>('verify_password', { path, password });
}

export async function saveEncryptedNote(path: string, content: string, password: string, expectedVersion: string): Promise<string> {
  return invokeDocument('save_encrypted_note', { path, content, password, expectedVersion });
}

export async function removeEncryption(path: string, password: string, expectedVersion?: string): Promise<NoteContent> {
  return invokeDocument('remove_encryption', { path, password, expectedVersion });
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
  return invokePathMutation('move_note', { sourcePath, targetFolder });
}

export async function renameFolder(oldPath: string, newName: string): Promise<string> {
  return invokePathMutation('rename_folder', { oldPath, newName });
}

export async function deleteFolder(path: string): Promise<void> {
  return invokeDocument('delete_folder', { path });
}

export async function revealInFinder(path: string): Promise<void> {
  return invoke('reveal_in_finder', { path });
}

export async function openInTerminal(path: string): Promise<void> {
  return invoke('open_in_terminal', { path });
}

/* ── Annotations ── */

export interface AnnotationDocument { document_id: string; json: string; disk_version?: string }

export async function readAnnotations(notePath: string, password?: string): Promise<AnnotationDocument> {
  return invokeDocument('read_annotations', { notePath, ...(password === undefined ? {} : { password }) });
}

export async function writeAnnotations(notePath: string, documentId: string, json: string, expectedVersion: string, password?: string): Promise<string> {
  return invokeDocument('write_annotations', { notePath, documentId, json, expectedVersion, ...(password === undefined ? {} : { password }) });
}

export async function deleteAnnotations(notePath: string, documentId: string, expectedVersion: string, password?: string): Promise<string> {
  return invokeDocument('delete_annotations', { notePath, documentId, expectedVersion, ...(password === undefined ? {} : { password }) });
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
