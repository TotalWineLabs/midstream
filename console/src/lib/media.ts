import { useSyncExternalStore } from 'react';

/**
 * Whether the window is at least `px` wide, following it as it changes: for a layout that is not
 * just narrower on a phone but different, such as a properties column becoming a sheet.
 */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => true,
  );
}
