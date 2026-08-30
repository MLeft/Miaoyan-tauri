import { useEffect, useState } from 'react';

export type ToastType = 'success' | 'warning';

interface ToastProps {
  message: string;
  visible: boolean;
  onClose: () => void;
  duration?: number;
  /** busy 模式：不自动消失，带转圈动画（用于导入等耗时操作），需外部置 visible=false 或切回普通模式 */
  busy?: boolean;
  type?: ToastType;
}

export function Toast({ message, visible, onClose, duration = 2000, busy = false, type = 'success' }: ToastProps) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (visible) {
      setShow(true);
      if (busy) return;
      const timer = setTimeout(() => {
        setShow(false);
        setTimeout(onClose, 300);
      }, duration);
      return () => clearTimeout(timer);
    }
  }, [visible, busy, duration, onClose]);

  if (!visible && !show) return null;

  const iconBg = busy ? 'var(--accent-light)' : type === 'warning' ? 'var(--warning-bg)' : 'var(--success-bg)';

  return (
    <div
      style={{
        position: 'fixed',
        top: 18,
        left: '50%',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 16px 10px 10px',
        maxWidth: '80vw',
        backgroundColor: 'var(--toast-surface)',
        color: 'var(--text-primary)',
        border: '0.5px solid var(--border)',
        borderRadius: 12,
        boxShadow: 'var(--shadow-lg)',
        backdropFilter: 'blur(20px) saturate(1.6)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
        fontSize: 13,
        lineHeight: 1.3,
        pointerEvents: 'none',
        opacity: show ? 1 : 0,
        transform: `translate(-50%, ${show ? 0 : -10}px) scale(${show ? 1 : 0.97})`,
        transition: 'opacity 0.22s ease, transform 0.28s cubic-bezier(0.34, 1.4, 0.64, 1)',
      }}
    >
      <span
        style={{
          width: 26,
          height: 26,
          borderRadius: 8,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: iconBg,
        }}
      >
        {busy ? (
          <span
            className="animate-spin"
            style={{
              width: 13,
              height: 13,
              borderRadius: '50%',
              border: '2px solid var(--border)',
              borderTopColor: 'var(--accent)',
            }}
          />
        ) : type === 'warning' ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--warning-color)" strokeWidth="2.4" strokeLinecap="round">
            <path d="M12 5v8" />
            <path d="M12 17.5h.01" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--success-color)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        )}
      </span>
      {message}
    </div>
  );
}
