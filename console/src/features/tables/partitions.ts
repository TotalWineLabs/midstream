// Type-only, so `node --test` can load this module without the bundler's path aliases.
import type { TablePartitionRow } from '@shared/types';

/**
 * A table's partitions on a time axis, for the Connect tab's chart (docs/11-feature-reference.md
 * §11.10). Partitions are named by the Kafka timestamp's hour, day or month, in UTC. A table of
 * hundreds of them is drawn in bins — days, weeks, months — as fine as the width allows, empty
 * ones included, so the axis is true time and a gap in the data is a gap in the chart.
 */

export type BinLevel = 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface PartitionBin {
  /** When the bin starts, epoch ms, UTC. */
  start: number;
  partitions: number;
  files: number;
  bytes: number;
  records: number;
  smallFiles: number;
  /** Partitions in it the next compaction pass takes. */
  due: number;
}

export interface PartitionBins {
  level: BinLevel;
  /** The partitions' own granularity: what one of them spans. */
  granularity: 'hour' | 'day' | 'month';
  bins: PartitionBin[];
  /** Rows without a timestamp, and an unpartitioned table's files: no place on the axis. */
  untimed: PartitionBin | null;
}

const LEVELS: BinLevel[] = ['hour', 'day', 'week', 'month', 'quarter', 'year'];

/** A partition's start, from its key: `2026-10-17`, `2026-10-17-10` or `2026-10`. Null when it has no time. */
export function partitionStart(key: string | null): { at: number; granularity: 'hour' | 'day' | 'month' } | null {
  if (key === null) return null;
  const match = /^(\d{4})-(\d{2})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(key);
  if (!match) return null;
  const [, year, month, day, hour] = match;
  const at = Date.UTC(Number(year), Number(month) - 1, day ? Number(day) : 1, hour ? Number(hour) : 0);
  return { at, granularity: hour ? 'hour' : day ? 'day' : 'month' };
}

/** The start of the bin of `level` that holds `at`. Weeks start on Monday. */
export function binStart(at: number, level: BinLevel): number {
  const date = new Date(at);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  switch (level) {
    case 'hour':
      return Date.UTC(year, month, date.getUTCDate(), date.getUTCHours());
    case 'day':
      return Date.UTC(year, month, date.getUTCDate());
    case 'week': {
      const day = Date.UTC(year, month, date.getUTCDate());
      const sinceMonday = (date.getUTCDay() + 6) % 7;
      return day - sinceMonday * 86_400_000;
    }
    case 'month':
      return Date.UTC(year, month, 1);
    case 'quarter':
      return Date.UTC(year, month - (month % 3), 1);
    case 'year':
      return Date.UTC(year, 0, 1);
  }
}

/** The start of the next bin of `level`. */
export function nextBin(start: number, level: BinLevel): number {
  const date = new Date(start);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  switch (level) {
    case 'hour':
      return start + 3_600_000;
    case 'day':
      return start + 86_400_000;
    case 'week':
      return start + 7 * 86_400_000;
    case 'month':
      return Date.UTC(year, month + 1, 1);
    case 'quarter':
      return Date.UTC(year, month + 3, 1);
    case 'year':
      return Date.UTC(year + 1, 0, 1);
  }
}

/** What a table's partitions span: their granularity, the first and the last, and how many have a time. */
export function partitionSpan(rows: readonly TablePartitionRow[]): { granularity: 'hour' | 'day' | 'month'; first: number; last: number; timed: number } | null {
  let granularity: 'hour' | 'day' | 'month' = 'month';
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  let timed = 0;
  for (const row of rows) {
    const start = partitionStart(row.key);
    if (!start) continue;
    timed += 1;
    first = Math.min(first, start.at);
    last = Math.max(last, start.at);
    if (start.granularity === 'hour' || (start.granularity === 'day' && granularity === 'month')) granularity = start.granularity;
  }
  return timed === 0 ? null : { granularity, first, last, timed };
}

function empty(start: number): PartitionBin {
  return { start, partitions: 0, files: 0, bytes: 0, records: 0, smallFiles: 0, due: 0 };
}

function add(bin: PartitionBin, row: TablePartitionRow): void {
  bin.partitions += 1;
  bin.files += row.files;
  bin.bytes += row.bytes;
  bin.records += row.records;
  bin.smallFiles += row.smallFiles;
  if (row.compactionDue) bin.due += 1;
}

/**
 * The partitions in at most `maxBins` bins: the finest level — no finer than the partitions
 * themselves — whose bins, from the first partition's to the last's, number no more than that.
 */
export function binPartitions(rows: readonly TablePartitionRow[], maxBins: number): PartitionBins {
  const timed: Array<{ row: TablePartitionRow; at: number }> = [];
  let untimed: PartitionBin | null = null;
  let granularity: 'hour' | 'day' | 'month' = 'month';
  for (const row of rows) {
    const start = partitionStart(row.key);
    if (!start) {
      untimed ??= empty(0);
      add(untimed, row);
      continue;
    }
    timed.push({ row, at: start.at });
    if (start.granularity === 'hour' || (start.granularity === 'day' && granularity === 'month')) granularity = start.granularity;
  }
  if (timed.length === 0) return { level: granularity, granularity, bins: [], untimed };

  const first = Math.min(...timed.map((entry) => entry.at));
  const last = Math.max(...timed.map((entry) => entry.at));
  const candidates = LEVELS.slice(LEVELS.indexOf(granularity));
  let level = candidates.at(-1) as BinLevel;
  for (const candidate of candidates) {
    let count = 0;
    for (let at = binStart(first, candidate); at <= last && count <= maxBins; at = nextBin(at, candidate)) count += 1;
    if (count <= Math.max(1, maxBins)) {
      level = candidate;
      break;
    }
  }

  const bins: PartitionBin[] = [];
  const index = new Map<number, PartitionBin>();
  for (let at = binStart(first, level); at <= last; at = nextBin(at, level)) {
    const bin = empty(at);
    bins.push(bin);
    index.set(at, bin);
  }
  for (const { row, at } of timed) add(index.get(binStart(at, level)) as PartitionBin, row);
  return { level, granularity, bins, untimed };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A bin as people say it: `Mar 3, 2026`, `Week of Mar 2, 2026`, `March 2026`, `Q1 2026`. Times in UTC, as partitions are. */
export function binLabel(start: number, level: BinLevel): string {
  const date = new Date(start);
  const year = date.getUTCFullYear();
  const month = MONTHS[date.getUTCMonth()] as string;
  const day = date.getUTCDate();
  switch (level) {
    case 'hour':
      return `${month} ${day}, ${year}, ${String(date.getUTCHours()).padStart(2, '0')}:00 UTC`;
    case 'day':
      return `${month} ${day}, ${year}`;
    case 'week':
      return `Week of ${month} ${day}, ${year}`;
    case 'month':
      return `${date.toLocaleString('en', { month: 'long', timeZone: 'UTC' })} ${year}`;
    case 'quarter':
      return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${year}`;
    case 'year':
      return String(year);
  }
}

/**
 * Where the axis names time, with at most `maxMarks` marks: each day when they fit, else each
 * month — or every second, third, fourth or sixth, January always among them — else each year.
 * A month's mark says the month, January's the year, and the first one both when it is not January.
 */
export function axisMarks(bins: readonly PartitionBin[], level: BinLevel, maxMarks: number): Array<{ index: number; label: string }> {
  if (bins.length === 0) return [];
  const dates = bins.map((bin) => new Date(bin.start));
  // A mark where a day, month or year begins. The first bin is one only when it begins exactly
  // there: a week starting on September 30 holds October's first days, and marking it "Sep" would
  // put the axis before the data.
  const firsts = (unit: 'day' | 'month' | 'year'): number[] =>
    dates.flatMap((date, index) => {
      const previous = index > 0 ? (dates[index - 1] as Date) : null;
      if (!previous) {
        const exact = unit === 'day' ? date.getUTCHours() === 0 : date.getUTCDate() === 1 && (unit === 'month' || date.getUTCMonth() === 0);
        return exact || level === 'hour' || level === 'day' ? [index] : [];
      }
      const changed =
        previous.getUTCFullYear() !== date.getUTCFullYear() ||
        (unit !== 'year' && previous.getUTCMonth() !== date.getUTCMonth()) ||
        (unit === 'day' && previous.getUTCDate() !== date.getUTCDate());
      return changed ? [index] : [];
    });
  let first = true;
  const label = (index: number, unit: 'day' | 'month' | 'year'): string => {
    const date = dates[index] as Date;
    // A bin straddling a month's start is named by the month it is mostly in, the later one.
    const shown = index === 0 && unit === 'month' && date.getUTCDate() !== 1 ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)) : date;
    const month = MONTHS[shown.getUTCMonth()] as string;
    const lead = first;
    first = false;
    if (unit === 'year') return String(shown.getUTCFullYear());
    if (unit === 'day') return `${month} ${shown.getUTCDate()}`;
    if (shown.getUTCMonth() === 0) return String(shown.getUTCFullYear());
    // The first mark says its year too, so the axis never starts without one.
    return lead ? `${month} ${shown.getUTCFullYear()}` : month;
  };

  if (level === 'hour' || level === 'day') {
    const days = firsts('day');
    if (days.length <= maxMarks) return days.map((index) => ({ index, label: label(index, 'day') }));
  }
  if (level !== 'quarter' && level !== 'year') {
    const months = firsts('month');
    for (const step of [1, 2, 3, 4, 6]) {
      const kept = months.filter((index) => (dates[index] as Date).getUTCMonth() % step === 0);
      if (kept.length <= maxMarks && kept.length > 0) return kept.map((index) => ({ index, label: label(index, 'month') }));
    }
  }
  const years = firsts('year');
  const step = Math.max(1, Math.ceil(years.length / Math.max(1, maxMarks)));
  return years.filter((_, position) => position % step === 0).map((index) => ({ index, label: label(index, 'year') }));
}
