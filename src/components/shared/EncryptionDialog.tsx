import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { encryptNote, decryptNote, saveEncryptedNote, removeEncryption } from '../../services/tauri-bridge';

export interface EncryptionDialogProps {
  mode: 'unlock' | 'encrypt' | 'remove';
  notePath: string;
  visible: boolean;
  onClose: () => void;
  onUnlocked?: (content: string, password: string) => void;
  onEncrypted?: () => void;
  onRemoved?: () => void;
}

const IconLock = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

const IconUnlock = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 9.9-1" />
  </svg>
);

const IconEye = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const IconEyeOff = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

export function EncryptionDialog({
  mode,
  notePath,
  visible,
  onClose,
  onUnlocked,
  onEncrypted,
  onRemoved,
}: EncryptionDialogProps) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (visible) {
      setPassword('');
      setConfirmPassword('');
      setError('');
      setShowPassword(false);
      setShowConfirm(false);
      setTimeout(() => passwordRef.current?.focus(), 50);
    }
  }, [visible]);

  if (!visible) return null;

  const handleSubmit = async () => {
    setError('');
    if (!password) {
      setError(t('encryption.password'));
      return;
    }

    if (mode === 'encrypt' && password !== confirmPassword) {
      setError(t('encryption.mismatch'));
      return;
    }

    setIsLoading(true);
    try {
      if (mode === 'unlock') {
        const content = await decryptNote(notePath, password);
        onUnlocked?.(content, password);
        onClose();
      } else if (mode === 'encrypt') {
        await encryptNote(notePath, password);
        onEncrypted?.();
        onClose();
      } else if (mode === 'remove') {
        await removeEncryption(notePath, password);
        onRemoved?.();
        onClose();
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Invalid password') || msg.includes('corrupted')) {
        setError(t('encryption.wrongPassword'));
      } else {
        setError(msg);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSubmit();
    if (e.key === 'Escape') onClose();
  };

  const title =
    mode === 'unlock'
      ? t('encryption.unlock')
      : mode === 'remove'
      ? t('encryption.removeEncryption')
      : t('encryption.encrypt');

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center dialog-overlay"
      style={{ backdropFilter: 'blur(8px)', backgroundColor: 'rgba(0,0,0,0.45)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="rounded-2xl shadow-2xl p-6 w-[340px] dialog-content"
        style={{
          backgroundColor: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
        }}
      >
        {/* Icon + Title */}
        <div className="flex flex-col items-center mb-5">
          <span style={{ color: 'var(--accent)' }}>
            {mode === 'unlock' ? <IconUnlock /> : <IconLock />}
          </span>
          <h2 className="mt-2 text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
            {title}
          </h2>
        </div>

        {/* Password field */}
        <div className="mb-3">
          <label className="block text-xs mb-1.5" style={{ color: 'var(--text-secondary)' }}>
            {t('encryption.password')}
          </label>
          <div className="flex items-center rounded-lg px-3 py-2 gap-2"
            style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}>
            <input
              ref={passwordRef}
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 bg-transparent outline-none text-sm"
              style={{ color: 'var(--text-primary)' }}
              autoComplete="current-password"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              style={{ color: 'var(--text-tertiary)' }}
            >
              {showPassword ? <IconEyeOff /> : <IconEye />}
            </button>
          </div>
        </div>

        {/* Confirm password (encrypt mode only) */}
        {mode === 'encrypt' && (
          <div className="mb-3">
            <label className="block text-xs mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              {t('encryption.confirmPassword')}
            </label>
            <div className="flex items-center rounded-lg px-3 py-2 gap-2"
              style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}>
              <input
                type={showConfirm ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                onKeyDown={handleKeyDown}
                className="flex-1 bg-transparent outline-none text-sm"
                style={{ color: 'var(--text-primary)' }}
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowConfirm((v) => !v)}
                style={{ color: 'var(--text-tertiary)' }}
              >
                {showConfirm ? <IconEyeOff /> : <IconEye />}
              </button>
            </div>
          </div>
        )}

        {/* Warning */}
        {(mode === 'encrypt') && (
          <p className="text-xs mb-3 px-1" style={{ color: 'var(--danger-color)' }}>
            ⚠ {t('encryption.warning')}
          </p>
        )}

        {/* Error */}
        {error && (
          <p className="text-xs mb-3 px-1" style={{ color: 'var(--danger-color)' }}>
            {error}
          </p>
        )}

        {/* Buttons */}
        <div className="flex gap-2 mt-2">
          <button
            onClick={onClose}
            className="flex-1 py-2 rounded-lg text-sm transition-colors"
            style={{
              backgroundColor: 'var(--bg-tertiary)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
            }}
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            onClick={handleSubmit}
            disabled={isLoading}
            className="flex-1 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{
              backgroundColor: 'var(--accent)',
              color: 'var(--text-inverse)',
              opacity: isLoading ? 0.7 : 1,
            }}
          >
            {isLoading ? '...' : t('common.confirm', 'OK')}
          </button>
        </div>
      </div>
    </div>
  );
}
