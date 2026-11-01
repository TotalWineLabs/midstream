import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TablePartitionRow } from '@shared/types';

import { axisMarks, binLabel, binPartitions, binStart, partitionStart } from './partitions.ts';

function row(key: string | null, overrides: Partial<TablePartitionRow> = {}): TablePartitionRow {
  return { key, files: 2, bytes: 100, records: 10, smallFiles: 1, compactionDue: false, ...overrides };
}

describe('partitionStart', () => {
  it('reads a day, an hour and a month, in UTC, and nothing else', () => {
    assert.deepEqual(partitionStart('2026-03-02'), { at: Date.UTC(2026, 2, 2), granularity: 'day' });
    assert.deepEqual(partitionStart('2026-03-02-14'), { at: Date.UTC(2026, 2, 2, 14), granularity: 'hour' });
    assert.deepEqual(partitionStart('2026-03'), { at: Date.UTC(2026, 2, 1), granularity: 'month' });
    assert.equal(partitionStart('__null__'), null);
    assert.equal(partitionStart(null), null);
  });
});

describe('binStart', () => {
  it('starts a week on Monday', () => {
    // Sunday March 8 2026 is in the week of Monday March 2.
    assert.equal(binStart(Date.UTC(2026, 2, 8, 23), 'week'), Date.UTC(2026, 2, 2));
    assert.equal(binStart(Date.UTC(2026, 2, 2), 'week'), Date.UTC(2026, 2, 2));
    assert.equal(binStart(Date.UTC(2026, 4, 17), 'quarter'), Date.UTC(2026, 3, 1));
  });
});

describe('binPartitions', () => {
  it('keeps one bin per partition when they fit, empty days included, on a true time axis', () => {
    const result = binPartitions([row('2026-03-04'), row('2026-03-01'), row('2026-03-02', { compactionDue: true })], 10);
    assert.equal(result.level, 'day');
    assert.deepEqual(
      result.bins.map((bin) => [bin.start, bin.partitions, bin.due]),
      [
        [Date.UTC(2026, 2, 1), 1, 0],
        [Date.UTC(2026, 2, 2), 1, 1],
        [Date.UTC(2026, 2, 3), 0, 0],
        [Date.UTC(2026, 2, 4), 1, 0],
      ],
    );
  });

  it('bins two years of days by month when weeks would not fit, summing what they hold', () => {
    const days: TablePartitionRow[] = [];
    for (let day = 0; day < 700; day += 1) {
      const at = new Date(Date.UTC(2025, 0, 1) + day * 86_400_000).toISOString().slice(0, 10);
      days.push(row(at, { compactionDue: day % 100 === 0 }));
    }
    const result = binPartitions(days, 60);
    assert.equal(result.level, 'month');
    assert.equal(result.bins.length, 24, "January 2025 to December 2026");
    assert.equal(
      result.bins.reduce((sum, bin) => sum + bin.bytes, 0),
      700 * 100,
    );
    assert.equal(result.bins[0]?.partitions, 31);
    assert.equal(
      result.bins.reduce((sum, bin) => sum + bin.due, 0),
      7,
    );
  });

  it('sets rows without a timestamp, and an unpartitioned table, apart from the axis', () => {
    const result = binPartitions([row('__null__', { files: 3 }), row('2026-03-02')], 10);
    assert.equal(result.untimed?.files, 3);
    assert.equal(result.bins.length, 1);
    const flat = binPartitions([row(null)], 10);
    assert.deepEqual([flat.bins.length, flat.untimed?.partitions], [0, 1]);
  });
});

describe('binLabel and axisMarks', () => {
  it('say a bin as people say it', () => {
    assert.equal(binLabel(Date.UTC(2026, 2, 2), 'week'), 'Week of Mar 2, 2026');
    assert.equal(binLabel(Date.UTC(2026, 2, 1), 'month'), 'March 2026');
    assert.equal(binLabel(Date.UTC(2026, 3, 1), 'quarter'), 'Q2 2026');
    assert.equal(binLabel(Date.UTC(2026, 2, 2, 14), 'hour'), 'Mar 2, 2026, 14:00 UTC');
  });

  it('mark months, January by its year, and thin them to fit', () => {
    const bins = binPartitions(
      Array.from({ length: 23 }, (_, index) => row(new Date(Date.UTC(2025, 2 + index, 1)).toISOString().slice(0, 7))),
      60,
    ).bins;
    const all = axisMarks(bins, 'month', 30);
    assert.equal(all[0]?.label, 'Mar 2025');
    assert.equal(all.find((mark) => mark.label === '2026')?.index, 10);
    const weeks = binPartitions(
      Array.from({ length: 60 }, (_, index) => row(new Date(Date.UTC(2024, 9, 5) + index * 86_400_000).toISOString().slice(0, 10))),
      20,
    );
    assert.equal(weeks.level, 'week');
    assert.equal(weeks.bins[0]?.start, Date.UTC(2024, 8, 30), 'the week of Monday, September 30');
    assert.equal(axisMarks(weeks.bins, weeks.level, 10)[0]?.label, 'Oct 2024', 'never before the data');
    const few = axisMarks(bins, 'month', 6);
    assert.ok(few.length <= 6);
    assert.ok(few.some((mark) => mark.label === '2026'), 'January is always among them');
  });
});
