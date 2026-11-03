import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MIN_INSTANCE_BYTES, NODE_RESERVE_BYTES, detectCpus, detectMemoryBytes, duckdbMemoryLimitFor, duckdbThreadsFor } from './resources.ts';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Megabytes in a `memory_limit` the console derived. */
function mib(limit: string): number {
  const match = /^(\d+)MiB$/.exec(limit);
  assert.ok(match, `${limit} is in MiB`);
  return Number(match[1]);
}

describe('DuckDB sized to the container', () => {
  it('fits the console’s instance and every concurrent statement, each with as much again to spare, beside Node', () => {
    // The chart's default pod: 4 GiB, four runs scanning at once.
    const limit = duckdbMemoryLimitFor(4 * GIB, 4);
    assert.equal(limit, '358MiB');
    assert.ok(5 * 2 * mib(limit) * MIB + NODE_RESERVE_BYTES <= 4 * GIB);
  });

  it('gives each statement more when fewer scan at once, or the pod is bigger', () => {
    assert.ok(mib(duckdbMemoryLimitFor(4 * GIB, 1)) > mib(duckdbMemoryLimitFor(4 * GIB, 4)));
    assert.equal(duckdbMemoryLimitFor(16 * GIB, 4), '1587MiB');
  });

  it('never goes below its floor, however small the container', () => {
    assert.equal(mib(duckdbMemoryLimitFor(256 * MIB, 4)) * MIB, MIN_INSTANCE_BYTES);
    assert.equal(mib(duckdbMemoryLimitFor(0, 0)) * MIB, MIN_INSTANCE_BYTES);
  });

  it('runs four threads a CPU, within bounds', () => {
    assert.equal(duckdbThreadsFor(2), 8);
    assert.equal(duckdbThreadsFor(1), 4);
    assert.equal(duckdbThreadsFor(0.5), 4);
    assert.equal(duckdbThreadsFor(8), 32);
    assert.equal(duckdbThreadsFor(64), 64);
  });

  it('reads the process’s own limits when the deployment gives none', () => {
    assert.ok(detectMemoryBytes() > 0);
    assert.ok(detectCpus() >= 1);
  });
});
