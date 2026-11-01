import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ThroughputSample } from '@shared/types';

import { needsHistory, withHistory } from './throughputHistory.ts';

const point = (t: number): ThroughputSample => ({ t, rows: 0, bytes: 0, files: 0, skipped: 0, rowsPerSecond: t, bytesPerSecond: null, lag: null });

describe('a throughput chart’s window', () => {
  it('reads the history only past the stream’s quarter hour', () => {
    assert.equal(needsHistory('15m'), false);
    assert.equal(needsHistory('1h'), true);
    assert.equal(needsHistory('24h'), true);
  });

  it('puts the history older than the recent points before them, once each', () => {
    const history = [0, 60_000, 120_000, 180_000].map(point);
    const recent = [150_000, 155_000, 160_000].map(point);
    assert.deepEqual(
      withHistory(recent, history).map((sample) => sample.t),
      [0, 60_000, 120_000, 150_000, 155_000, 160_000],
    );
  });

  it('is the history alone before the stream has a point, and the stream alone without history', () => {
    const history = [0, 60_000].map(point);
    assert.deepEqual(withHistory([], history), history);
    assert.deepEqual(withHistory(history, []), history);
  });
});
