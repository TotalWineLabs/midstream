import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ScopeEstimate } from '@shared/types';

import { runsByItself, waitsForRun } from './autoRun.ts';

const MIB = 1024 * 1024;

function scope(bytes: number, rows = 1_000, rowsExact = true): ScopeEstimate {
  return { range: { from: null, to: null }, objects: 4, bytes, rows, rowsExact };
}

describe('a changed view', () => {
  it('runs by itself when what it scans is known and within the limit', () => {
    assert.equal(runsByItself(scope(10 * MIB), 256 * MIB), true);
    assert.equal(runsByItself(scope(256 * MIB), 256 * MIB), true);
    assert.equal(runsByItself(scope(257 * MIB), 256 * MIB), false);
  });

  it('waits for Run while its size is unknown, and always when the limit is 0', () => {
    assert.equal(runsByItself(null, 256 * MIB), false);
    assert.equal(runsByItself(scope(0), 0), false);
    assert.equal(waitsForRun(null, 256 * MIB), null);
    assert.equal(waitsForRun(scope(10 * MIB), 0), null);
  });

  it('says how much a big one would read', () => {
    assert.equal(waitsForRun(scope(10 * MIB), 256 * MIB), null);
    assert.equal(
      waitsForRun(scope(3_200_000_000, 12_000_000, false), 256 * MIB),
      `Not run yet: this range holds about ${new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(12_000_000)} rows in 3.2 GB, so it waits for Run`,
    );
    assert.match(waitsForRun(scope(300 * MIB, 1, true), 256 * MIB) ?? '', /holds 1 row in /);
  });
});
