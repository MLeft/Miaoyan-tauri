import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getDocumentRecoveries, retryDocumentRecovery } from '../../services/tauri-bridge';
import type { RecoveryInfo } from '../../services/tauri-bridge';
import { useNotesStore } from '../../stores/notes-store';

export function RecoveryBanner() {
  const { t } = useTranslation();
  const [recoveries, setRecoveries] = useState<RecoveryInfo[]>([]);
  const [queryError, setQueryError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const pending = useRef(false);
  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    const request = ++generation.current;
    try {
      const result = await getDocumentRecoveries();
      if (!mounted.current || generation.current !== request) return;
      setRecoveries(result);
      setQueryError('');
      useNotesStore.getState().setRecoveryPaths(result.flatMap(item => item.paths));
    } catch (error) {
      if (mounted.current && generation.current === request) setQueryError(String(error));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const update = (event: Event) => {
      const paths = (event as CustomEvent<{ paths?: string[] }>).detail?.paths;
      if (paths) useNotesStore.getState().setRecoveryPaths([...useNotesStore.getState().recoveryPaths, ...paths]);
      void refresh();
    };
    void refresh();
    window.addEventListener('document-recovery-required', update);
    window.addEventListener('document-recovery-refresh', update);
    return () => {
      mounted.current = false;
      ++generation.current;
      window.removeEventListener('document-recovery-required', update);
      window.removeEventListener('document-recovery-refresh', update);
    };
  }, [refresh]);

  const retry = async (transactionId: string) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(transactionId);
    setActionError('');
    try {
      await retryDocumentRecovery(transactionId);
      await refresh();
    } catch (error) {
      if (mounted.current) setActionError(String(error));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  if (!recoveries.length && !queryError) return null;
  return (
    <section role="alert" className="shrink-0 px-3 py-2 text-xs" style={{ backgroundColor: 'var(--warning-bg)', color: 'var(--text-primary)', borderBottom: '1px solid var(--border)' }}>
      <strong>{t('recovery.title')}</strong>
      <span className="ml-2">{t('recovery.description')}</span>
      {recoveries.map(item => (
        <div key={item.transaction_id} className="flex items-start gap-3 mt-2">
          <button disabled={busy !== null} onClick={() => { void retry(item.transaction_id); }} className="shrink-0 border rounded px-2 py-1" style={{ borderColor: 'var(--border)', opacity: busy ? 0.6 : 1 }}>
            {busy === item.transaction_id ? t('recovery.working') : t('recovery.retry')}
          </button>
          <details className="min-w-0 flex-1">
            <summary className="cursor-pointer">{t('recovery.details')}</summary>
            <div className="overflow-auto mt-1" style={{ maxHeight: 120 }}>
              {item.paths.map((path, index) => <div key={`${index}-${path}`} className="whitespace-nowrap select-text">{path}</div>)}
            </div>
          </details>
        </div>
      ))}
      {queryError && <button disabled={busy !== null} className="ml-2 border rounded px-2 py-1" onClick={() => { void refresh(); }}>{t('recovery.refresh')}</button>}
      {(queryError || actionError) && <div className="mt-2 select-text" style={{ color: 'var(--danger-color)', overflowWrap: 'anywhere' }}>{queryError || actionError}</div>}
    </section>
  );
}
