import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CELLS, restFor, rollTo, trendOf } from './ticker.ts';

describe('rollTo', () => {
  it('rolls forward as a number grows, 9 on to 0 as an odometer does', () => {
    assert.deepEqual(rollTo(restFor(2), 3, 1), { position: 13, rolls: true });
    assert.deepEqual(rollTo(restFor(9), 0, 1), { position: 20, rolls: true });
  });

  it('rolls backward as it shrinks, 0 back to 9', () => {
    assert.deepEqual(rollTo(restFor(3), 2, -1), { position: 12, rolls: true });
    assert.deepEqual(rollTo(restFor(0), 9, -1), { position: 9, rolls: true });
  });

  it('stays put for a digit that did not change', () => {
    assert.deepEqual(rollTo(restFor(4), 4, 1), { position: 14, rolls: false });
  });

  it('lands at rest rather than run off the strip', () => {
    // Two quick rises before the first roll settled: 28 is 8, and 8 → 7 forward needs nine more.
    assert.deepEqual(rollTo(28, 7, 1), { position: restFor(7), rolls: false });
    assert.ok(rollTo(1, 0, -1).position >= 0);
    assert.ok(rollTo(CELLS - 1, 5, 1).position < CELLS);
  });
});

describe('trendOf', () => {
  it('reads the direction, and none without two numbers', () => {
    assert.equal(trendOf(10, 12), 1);
    assert.equal(trendOf(12, 10), -1);
    assert.equal(trendOf(10, 10), 0);
    assert.equal(trendOf(null, 10), 0);
    assert.equal(trendOf(10, Number.NaN), 0);
  });
});
