import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { backlogProgress, catchUpProgress, formatEta, lagTrend } from './lagTrend.ts';

const minute = 60_000;
const series = (lags: number[], every = minute) => lags.map((lag, index) => ({ t: index * every, lag }));

describe('lagTrend', () => {
  it('reads the drain rate and the time left from the measured lags', () => {
    const trend = lagTrend(series([107_357_698, 106_938_384, 106_543_644, 106_130_762]));
    assert.equal(trend.state, 'draining');
    assert.ok(Math.abs((trend.perSecond as number) + 6_820) < 50, `${trend.perSecond}`);
    assert.ok(Math.abs((trend.etaMs as number) / 3_600_000 - 4.32) < 0.05, `${trend.etaMs}`);
  });

  it('says when the topic is outrunning the runtime', () => {
    assert.equal(lagTrend(series([1_000, 5_000, 9_000])).state, 'growing');
  });

  it('calls a lag that barely moves steady, and zero caught up', () => {
    assert.equal(lagTrend(series([1_000_000, 1_000_100, 999_950, 1_000_020])).state, 'steady');
    assert.equal(lagTrend(series([30, 0])).state, 'caught-up');
  });

  it('reads the floor a caught-up runtime sits on as caught up, however it wobbles', () => {
    // A quiet topic on a test cluster: lags of 28 to 49, a few records a minute arriving, held
    // until their batch rolls. Read as a slope, this was "Catching up · −0/s · about 44m to go".
    const wobble = [35, 49, 41, 35];
    assert.equal(lagTrend(series(wobble)).state, 'steady');
    const arriving = wobble.map((lag, index) => ({ t: index * minute, lag, arrived: 1_000 + index * 6 }));
    const trend = lagTrend(arriving);
    assert.equal(trend.state, 'caught-up');
    assert.equal(trend.perSecond, null);
    // Growing as a batch fills is the floor too.
    assert.equal(lagTrend([10, 20, 30, 40].map((lag, index) => ({ t: index * minute, lag, arrived: index * 12 }))).state, 'caught-up');
  });

  it('reads a backlog above the floor as one', () => {
    const lags = [107_357_698, 106_938_384, 106_543_644, 106_130_762];
    const trend = lagTrend(lags.map((lag, index) => ({ t: index * minute, lag, arrived: index * 60_000 })));
    assert.equal(trend.state, 'draining');
    // A topic outrunning its runtime: more behind than arrived in the last ten minutes, and growing.
    const growing = [700_000, 760_000, 820_000, 880_000].map((lag, index) => ({ t: index * minute, lag, arrived: index * 61_000 }));
    assert.equal(lagTrend(growing).state, 'growing');
  });

  it('never calls a rate under half a record a second a trend', () => {
    assert.equal(lagTrend(series([5_000, 5_010, 5_020, 5_030])).state, 'steady');
  });

  it('has no trend once the measurements stop', () => {
    const history = series([35, 49, 41, 35]);
    assert.equal(lagTrend(history, { now: 3 * minute + 30_000 }).state, 'steady');
    assert.equal(lagTrend(history, { now: 3 * minute + 11 * minute }).state, 'stale');
  });

  it('needs two measurements', () => {
    assert.equal(lagTrend(series([5_000])).state, 'unknown');
    assert.equal(lagTrend([]).state, 'unknown');
  });

  it('weighs the last ten minutes', () => {
    // Growing an hour ago, draining now.
    const lags = [...Array.from({ length: 50 }, (_, index) => 1_000 + index * 100), ...Array.from({ length: 10 }, (_, index) => 5_900 - index * 300)];
    assert.equal(lagTrend(series(lags)).state, 'draining');
  });
});

describe('catchUpProgress', () => {
  it('measures from the peak since the lag last sat at its floor', () => {
    // Caught up, then a backlog of 1,000,000 that is now down to 250,000.
    const history = [
      { t: 0, lag: 40, arrived: 0 },
      { t: minute, lag: 45, arrived: 10 },
      { t: 2 * minute, lag: 1_000_000, arrived: 20 },
      { t: 3 * minute, lag: 600_000, arrived: 30 },
      { t: 4 * minute, lag: 250_000, arrived: 40 },
    ];
    assert.equal(catchUpProgress(history), 0.75);
  });

  it('ignores an older backlog it already caught up from', () => {
    const history = [
      { t: 0, lag: 5_000_000, arrived: 0 },
      { t: minute, lag: 30, arrived: 10 },
      { t: 2 * minute, lag: 200_000, arrived: 20 },
      { t: 3 * minute, lag: 100_000, arrived: 30 },
    ];
    assert.equal(catchUpProgress(history), 0.5);
  });

  it('does not guess a peak it never saw', () => {
    // A console started mid-backfill: every measurement is above the floor.
    const history = [
      { t: 0, lag: 62_500_000, arrived: 0 },
      { t: minute, lag: 61_300_000, arrived: 60 },
      { t: 2 * minute, lag: 60_100_000, arrived: 120 },
    ];
    assert.equal(catchUpProgress(history), null);
    // Then the rows say it: 51.6M in the table of the 108.6M the topic holds.
    assert.ok(Math.abs((backlogProgress(history, 51_600_000, 57_000_000) as number) - 0.475) < 0.001);
    assert.equal(backlogProgress(history, null, 57_000_000), null);
  });

  it('has nothing to say without a backlog', () => {
    assert.equal(catchUpProgress([]), null);
    assert.equal(catchUpProgress(series([10, 0])), null);
  });
});

describe('formatEta', () => {
  it('rounds to a readable unit', () => {
    assert.equal(formatEta(45_000), '45s');
    assert.equal(formatEta(12 * minute), '12m');
    assert.equal(formatEta(190 * minute), '3h 10m');
    assert.equal(formatEta(60 * 60 * minute), '2d 12h');
  });
});
