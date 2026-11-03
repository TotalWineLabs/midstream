import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { newExploration } from './explorations.ts';
import { BrowserExplorationStore, STORE_PREFIX, closeTab, keptTabs, openTab, readTabs, writeTabs, type StorageLike } from './store.ts';

/** A storage like the browser's, which can be made full. */
class FakeStorage implements StorageLike {
  readonly items = new Map<string, string>();
  /** Bytes it holds at most; past them a write throws, as a full browser storage does. */
  quota = Number.POSITIVE_INFINITY;
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    const used = [...this.items].reduce((sum, [name, text]) => sum + (name === key ? 0 : name.length + text.length), 0);
    if (used + key.length + value.length > this.quota) throw new DOMException('full', 'QuotaExceededError');
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

const at = (minute: number): number => Date.parse('2026-11-02T12:00:00Z') + minute * 60_000;

describe('the browser’s explorations', () => {
  it('keeps each exploration under its own key, and lists them the most recently changed first', () => {
    const storage = new FakeStorage();
    const store = new BrowserExplorationStore(storage);
    store.save(newExploration('a', {}, at(1)));
    store.save(newExploration('b', { source: { domain: 'domain_a', dataset: 'sales', table: 'orders' } }, at(2)));
    assert.deepEqual(store.list().map((entry) => [entry.id, entry.label]), [['b', 'sales.orders'], ['a', 'New exploration']]);
    assert.ok(storage.items.has(`${STORE_PREFIX}.doc.a`) && storage.items.has(`${STORE_PREFIX}.doc.b`));
    // Another tab's store reads them from the browser.
    const other = new BrowserExplorationStore(storage);
    assert.equal(other.load('b')?.source?.table, 'orders');
    assert.deepEqual(other.list().map((entry) => entry.id), ['b', 'a']);
  });

  it('lets the least recently changed go past its limit, never an open one', () => {
    const store = new BrowserExplorationStore(new FakeStorage(), { limit: 2 });
    store.save(newExploration('old', {}, at(1)));
    store.save(newExploration('open', {}, at(2)));
    const { dropped } = store.save(newExploration('new', {}, at(3)), new Set(['old']));
    assert.deepEqual(dropped, ['open']);
    assert.deepEqual(store.list().map((entry) => entry.id), ['new', 'old']);
    assert.equal(store.load('open'), null);
  });

  it('makes room in a full storage, and keeps working in memory when it cannot', () => {
    const storage = new FakeStorage();
    const store = new BrowserExplorationStore(storage);
    store.save(newExploration('a', {}, at(1)));
    store.save(newExploration('b', {}, at(2)));
    storage.quota = [...storage.items].reduce((sum, [key, value]) => sum + key.length + value.length, 0) + 200;
    const big = { ...newExploration('c', {}, at(3)), title: 'x'.repeat(400) };
    const { dropped } = store.save(big, new Set(['b']));
    assert.deepEqual(dropped, ['a'], 'the oldest that is not open made room');
    storage.quota = 0;
    store.save({ ...big, title: 'Still here' }, new Set(['b', 'c']));
    assert.equal(store.load('c')?.title, 'Still here', 'kept in memory for the page’s life');
  });

  it('works without a storage at all', () => {
    const store = new BrowserExplorationStore(null);
    store.save(newExploration('a', {}, at(1)));
    assert.equal(store.load('a')?.id, 'a');
    store.remove('a');
    assert.equal(store.load('a'), null);
    assert.deepEqual(store.list(), []);
  });

  it('tells its listeners of every change, and of another tab’s', () => {
    const storage = new FakeStorage();
    const store = new BrowserExplorationStore(storage);
    let heard = 0;
    const stop = store.subscribe(() => {
      heard += 1;
    });
    store.save(newExploration('a', {}, at(1)));
    store.remove('a');
    // Another tab saved one: the browser says which key changed.
    new BrowserExplorationStore(storage).save(newExploration('z', {}, at(2)));
    store.changedElsewhere(`${STORE_PREFIX}.index`);
    store.changedElsewhere('console.theme');
    assert.equal(heard, 3, 'not for a key that is not its own');
    assert.deepEqual(store.list().map((entry) => entry.id), ['z']);
    stop();
    store.save(newExploration('b', {}, at(3)));
    assert.equal(heard, 3);
  });

  it('ignores what it cannot read', () => {
    const storage = new FakeStorage();
    storage.items.set(`${STORE_PREFIX}.index`, '{not json');
    storage.items.set(`${STORE_PREFIX}.doc.x`, JSON.stringify({ id: 'x', version: 99 }));
    const store = new BrowserExplorationStore(storage);
    assert.deepEqual(store.list(), []);
    assert.equal(store.load('x'), null);
  });
});

describe('a tab’s strip of explorations', () => {
  it('opens one, shown, up to a limit', () => {
    let strip = { open: [] as string[], shown: null as string | null };
    for (const id of ['a', 'b']) strip = openTab(strip, id, 2).strip;
    assert.deepEqual(strip, { open: ['a', 'b'], shown: 'b' });
    assert.deepEqual(openTab(strip, 'c', 2), { strip, refused: true });
    assert.deepEqual(openTab(strip, 'a', 2), { strip: { open: ['a', 'b'], shown: 'a' }, refused: false }, 'an open one is shown');
  });

  it('closes one, showing its neighbour', () => {
    const strip = { open: ['a', 'b', 'c'], shown: 'b' };
    assert.deepEqual(closeTab(strip, 'b'), { open: ['a', 'c'], shown: 'c' });
    assert.deepEqual(closeTab({ open: ['a', 'b'], shown: 'b' }, 'b'), { open: ['a'], shown: 'a' });
    assert.deepEqual(closeTab({ open: ['a'], shown: 'a' }, 'a'), { open: [], shown: null });
    assert.deepEqual(closeTab(strip, 'a'), { open: ['b', 'c'], shown: 'b' });
  });

  it('forgets explorations no longer kept, and is the tab’s own across a reload', () => {
    assert.deepEqual(keptTabs({ open: ['a', 'b'], shown: 'b' }, new Set(['a'])), { open: ['a'], shown: 'a' });
    const storage = new FakeStorage();
    writeTabs(storage, { open: ['a', 'b'], shown: 'b' });
    assert.deepEqual(readTabs(storage), { open: ['a', 'b'], shown: 'b' });
    assert.deepEqual(readTabs(null), { open: [], shown: null });
    storage.items.set('console.explore.tabs', '{"open":["a"],"shown":"z"}');
    assert.deepEqual(readTabs(storage), { open: ['a'], shown: 'a' });
  });
});
