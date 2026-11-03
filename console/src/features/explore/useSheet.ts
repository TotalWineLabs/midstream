import { useEffect, type RefObject } from 'react';

/**
 * A sheet over a phone's page - the Tables rail, History - behaves as the dialog it is: it takes
 * focus when it opens, Esc closes it, and focus goes back where it was. A key a field inside it has
 * already used (Esc clearing a search) is left alone.
 */
export function useSheet(ref: RefObject<HTMLElement | null>, active: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!active) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (before?.isConnected) before.focus();
    };
  }, [ref, active, onClose]);
}
