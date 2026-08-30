import { useEffect, useState } from 'react';

interface ToastProps {
  message: string;
  visible: boolean;
  onClose: () => void;
  duration?: number;
  /** busy 模式：不自动消失，带转圈动画（用于导入等耗时操作），需外部置 visible=false 或切回普通模式 */
  busy?: boolean;
}

export function Toast({ message, visible, onClose, duration = 2000, busy = false }: ToastProps) {
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

  return (
    <div
      className="fixed top-6 left-1/2 -translate-x-1/2 px-6 py-3 rounded-lg text-sm shadow-lg z-50 dialog-enter"
      style={{
        backgroundColor: 'rgba(72, 187, 120, 0.15)',
        color: '#2f855a',
        border: '1px solid rgba(72, 187, 120, 0.4)',
        opacity: show ? 1 : 0,
        transform: `translate(-50%, ${show ? 0 : -10}px)`,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      {busy && (
        <span
          className="animate-spin"
          style={{
            width: 12,
            height: 12,
            flexShrink: 0,
            borderRadius: '50%',
            border: '2px solid rgba(47, 133, 90, 0.3)',
            borderTopColor: '#2f855a',
          }}
        />
      )}
      {message}
    </div>
  );
}
