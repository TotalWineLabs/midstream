/**
 * Where explorations are kept (docs/design/explore.md §5.2).
 *
 * The page reads and writes an `ExplorationStore`. This release's keeps them in the browser, like
 * pins: one key per exploration and a small index, so a save writes one document, not every one.
 * A later release's keeps them with the person's account, behind the same interface, and moves what
 * the browser holds.
 *
 * Which explorations are open, and which is shown, is each browser tab's own (`TabStrip`, in its
 * session storage): two tabs share the documents, not their strips.
 *
 * No React: tested as plain functions over a fake storage.
 */

// With its extension, so `node --test` loads it without the bundler.
import { STORED_LIMIT, migrate, summaryOf, type Exploration, type ExplorationSummary } from './explorations.ts';

/** What a store needs of `localStorage`. */
export interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface ExplorationStore {
  /** Every exploration kept, the most recently changed first. */
  list: () => ExplorationSummary[];
  load: (id: string) => Exploration | null;
  /**
   * Keep a whole document. Past the limit, or with the browser's storage full, the least recently
   * changed explorations not in `keep` - the open ones - go first; `dropped` names them.
   */
  save: (exploration: Exploration, keep?: ReadonlySet<string>) => { dropped: string[] };
  remove: (id: string) => void;
  /** Hear of every change, this tab's or another's. Returns the way to stop. */
  subscribe: (listener: () => void) => () => void;
}

export const STORE_PREFIX = 'console.explore.v1';
const INDEX_KEY = `${STORE_PREFIX}.index`;
const docKey = (id: string): string => `${STORE_PREFIX}.doc.${id}`;

function isSummary(value: unknown): value is ExplorationSummary {
  return Boolean(value) && typeof value === 'object' && typeof (value as ExplorationSummary).id === 'string' && typeof (value as ExplorationSummary).updatedAt === 'string';
}

/**
 * Explorations in the browser's storage. Every read and write is guarded: a browser that blocks
 * storage, or a full one, still gets working explorations for the page's life - kept in memory -
 * just not remembered ones.
 */
export class BrowserExplorationStore implements ExplorationStore {
  private readonly storage: StorageLike | null;
  private readonly limit: number;
  private readonly memory = new Map<string, Exploration>();
  private index: ExplorationSummary[] | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(storage: StorageLike | null, options: { limit?: number } = {}) {
    this.storage = storage;
    this.limit = options.limit ?? STORED_LIMIT;
  }

  list(): ExplorationSummary[] {
    this.index ??= this.readIndex();
    return this.index;
  }

  load(id: string): Exploration | null {
    const held = this.memory.get(id);
    if (held) return held;
    try {
      const raw = this.storage?.getItem(docKey(id));
      const document = raw ? migrate(JSON.parse(raw)) : null;
      if (document) this.memory.set(id, document);
      return document;
    } catch {
      return null;
    }
  }

  save(exploration: Exploration, keep: ReadonlySet<string> = new Set()): { dropped: string[] } {
    this.memory.set(exploration.id, exploration);
    const index = [summaryOf(exploration), ...this.list().filter((entry) => entry.id !== exploration.id)].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
    const dropped: string[] = [];
    // Past the limit, the least recently changed that are not open go.
    while (index.length > this.limit) {
      const victim = lastNotIn(index, keep, exploration.id);
      if (!victim) break;
      index.splice(index.indexOf(victim), 1);
      dropped.push(victim.id);
    }
    this.index = index;
    for (const id of dropped) this.forget(id);
    // A full storage gives up the oldest that are not open, until the document fits or none is left.
    for (;;) {
      try {
        this.storage?.setItem(docKey(exploration.id), JSON.stringify(exploration));
        this.writeIndex();
        break;
      } catch {
        const victim = lastNotIn(this.index, keep, exploration.id);
        if (!victim) break;
        this.index = this.index.filter((entry) => entry.id !== victim.id);
        dropped.push(victim.id);
        this.forget(victim.id);
      }
    }
    this.notify();
    return { dropped };
  }

  remove(id: string): void {
    this.forget(id);
    this.index = this.list().filter((entry) => entry.id !== id);
    try {
      this.writeIndex();
    } catch {
      /* the next save writes it */
    }
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Another tab changed what is kept: read it afresh. */
  changedElsewhere(key: string | null): void {
    if (key !== null && !key.startsWith(STORE_PREFIX)) return;
    this.index = null;
    if (key === null || key === INDEX_KEY) this.memory.clear();
    else if (key.startsWith(`${STORE_PREFIX}.doc.`)) this.memory.delete(key.slice(`${STORE_PREFIX}.doc.`.length));
    this.notify();
  }

  private forget(id: string): void {
    this.memory.delete(id);
    try {
      this.storage?.removeItem(docKey(id));
    } catch {
      /* gone or not, it is no longer listed */
    }
  }

  private readIndex(): ExplorationSummary[] {
    try {
      const parsed: unknown = JSON.parse(this.storage?.getItem(INDEX_KEY) ?? '[]');
      return Array.isArray(parsed) ? parsed.filter(isSummary) : [];
    } catch {
      return [];
    }
  }

  private writeIndex(): void {
    this.storage?.setItem(INDEX_KEY, JSON.stringify(this.index ?? []));
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** The least recently changed exploration that may go: not open, nor the one being saved. */
function lastNotIn(index: ExplorationSummary[], keep: ReadonlySet<string>, saving: string): ExplorationSummary | undefined {
  for (let at = index.length - 1; at >= 0; at -= 1) {
    const entry = index[at] as ExplorationSummary;
    if (entry.id !== saving && !keep.has(entry.id)) return entry;
  }
  return undefined;
}

/* -------------------------------------------------------------------------------- the strip */

/** A browser tab's open explorations, in their order, and the one shown. */
export interface TabStrip {
  open: string[];
  shown: string | null;
}

export const TABS_KEY = 'console.explore.tabs';

export function readTabs(storage: StorageLike | null): TabStrip {
  try {
    const parsed = JSON.parse(storage?.getItem(TABS_KEY) ?? 'null') as Partial<TabStrip> | null;
    const open = Array.isArray(parsed?.open) ? parsed.open.filter((id): id is string => typeof id === 'string') : [];
    const shown = typeof parsed?.shown === 'string' && open.includes(parsed.shown) ? parsed.shown : (open[0] ?? null);
    return { open, shown };
  } catch {
    return { open: [], shown: null };
  }
}

export function writeTabs(storage: StorageLike | null, strip: TabStrip): void {
  try {
    storage?.setItem(TABS_KEY, JSON.stringify(strip));
  } catch {
    /* a strip not remembered across a reload is not worth failing over */
  }
}

/** The strip with `id` open and shown; refused, unchanged, when `limit` are open and it is not one. */
export function openTab(strip: TabStrip, id: string, limit: number): { strip: TabStrip; refused: boolean } {
  if (strip.open.includes(id)) return { strip: { ...strip, shown: id }, refused: false };
  if (strip.open.length >= limit) return { strip, refused: true };
  return { strip: { open: [...strip.open, id], shown: id }, refused: false };
}

/** The strip without `id`; the one shown moves to its neighbour, the next one, else the one before. */
export function closeTab(strip: TabStrip, id: string): TabStrip {
  const at = strip.open.indexOf(id);
  if (at < 0) return strip;
  const open = strip.open.filter((entry) => entry !== id);
  const shown = strip.shown === id ? (open[at] ?? open[at - 1] ?? null) : strip.shown;
  return { open, shown };
}

/** The strip with explorations that are no longer kept left out. */
export function keptTabs(strip: TabStrip, kept: ReadonlySet<string>): TabStrip {
  const open = strip.open.filter((id) => kept.has(id));
  if (open.length === strip.open.length) return strip;
  return { open, shown: strip.shown !== null && open.includes(strip.shown) ? strip.shown : (open[0] ?? null) };
}
