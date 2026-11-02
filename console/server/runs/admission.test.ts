/**
 * Admission to scan: at most `runConcurrency` runs scan at once, and at most
 * `runConcurrencyPerPerson` of one person's, so someone with several explorations open cannot take
 * every scan; a run that has to wait says so, and behind whose runs.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';

const dataDir = await mkdtemp(join(tmpdir(), 'console-admission-'));
process.env.CONSOLE_DATA_DIR = dataDir;
process.env.CONSOLE_RUN_CONCURRENCY = '4';

const { applySettingOverrides } = await import('../config.ts');
const { noTableCatalog } = await import('../data/catalog.ts');
const { admit, resetRuns } = await import('./store.ts');
const { Run } = await import('./run.ts');

import type { RunPage } from '../../shared/types.ts';

const OPEN = new AbortController().signal;

/** Let every settled promise's callbacks run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(async () => {
  applySettingOverrides({});
  await resetRuns();
});

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('admission to scan', () => {
  it('lets one person scan at most their share at once, without holding up anyone else', async () => {
    applySettingOverrides({ runConcurrencyPerPerson: 2 });
    const first = await admit(OPEN, 'ana');
    const second = await admit(OPEN, 'ana');
    const reasons: string[] = [];
    let admitted = false;
    const third = admit(OPEN, 'ana', (reason) => reasons.push(reason)).then((release) => {
      admitted = true;
      return release;
    });
    await settle();
    assert.deepEqual(reasons, ['own']);
    assert.equal(admitted, false);
    // Waiting behind her own runs, Ana's third holds up nobody else's.
    const bob = await admit(OPEN, 'bob');
    first();
    const release = await third;
    assert.equal(admitted, true);
    for (const done of [second, release, bob]) done();
  });

  it('waits behind everyone once the console’s own limit is reached', async () => {
    applySettingOverrides({ runConcurrencyPerPerson: 2 });
    const held = await Promise.all(['a', 'b', 'c', 'd'].map((person) => admit(OPEN, person)));
    const reasons: string[] = [];
    const waiting = admit(OPEN, 'e', (reason) => reasons.push(reason));
    await settle();
    assert.deepEqual(reasons, ['others']);
    (held[0] as () => void)();
    const release = await waiting;
    for (const done of [...held.slice(1), release]) done();
  });

  it('has no share per person at 0, only the console’s limit', async () => {
    applySettingOverrides({ runConcurrencyPerPerson: 0 });
    const held = await Promise.all([1, 2, 3, 4].map(() => admit(OPEN, 'ana')));
    const reasons: string[] = [];
    const waiting = admit(OPEN, 'ana', (reason) => reasons.push(reason));
    await settle();
    assert.deepEqual(reasons, ['others']);
    (held[0] as () => void)();
    for (const done of [...held.slice(1), await waiting]) done();
  });

  it('forgets a run cancelled while it waits, and lets the next one in', async () => {
    applySettingOverrides({ runConcurrencyPerPerson: 1 });
    const first = await admit(OPEN, 'ana');
    const cancel = new AbortController();
    const cancelled = admit(cancel.signal, 'ana');
    const next = admit(OPEN, 'ana');
    cancel.abort();
    await assert.rejects(cancelled, /cancelled/);
    first();
    (await next)();
  });

  it('takes a lowered share at once, for the next run to ask', async () => {
    applySettingOverrides({ runConcurrencyPerPerson: 3 });
    const held = await Promise.all([1, 2].map(() => admit(OPEN, 'ana')));
    applySettingOverrides({ runConcurrencyPerPerson: 1 });
    const reasons: string[] = [];
    const waiting = admit(OPEN, 'ana', (reason) => reasons.push(reason));
    await settle();
    assert.deepEqual(reasons, ['own']);
    (held[0] as () => void)();
    await settle();
    assert.deepEqual(reasons, ['own'], 'still one of hers scanning: still her turn to wait');
    (held[1] as () => void)();
    (await waiting)();
  });
});

describe('a run that has to wait its turn', () => {
  /** A run whose scan waits for `scan` once admitted. */
  class Probe extends Run {
    scan: Promise<void> = Promise.resolve();
    protected async execute(): Promise<void> {
      const release = await this.admitted();
      try {
        await this.scan;
      } finally {
        release();
      }
    }
    async readPage(offset: number): Promise<RunPage> {
      return { runId: this.id, offset, rows: [], columns: [], complete: true, total: 0, totalExact: true };
    }
    async readRows(): Promise<Record<string, unknown>[]> {
      return [];
    }
    exportableRows(): number {
      return 0;
    }
    async rowsView(): Promise<string[]> {
      return [];
    }
  }

  it('says it is queued, and behind whose runs, then goes back to what it was doing', async () => {
    let open = (): void => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const probe = new Probe({
      domain: 'domain_a',
      materializationId: null,
      ownerId: 'domain_a:usr-test',
      tableName: null,
      datasets: [],
      request: { kind: 'sql', range: { from: null, to: null }, sql: 'SELECT 1' },
      catalog: noTableCatalog(),
      columns: [],
      admit: async (_signal, onQueued) => {
        onQueued?.('own');
        await gate;
        return () => undefined;
      },
    });
    const done = probe.start();
    await settle();
    const queued = probe.snapshot();
    assert.deepEqual([queued.phase, queued.queued, queued.table, queued.materializationId], ['queued', 'own', null, null]);
    open();
    await done;
    const finished = probe.snapshot();
    assert.equal(finished.state, 'succeeded');
    assert.equal(finished.queued, undefined, 'said only while it waits');
  });
});
