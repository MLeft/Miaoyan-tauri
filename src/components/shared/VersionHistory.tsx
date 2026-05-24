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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center dialog-overlay"
      style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
      onClick={onClose}
    >
      <div
        className="w-[700px] max-h-[500px] rounded-lg overflow-hidden flex flex-col dialog-content"
        style={{
          backgroundColor: 'var(--bg-secondary)',
          boxShadow: 'var(--shadow-lg)',
          border: '1px solid var(--border)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Version History</h2>
          <button onClick={onClose} className="text-lg btn-hover-transition" style={{ color: 'var(--text-tertiary)' }}>&times;</button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Version list */}
          <div className="w-56 overflow-y-auto" style={{ borderRight: '1px solid var(--border)' }}>
            {versions.length === 0 ? (
              <p className="p-4 text-sm" style={{ color: 'var(--text-tertiary)' }}>No version history</p>
            ) : (
              versions.map((v) => (
                <button
                  key={v.filename}
                  onClick={() => handlePreview(v)}
                  className="w-full text-left px-4 py-2 text-xs btn-hover-transition"
                  style={{
                    borderBottom: '1px solid var(--border-light)',
                    backgroundColor: selectedVersion === v.filename ? 'var(--accent-light)' : 'transparent',
                    color: 'var(--text-primary)',
                  }}
                  onMouseEnter={(e) => { if (selectedVersion !== v.filename) e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'; }}
                  onMouseLeave={(e) => { if (selectedVersion !== v.filename) e.currentTarget.style.backgroundColor = 'transparent'; }}
                >
                  <div style={{ color: 'var(--text-primary)' }}>{formatTimestamp(v.timestamp)}</div>
                  <div className="mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{(v.size / 1024).toFixed(1)} KB</div>
                </button>
              ))
            )}
          </div>

          {/* Preview */}
          <div className="flex-1 overflow-y-auto p-4">
            {previewContent !== null ? (
              <pre className="text-xs whitespace-pre-wrap leading-relaxed font-code" style={{ color: 'var(--text-primary)' }}>
                {previewContent}
              </pre>
            ) : (
              <p className="text-sm text-center mt-8" style={{ color: 'var(--text-tertiary)' }}>Select a version to preview</p>
            )}
          </div>
        </div>

        {/* Actions */}
        {selectedVersion && (
          <div className="flex justify-end px-5 py-3" style={{ borderTop: '1px solid var(--border)' }}>
            <button
              onClick={handleRestore}
              className="px-4 py-1.5 text-sm rounded btn-hover-transition"
              style={{
                backgroundColor: 'var(--accent)',
                color: 'var(--text-inverse)',
              }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--accent-hover)'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'var(--accent)'}
            >
              Restore this version
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
