import { useCallback, useState } from 'react';

/** The theme a person chose: the operating system's, or one of the two. */
export type Appearance = 'system' | 'light' | 'dark';

const KEY = 'console.theme';

declare global {
  interface Window {
    /** Set by index.html: applies the stored choice, or the system's theme, to the document. */
    __applyTheme?: () => void;
  }
}

function stored(): Appearance {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

/**
 * The person's appearance choice and a way to change it. The console follows the system unless they
 * choose (docs/10-design-system.md §10.3); index.html applies it before first paint and follows the
 * system's changes while it is `system`.
 */
export function useAppearance(): [Appearance, (next: Appearance) => void] {
  const [appearance, setAppearance] = useState<Appearance>(stored);
  const choose = useCallback((next: Appearance) => {
    try {
      if (next === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      /* private browsing: the choice lasts as long as the page */
    }
    if (window.__applyTheme) window.__applyTheme();
    else document.documentElement.classList.toggle('dark', next === 'dark' || (next === 'system' && matchMedia('(prefers-color-scheme: dark)').matches));
    setAppearance(next);
  }, []);
  return [appearance, choose];
}
