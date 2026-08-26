import { useState, useRef, useEffect } from 'react';
import type { Annotation } from '../../types';

/* ── Icons (stroke-based, matching project style) ── */
const IconClipboard = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);
const IconX = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);
const IconCheck = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);
const IconUndo = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
  </svg>
);
const IconTrash = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

interface PendingSelection {
  quote: string;
  heading: string;
  paragraphIndex: number;
}

const IconEdit = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

interface AnnotationPanelProps {
  annotations: Annotation[];
  pendingSelection: PendingSelection | null;
  onAdd: (comment: string) => void;
  onDelete: (id: string) => void;
  onResolve: (id: string) => void;
  onReopen: (id: string) => void;
  onEdit: (id: string, newComment: string) => void;
  onCancelPending: () => void;
  onClearResolved: () => void;
  onScrollTo: (id: string) => void;
  onCopyReport: () => void;
  onClose: () => void;
}

export function AnnotationPanel({
  annotations,
  pendingSelection,
  onAdd,
  onDelete,
  onResolve,
  onReopen,
  onEdit,
  onCancelPending,
  onClearResolved,
  onScrollTo,
  onCopyReport,
  onClose,
}: AnnotationPanelProps) {
  const [comment, setComment] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const resolvedCount = annotations.filter(a => a.status === 'resolved').length;
  const allResolved = annotations.length > 0 && resolvedCount === annotations.length;

  // Auto-focus input when a new selection comes in
  useEffect(() => {
    if (pendingSelection && inputRef.current) {
      inputRef.current.focus();
    }
  }, [pendingSelection]);

  const handleSubmit = () => {
    if (!comment.trim()) return;
    onAdd(comment.trim());
    setComment('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Auto-resize edit textarea when entering edit mode
  useEffect(() => {
    if (editingId && editRef.current) {
      const el = editRef.current;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }
  }, [editingId]);

  return (
    <div
      className="h-full flex flex-col shrink-0"
      style={{
        width: '280px',
        backgroundColor: 'var(--bg-secondary)',
        borderLeft: '1px solid var(--border)',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between shrink-0"
        style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}
      >
        <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
          批注 ({annotations.length})
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={onCopyReport}
            className="text-xs rounded cursor-pointer flex items-center"
            style={{ padding: '2px 6px', color: 'var(--text-secondary)' }}
            title="复制批注报告"
          >
            <IconClipboard />
          </button>
          <button
            onClick={onClose}
            className="text-xs rounded cursor-pointer flex items-center"
            style={{ padding: '2px 6px', color: 'var(--text-secondary)' }}
            title="关闭面板"
          >
            <IconX />
          </button>
        </div>
      </div>

      {/* Pending selection input */}
      {pendingSelection && (
        <div className="shrink-0" style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
          <div
            className="text-xs rounded mb-2"
            style={{
              padding: '6px 8px',
              backgroundColor: 'var(--bg-tertiary)',
              color: 'var(--text-secondary)',
              maxHeight: '60px',
              overflow: 'hidden',
              borderLeft: '3px solid #d69e2e',
            }}
          >
            {pendingSelection.quote.length > 80
              ? pendingSelection.quote.substring(0, 80) + '…'
              : pendingSelection.quote}
          </div>
          {pendingSelection.heading && (
            <div className="text-xs mb-1" style={{ color: 'var(--text-muted, #999)' }}>
              § {pendingSelection.heading}
            </div>
          )}
          <textarea
            ref={inputRef}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入批注… (Enter 提交)"
            rows={2}
            className="w-full text-xs rounded resize-none outline-none"
            style={{
              padding: '6px 8px',
              backgroundColor: 'var(--bg-primary)',
              border: '1px solid var(--border)',
              color: 'var(--text-primary)',
            }}
          />
          <div className="flex justify-end gap-1 mt-1">
            <button
              onClick={onCancelPending}
              className="text-xs rounded cursor-pointer"
              style={{ padding: '3px 10px', color: 'var(--text-secondary)' }}
            >
              取消
            </button>
            <button
              onClick={handleSubmit}
              className="text-xs rounded cursor-pointer"
              style={{
                padding: '3px 10px',
                backgroundColor: 'var(--accent-icon, #2b6cb0)',
                color: '#fff',
              }}
            >
              添加
            </button>
          </div>
        </div>
      )}

      {/* Annotation list */}
      <div className="flex-1 overflow-y-auto" style={{ padding: '8px 12px' }}>
        {annotations.length === 0 && !pendingSelection && (
          <div className="text-xs text-center" style={{ color: 'var(--text-muted, #999)', marginTop: '20px' }}>
            暂无批注<br />开启批注模式后选中文字即可添加
          </div>
        )}
        {annotations.map((ann) => (
          <div
            key={ann.id}
            className="rounded-md mb-2 cursor-pointer"
            style={{
              padding: '8px 10px',
              backgroundColor: ann.status === 'resolved' ? 'rgba(72,187,120,0.06)' : 'var(--bg-tertiary)',
              border: `1px solid ${ann.status === 'resolved' ? 'rgba(72,187,120,0.3)' : 'var(--border)'}`,
              opacity: ann.status === 'resolved' ? 0.7 : 1,
            }}
            onClick={() => onScrollTo(ann.id)}
          >
            {/* Quote */}
            <div
              className="text-xs mb-1"
              style={{
                color: 'var(--text-secondary)',
                borderLeft: '2px solid #d69e2e',
                paddingLeft: '6px',
                maxHeight: '32px',
                overflow: 'hidden',
              }}
            >
              {ann.quote.length > 50 ? ann.quote.substring(0, 50) + '…' : ann.quote}
            </div>
            {/* Comment */}
            {editingId === ann.id ? (
              <div onClick={(e) => e.stopPropagation()}>
                <textarea
                  ref={editRef}
                  value={editText}
                  onChange={(e) => {
                    setEditText(e.target.value);
                    const el = e.target;
                    el.style.height = 'auto';
                    el.style.height = el.scrollHeight + 'px';
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if (editText.trim()) { onEdit(ann.id, editText.trim()); setEditingId(null); }
                    }
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  className="w-full text-xs rounded resize-none outline-none"
                  autoFocus
                  style={{
                    padding: '4px 6px',
                    backgroundColor: 'var(--bg-primary)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-primary)',
                    minHeight: '48px',
                    maxHeight: '120px',
                    overflow: 'auto',
                  }}
                />
                <div className="flex justify-end gap-1 mt-1">
                  <button
                    onClick={() => setEditingId(null)}
                    className="text-xs rounded cursor-pointer"
                    style={{ padding: '2px 8px', color: 'var(--text-secondary)' }}
                  >取消</button>
                  <button
                    onClick={() => { if (editText.trim()) { onEdit(ann.id, editText.trim()); setEditingId(null); } }}
                    className="text-xs rounded cursor-pointer"
                    style={{ padding: '2px 8px', backgroundColor: 'var(--accent-icon, #2b6cb0)', color: '#fff' }}
                  >保存</button>
                </div>
              </div>
            ) : (
              <div className="text-xs" style={{ color: 'var(--text-primary)' }}>
                {ann.comment}
              </div>
            )}
            {/* Meta + actions：标题截断、按钮容器禁止收缩，
                保证任何内容下 编辑/已解决/删除 按钮时刻可见 */}
            <div className="flex items-center justify-between gap-1 mt-1">
              <span
                className="text-xs truncate"
                style={{ color: 'var(--text-muted, #999)', fontSize: '10px', minWidth: 0, flex: '1 1 auto' }}
              >
                {ann.heading ? `§ ${ann.heading}` : ''}
              </span>
              <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                {ann.status === 'open' ? (
                  <button
                    onClick={() => onResolve(ann.id)}
                    className="cursor-pointer rounded flex items-center"
                    style={{ padding: '1px 4px', color: '#48bb78' }}
                    title="标记已处理"
                  >
                    <IconCheck />
                  </button>
                ) : (
                  <button
                    onClick={() => onReopen(ann.id)}
                    className="cursor-pointer rounded flex items-center"
                    style={{ padding: '1px 4px', color: '#d69e2e' }}
                    title="重新打开"
                  >
                    <IconUndo />
                  </button>
                )}
                <button
                  onClick={() => { setEditingId(ann.id); setEditText(ann.comment); }}
                  className="cursor-pointer rounded flex items-center"
                  style={{ padding: '1px 4px', color: 'var(--text-muted, #999)' }}
                  title="编辑批注"
                >
                  <IconEdit />
                </button>
                <button
                  onClick={() => onDelete(ann.id)}
                  className="cursor-pointer rounded flex items-center"
                  style={{ padding: '1px 4px', color: 'var(--text-muted, #999)' }}
                  title="删除批注"
                >
                  <IconTrash />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Footer: clear resolved */}
      {allResolved && (
        <div className="shrink-0" style={{ padding: '8px 12px', borderTop: '1px solid var(--border)' }}>
          <button
            onClick={onClearResolved}
            className="w-full text-xs rounded cursor-pointer"
            style={{
              padding: '6px 0',
              backgroundColor: 'rgba(72,187,120,0.1)',
              color: '#48bb78',
              border: '1px solid rgba(72,187,120,0.3)',
            }}
          >
            全部已处理，清空批注
          </button>
        </div>
      )}
    </div>
  );
}
