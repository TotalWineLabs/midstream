import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RUN_LOST_CODE, lostRun, runGone } from './lostRun.ts';
import { keptMessage, outcomeOf } from '../explore/explorations.ts';
import type { RunSnapshot } from '@shared/types';

const NOW = Date.parse('2026-11-03T03:53:00.000Z');

function running(): RunSnapshot {
  return {
    id: 'run-1',
    domain: 'domain_a',
    materializationId: 'mat-1',
    request: { kind: 'sql', range: { from: null, to: null }, sql: 'SELECT 1' },
    state: 'running',
    phase: 'queued',
    queued: 'others',
    startedAt: '2026-11-03T03:52:00.000Z',
    finishedAt: null,
    elapsedMs: 42_100,
    table: 'orders',
    tables: [],
    asOf: '2026-11-03T03:52:00.000Z',
    snapshotId: '7',
    snapshotAt: null,
    pinned: false,
    validThrough: null,
    scope: { objects: 1, bytes: 1, rows: 1 },
    progress: { rowsTotal: 1, rowsDone: 0, objectsTotal: 1, objectsDone: 0, objectsRead: 0, bytesTotal: 1, fraction: 0 },
    rows: 0,
    totalExact: false,
    rowsReady: 0,
    columns: [],
    truncated: false,
    rowsRetained: null,
    error: null,
    expiresAt: null,
    revision: 0,
  };
}

describe('a run the console lost', () => {
  it('is one the console answers 404 for, not one it cannot answer for yet', () => {
    assert.equal(runGone({ status: 404, code: 'not_found' }), true);
    assert.equal(runGone({ status: 502 }), false);
    assert.equal(runGone({ status: 0 }), false);
    assert.equal(runGone(new TypeError('Failed to fetch')), false);
    assert.equal(runGone(null), false);
  });

  it('ends as failed, saying why and what to do, and waits behind nothing', () => {
    const lost = lostRun(running(), NOW);
    assert.equal(lost.state, 'failed');
    assert.equal(lost.phase, 'done');
    assert.equal(lost.finishedAt, '2026-11-03T03:53:00.000Z');
    assert.equal(lost.error?.code, RUN_LOST_CODE);
    assert.match(lost.error?.message ?? '', /restarted\. Run it again\./);
    assert.equal('queued' in lost, false);
    assert.equal(lost.elapsedMs, 42_100);
  });

  it('is kept in an exploration’s history with its words whole', () => {
    const lost = lostRun(running(), NOW);
    assert.equal(keptMessage(lost.error), lost.error?.message);
    assert.equal(outcomeOf(lost)?.state, 'failed');
  });
});
