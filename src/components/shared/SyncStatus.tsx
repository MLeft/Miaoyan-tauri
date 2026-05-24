import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { detectCloudSync, getSyncStatus, type CloudSyncInfo } from '../../services/tauri-bridge';
import { useSettingsStore } from '../../stores/settings-store';

interface SyncStatusProps {
  /** 紧凑模式：只显示图标 */
  compact?: boolean;
}

export function SyncStatusIndicator({ compact = false }: SyncStatusProps) {
  const { t } = useTranslation();
  const { config } = useSettingsStore();
  const [cloudInfo, setCloudInfo] = useState<CloudSyncInfo | null>(null);
  const [fileSyncStatus, setFileSyncStatus] = useState<string>('unavailable');
  const [showTooltip, setShowTooltip] = useState(false);

  // 检测 iCloud 可用性
  useEffect(() => {
    detectCloudSync()
      .then(setCloudInfo)
      .catch(() => setCloudInfo({ status: 'Unavailable', icloud_path: null }));
  }, []);

  // 监听存储路径变化，检测路径同步状态
  useEffect(() => {
    if (!config.storage_path) return;
    getSyncStatus(config.storage_path)
      .then(setFileSyncStatus)
      .catch(() => setFileSyncStatus('unavailable'));
  }, [config.storage_path]);

  // 不在 iCloud 目录内，且 iCloud 不可用时不显示
  if (!cloudInfo || (cloudInfo.status === 'Unavailable' && fileSyncStatus === 'unavailable')) {
    return null;
  }

  const isInIcloud = fileSyncStatus !== 'unavailable';

  // 若存储路径不在 iCloud 中，不展示状态图标
  if (!isInIcloud) return null;

  const statusIcon = (() => {
    if (fileSyncStatus === 'syncing') {
      return (
        <svg
          width="12" height="12" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
          style={{ animation: 'spin 1.5s linear infinite', color: 'var(--system-blue)' }}
        >
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      );
    }
    if (fileSyncStatus === 'synced') {
      return (
        <span style={{
          width: 8, height: 8,
          borderRadius: '50%',
          backgroundColor: 'var(--success-color)',
          display: 'inline-block',
          flexShrink: 0,
        }} />
      );
    }
    // unavailable
    return (
      <span style={{
        width: 8, height: 8,
        borderRadius: '50%',
        backgroundColor: 'var(--text-tertiary)',
        display: 'inline-block',
        flexShrink: 0,
        opacity: 0.5,
      }} />
    );
  })();

  const statusLabel = fileSyncStatus === 'syncing'
    ? t('sync.syncing')
    : fileSyncStatus === 'synced'
      ? t('sync.synced')
      : t('sync.unavailable');

  return (
    <div
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'default' }}>
        {statusIcon}
        {!compact && (
          <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{statusLabel}</span>
        )}
      </div>
      {showTooltip && compact && (
        <div style={{
          position: 'absolute',
          bottom: '100%',
          left: '50%',
          transform: 'translateX(-50%)',
          marginBottom: 6,
          backgroundColor: 'var(--bg-secondary)',
          border: '0.5px solid var(--border)',
          borderRadius: 6,
          padding: '4px 8px',
          fontSize: 11,
          color: 'var(--text-primary)',
          whiteSpace: 'nowrap',
          boxShadow: 'var(--shadow-sm)',
          zIndex: 9999,
          pointerEvents: 'none',
        }}>
          iCloud · {statusLabel}
        </div>
      )}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
