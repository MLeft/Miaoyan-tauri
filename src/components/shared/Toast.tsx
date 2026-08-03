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
      className="fixed top-6 left-1/2 -translate-x-1/2 px-6 py-3 rounded-lg text-sm shadow-lg z-50 dialog-enter"
      style={{
        backgroundColor: 'rgba(72, 187, 120, 0.15)',
        color: '#2f855a',
        border: '1px solid rgba(72, 187, 120, 0.4)',
        opacity: show ? 1 : 0,
        transform: `translate(-50%, ${show ? 0 : -10}px)`,
      }}
    >
      {message}
    </div>
  );
}
