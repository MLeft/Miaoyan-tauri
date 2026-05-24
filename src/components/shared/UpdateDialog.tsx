import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { relaunch } from '@tauri-apps/plugin-process';
import type { Update } from '@tauri-apps/plugin-updater';

interface UpdateDialogProps {
  visible: boolean;
  update: Update | null;
  currentVersion: string;
  onClose: () => void;
  onSkip: (version: string) => void;
}

type DownloadState = 'idle' | 'downloading' | 'ready' | 'error';

export function UpdateDialog({ visible, update, currentVersion, onClose, onSkip }: UpdateDialogProps) {
  const { t } = useTranslation();
  const [downloadState, setDownloadState] = useState<DownloadState>('idle');
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');

  if (!visible || !update) return null;

  const progressPercent =
    totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;

  const handleInstall = async () => {
    if (downloadState === 'downloading') return;
    setDownloadState('downloading');
    setDownloadedBytes(0);
    setTotalBytes(0);
    setErrorMsg('');

    try {
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          setTotalBytes(event.data.contentLength ?? 0);
        } else if (event.event === 'Progress') {
          setDownloadedBytes((prev) => prev + (event.data.chunkLength ?? 0));
        } else if (event.event === 'Finished') {
          setDownloadState('ready');
        }
      });
      setDownloadState('ready');
      await relaunch();
    } catch (err) {
      console.error('Update failed:', err);
      setErrorMsg(String(err));
      setDownloadState('error');
    }
  };

  const handleSkip = () => {
    onSkip(update.version);
    onClose();
  };

  const isDownloading = downloadState === 'downloading';
  const isReady = downloadState === 'ready';

  return (
    /* Backdrop */
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        backgroundColor: 'rgba(0,0,0,0.45)',
      }}
      className="dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isDownloading) onClose();
      }}
    >
      {/* Dialog card */}
      <div
        style={{
          width: 440,
          maxWidth: 'calc(100vw - 48px)',
          borderRadius: 14,
          padding: '28px 32px 24px',
          backgroundColor: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-lg)',
          position: 'relative',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title row */}
        <div style={{ marginBottom: 20 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginBottom: 6,
            }}
          >
            {/* Update icon */}
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                background: 'var(--accent)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </div>
            <h2
              style={{
                margin: 0,
                fontSize: 17,
                fontWeight: 600,
                color: 'var(--text-primary)',
              }}
            >
              {t('update.title')}
            </h2>
          </div>

          {/* Version info */}
          <div
            style={{
              display: 'flex',
              gap: 24,
              padding: '10px 14px',
              borderRadius: 8,
              backgroundColor: 'var(--bg-tertiary)',
              marginTop: 12,
            }}
          >
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>
                {t('update.current')}
              </div>
              <div style={{ fontSize: 14, color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                v{currentVersion}
              </div>
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                color: 'var(--text-tertiary)',
                fontSize: 18,
                alignSelf: 'center',
              }}
            >
              →
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>
                {t('update.new')}
              </div>
              <div
                style={{
                  fontSize: 14,
                  color: 'var(--accent)',
                  fontWeight: 600,
                  fontFamily: 'monospace',
                }}
              >
                v{update.version}
              </div>
            </div>
          </div>
        </div>

        {/* Changelog */}
        {update.body && (
          <div style={{ marginBottom: 20 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--text-tertiary)',
                marginBottom: 6,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              {t('update.changelog')}
            </div>
            <div
              style={{
                maxHeight: 140,
                overflowY: 'auto',
                padding: '10px 12px',
                borderRadius: 8,
                backgroundColor: 'var(--bg-tertiary)',
                fontSize: 13,
                lineHeight: 1.6,
                color: 'var(--text-secondary)',
                whiteSpace: 'pre-wrap',
              }}
            >
              {update.body}
            </div>
          </div>
        )}

        {/* Progress bar */}
        {isDownloading && (
          <div style={{ marginBottom: 18 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 12,
                color: 'var(--text-tertiary)',
                marginBottom: 6,
              }}
            >
              <span>{t('update.downloading')}</span>
              {totalBytes > 0 && <span>{progressPercent}%</span>}
            </div>
            <div
              style={{
                height: 6,
                borderRadius: 3,
                backgroundColor: 'var(--bg-tertiary)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  borderRadius: 3,
                  backgroundColor: 'var(--accent)',
                  width: totalBytes > 0 ? `${progressPercent}%` : '100%',
                  transition: 'width 0.2s ease',
                  animation: totalBytes === 0 ? 'indeterminate 1.2s ease-in-out infinite' : 'none',
                }}
              />
            </div>
          </div>
        )}

        {/* Ready state */}
        {isReady && (
          <div
            style={{
              marginBottom: 18,
              padding: '10px 14px',
              borderRadius: 8,
              backgroundColor: 'var(--success-bg)',
              border: '1px solid var(--success-border)',
              fontSize: 13,
              color: 'var(--success-color)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {t('update.ready')}
          </div>
        )}

        {/* Error state */}
        {downloadState === 'error' && (
          <div
            style={{
              marginBottom: 18,
              padding: '10px 14px',
              borderRadius: 8,
              backgroundColor: 'var(--danger-bg)',
              border: '1px solid var(--danger-border)',
              fontSize: 12,
              color: 'var(--danger-color)',
            }}
          >
            {errorMsg || 'Update failed'}
          </div>
        )}

        {/* Buttons */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {!isDownloading && !isReady && (
            <>
              <button
                onClick={handleSkip}
                style={{
                  padding: '7px 14px',
                  borderRadius: 7,
                  border: '1px solid var(--border)',
                  backgroundColor: 'transparent',
                  color: 'var(--text-tertiary)',
                  fontSize: 13,
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              >
                {t('update.skip')}
              </button>
              <button
                onClick={onClose}
                style={{
                  padding: '7px 14px',
                  borderRadius: 7,
                  border: '1px solid var(--border)',
                  backgroundColor: 'var(--bg-tertiary)',
                  color: 'var(--text-secondary)',
                  fontSize: 13,
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--bg-primary)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'; }}
              >
                {t('update.later')}
              </button>
              <button
                onClick={handleInstall}
                style={{
                  padding: '7px 18px',
                  borderRadius: 7,
                  border: 'none',
                  backgroundColor: 'var(--accent)',
                  color: 'white',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--accent-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--accent)'; }}
              >
                {t('update.install')}
              </button>
            </>
          )}
          {isDownloading && (
            <button
              disabled
              style={{
                padding: '7px 18px',
                borderRadius: 7,
                border: 'none',
                backgroundColor: 'var(--accent)',
                color: 'white',
                fontSize: 13,
                fontWeight: 600,
                opacity: 0.65,
                cursor: 'not-allowed',
              }}
            >
              {t('update.downloading')}
            </button>
          )}
        </div>
      </div>

      <style>{`
        @keyframes indeterminate {
          0% { transform: translateX(-100%) scaleX(0.3); }
          50% { transform: translateX(0%) scaleX(0.6); }
          100% { transform: translateX(100%) scaleX(0.3); }
        }
      `}</style>
    </div>
  );
}
