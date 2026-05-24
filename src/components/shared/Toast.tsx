import { useEffect, useState } from 'react';

interface ToastProps {
  message: string;
  visible: boolean;
  onClose: () => void;
  duration?: number;
}

export function Toast({ message, visible, onClose, duration = 2000 }: ToastProps) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (visible) {
      setShow(true);
      const timer = setTimeout(() => {
        setShow(false);
        setTimeout(onClose, 300);
      }, duration);
      return () => clearTimeout(timer);
    }
  }, [visible, duration, onClose]);

  if (!visible && !show) return null;

  return (
    <div
      className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg text-sm shadow-lg z-50 dialog-enter"
      style={{
        backgroundColor: 'var(--toast-bg)',
        color: 'var(--toast-text)',
        opacity: show ? 1 : 0,
        transform: `translate(-50%, ${show ? 0 : 10}px)`,
      }}
    >
      {message}
    </div>
  );
}
