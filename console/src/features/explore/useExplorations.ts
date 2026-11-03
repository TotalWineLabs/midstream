import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { BrowserExplorationStore, readTabs, writeTabs, type StorageLike, type TabStrip } from './store';
import type { ExplorationSummary } from './explorations';

/** A storage of the browser's, or null where it is blocked: private browsing, a locked-down profile. */
function storageOf(kind: 'localStorage' | 'sessionStorage'): StorageLike | null {
  try {
    const storage = window[kind];
    storage.getItem('console.explore.probe');
    return storage;
  } catch {
    return null;
  }
}

let store: BrowserExplorationStore | null = null;

/** The browser's explorations, made once for the page and kept in step with its other tabs. */
export function explorationStore(): BrowserExplorationStore {
  if (store) return store;
  const made = new BrowserExplorationStore(storageOf('localStorage'));
  window.addEventListener('storage', (event) => made.changedElsewhere(event.key));
  store = made;
  return made;
}

/** Every exploration kept, the most recently changed first, as it changes. */
export function useExplorationList(): ExplorationSummary[] {
  const kept = explorationStore();
  return useSyncExternalStore(
    useCallback((listener: () => void) => kept.subscribe(listener), [kept]),
    () => kept.list(),
  );
}

/**
 * This browser tab's strip of explorations: which are open, in their order, and which is shown. Its
 * own, in its session storage, so a reload restores it and another tab keeps its own.
 */
export function useTabStrip(): [TabStrip, (update: (strip: TabStrip) => TabStrip) => void] {
  const session = useRef(storageOf('sessionStorage')).current;
  const [strip, setStrip] = useState<TabStrip>(() => readTabs(session));
  useEffect(() => writeTabs(session, strip), [session, strip]);
  const update = useCallback((change: (strip: TabStrip) => TabStrip) => setStrip((current) => change(current)), []);
  return [strip, update];
}

/** A yes or no kept for this browser, read once: whether a rail or a column is open. */
export function useStoredFlag(key: string, fallback: boolean): [boolean, (next: boolean | ((current: boolean) => boolean)) => void] {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? fallback : stored === '1';
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, value ? '1' : '0');
    } catch {
      /* not remembering it is not worth failing a render over */
    }
  }, [key, value]);
  return [value, setValue];
}

/** A number kept for this browser, within bounds: a rail's width. */
export function useStoredNumber(key: string, min: number, max: number, fallback: number): [number, (next: number | ((current: number) => number)) => void] {
  const [value, setValue] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(key));
      return Number.isFinite(stored) && stored > 0 ? Math.min(max, Math.max(min, stored)) : fallback;
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, String(Math.round(value)));
    } catch {
      /* not remembering it is not worth failing a render over */
    }
  }, [key, value]);
  return [value, setValue];
}
