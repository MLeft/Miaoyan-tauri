import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm, save } from '@tauri-apps/plugin-dialog';
import { useShallow } from 'zustand/react/shallow';
import { useNotesStore } from '../../stores/notes-store';

export function SaveFailureBanner() {
  const { t } = useTranslation();
  const failures = useNotesStore(useShallow(state => state.openTabs.filter(tab => tab.saveError)));
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const running = useRef(false);

  const recover = async (path: string, action: 'retry' | 'copy' | 'discard') => {
    if (running.current) return;
    const store = useNotesStore.getState();
    const snapshot = store.getDocumentSession(path);
    if (!snapshot) return;
    running.current = true;
    setPending(path); setActionError('');
    try {
      if (action === 'retry') {
        await store.saveDocument(path, snapshot.identity);
      } else if (action === 'copy') {
        const filename = path.split(/[\\/]/).pop() ?? path;
        const target = await save({ title: t('saveRecovery.copy'), defaultPath: path.replace(filename, `recovered-${filename}`) });
        if (!target) return;
        if (!(await store.saveDocumentCopy(path, snapshot.identity, target))) setActionError(t('saveRecovery.changed'));
      } else {
        if (!(await confirm(t('saveRecovery.discardWarning'), { title: t('saveRecovery.discard'), kind: 'warning', okLabel: t('saveRecovery.discard'), cancelLabel: t('common.cancel', 'Cancel') }))) return;
        if (!store.discardDocument(path, snapshot.identity, snapshot.revision)) setActionError(t('saveRecovery.changed'));
      }
    } catch (error) {
      setActionError(String(error));
    } finally { running.current = false; setPending(null); }
  };

  if (!failures.length && !actionError) return null;
  return <div role="alert" className="flex-shrink-0 px-3 py-2 text-xs space-y-2" style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', borderBottom: '1px solid var(--border)' }}>
    <p>{t('saveRecovery.description')}</p>
    {failures.map(tab => <div key={tab.path} className="space-y-1">
      <p className="break-all">{tab.note.title} — {tab.saveError}</p>
      <div className="flex flex-wrap gap-2">
        <button disabled={pending !== null} className="rounded border px-2 py-1 disabled:opacity-50" onClick={() => void recover(tab.path, 'retry')}>{t('saveRecovery.retry')}</button>
        <button disabled={pending !== null} className="rounded border px-2 py-1 disabled:opacity-50" onClick={() => void recover(tab.path, 'copy')}>{t('saveRecovery.copy')}</button>
        <button disabled={pending !== null} className="rounded border px-2 py-1 disabled:opacity-50" onClick={() => void recover(tab.path, 'discard')}>{t('saveRecovery.discard')}</button>
      </div>
    </div>)}
    {pending && <p role="status">{t('app.loading')}</p>}
    {actionError && <p className="break-all">{actionError}</p>}
  </div>;
}
