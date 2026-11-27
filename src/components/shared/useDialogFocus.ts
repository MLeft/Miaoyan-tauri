import { useCallback, useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent, RefObject } from 'react';

export function useDialogFocus(root: RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  const focusable = useCallback(() => Array.from(root.current?.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
  ) ?? []).filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0), [root]);

  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (focusable()[0] ?? root.current)?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [root, focusable]);

  useLayoutEffect(() => {
    if (root.current && !root.current.contains(document.activeElement)) {
      (focusable()[0] ?? root.current).focus();
    }
  });

  return useCallback((event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close.current();
      return;
    }
    if (event.key !== 'Tab') return;
    const elements = focusable();
    if (elements.length === 0) {
      event.preventDefault();
      root.current?.focus();
      return;
    }
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, [root, focusable]);
}
