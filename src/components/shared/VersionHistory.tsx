import { useState, useEffect } from 'react';
import { useNotesStore } from '../../stores/notes-store';
import { listVersions, getVersion, restoreVersion } from '../../services/tauri-bridge';
import type { VersionEntry } from '../../services/tauri-bridge';

interface Props {
  onClose: () => void;
}

export function VersionHistory({ onClose }: Props) {
  const { activeNote, selectNote } = useNotesStore();
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!activeNote) return;
    loadVersions();
  }, [activeNote?.path]);

  const loadVersions = async () => {
    if (!activeNote) return;
    try {
      const v = await listVersions(activeNote.path);
      setVersions(v);
    } catch (e) {
      console.error('Failed to load versions:', e);
    }
  };

  const handlePreview = async (version: VersionEntry) => {
    if (!activeNote) return;
    setSelectedVersion(version.filename);
    try {
      const content = await getVersion(activeNote.path, version.filename);
      setPreviewContent(content);
    } catch (e) {
      console.error('Failed to load version:', e);
    }
  };

  const handleRestore = async () => {
    if (!activeNote || !selectedVersion) return;
    try {
      await restoreVersion(activeNote.path, selectedVersion);
      // Reload note
      await selectNote(activeNote);
      onClose();
    } catch (e) {
      console.error('Failed to restore version:', e);
    }
  };

  const formatTimestamp = (ts: string) => {
    // Format: 20250517_143022 -> 2025-05-17 14:30:22
    const match = ts.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/);
    if (match) {
      return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
    }
    return ts;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-[700px] max-h-[500px] bg-white dark:bg-gray-900 rounded-lg shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-200">Version History</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-lg">&times;</button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Version list */}
          <div className="w-56 border-r border-gray-200 dark:border-gray-700 overflow-y-auto">
            {versions.length === 0 ? (
              <p className="p-4 text-sm text-gray-400">No version history</p>
            ) : (
              versions.map((v) => (
                <button
                  key={v.filename}
                  onClick={() => handlePreview(v)}
                  className={`w-full text-left px-4 py-2 text-xs border-b border-gray-100 dark:border-gray-800 transition-colors
                    ${selectedVersion === v.filename ? 'bg-blue-50 dark:bg-blue-900/30' : 'hover:bg-gray-50 dark:hover:bg-gray-800'}
                  `}
                >
                  <div className="text-gray-700 dark:text-gray-300">{formatTimestamp(v.timestamp)}</div>
                  <div className="text-gray-400 mt-0.5">{(v.size / 1024).toFixed(1)} KB</div>
                </button>
              ))
            )}
          </div>

          {/* Preview */}
          <div className="flex-1 overflow-y-auto p-4">
            {previewContent !== null ? (
              <pre className="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap font-mono leading-relaxed">
                {previewContent}
              </pre>
            ) : (
              <p className="text-sm text-gray-400 text-center mt-8">Select a version to preview</p>
            )}
          </div>
        </div>

        {/* Actions */}
        {selectedVersion && (
          <div className="flex justify-end px-5 py-3 border-t border-gray-200 dark:border-gray-700">
            <button
              onClick={handleRestore}
              className="px-4 py-1.5 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
            >
              Restore this version
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
