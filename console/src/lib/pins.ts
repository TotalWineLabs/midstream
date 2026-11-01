import { useSyncExternalStore } from 'react';

/** Something kept in the sidebar to come back to: a materialization, a dataset or a table, in its domain. */
export interface Pin {
  kind: 'materialization' | 'dataset' | 'table';
  domain: string;
  /** A table's is `<dataset>.<table>`. */
  id: string;
  /** Its name when it was pinned, shown until the fleet says its current one. */
  label: string;
  /** A table's materialization, whose state the sidebar shows beside it. */
  materializationId?: string;
}

const KINDS: ReadonlySet<unknown> = new Set(['materialization', 'dataset', 'table']);

const KEY = 'console.pins';
const listeners = new Set<() => void>();
let cached: Pin[] | null = null;

function read(): Pin[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isPin) : [];
  } catch {
    return [];
  }
}

function isPin(value: unknown): value is Pin {
  if (!value || typeof value !== 'object') return false;
  const pin = value as Record<string, unknown>;
  return (
    KINDS.has(pin.kind) &&
    typeof pin.domain === 'string' &&
    typeof pin.id === 'string' &&
    typeof pin.label === 'string' &&
    (pin.materializationId === undefined || typeof pin.materializationId === 'string')
  );
}

function snapshot(): Pin[] {
  cached ??= read();
  return cached;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Another tab pinning something shows here too.
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== KEY) return;
    cached = null;
    onChange();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onStorage);
  };
}

function write(pins: Pin[]): void {
  cached = pins;
  try {
    localStorage.setItem(KEY, JSON.stringify(pins));
  } catch {
    /* private browsing: pins last as long as the page */
  }
  for (const listener of listeners) listener();
}

/**
 * What this person keeps in their sidebar. Kept in the browser, like a bookmark: it is a way back to
 * something, never access to it.
 */
export function usePins(): Pin[] {
  return useSyncExternalStore(subscribe, snapshot, () => []);
}

export function samePin(pin: Pick<Pin, 'kind' | 'domain' | 'id'>, other: Pick<Pin, 'kind' | 'domain' | 'id'>): boolean {
  return pin.kind === other.kind && pin.domain === other.domain && pin.id === other.id;
}

export function isPinned(pins: Pin[], target: Pick<Pin, 'kind' | 'domain' | 'id'>): boolean {
  return pins.some((pin) => samePin(pin, target));
}

/** Pin it, or unpin it if it is pinned. */
export function togglePin(target: Pin): void {
  const pins = snapshot();
  write(isPinned(pins, target) ? pins.filter((pin) => !samePin(pin, target)) : [...pins, target]);
}
