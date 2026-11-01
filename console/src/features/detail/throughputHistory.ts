/**
 * A materialization's throughput over a chosen window: the stream's recent points, every few
 * seconds, after the console's minute-by-minute history older than them. Plain logic, no React.
 */

import type { ThroughputSample } from '@shared/types';

const MINUTE = 60_000;

/** The spans a throughput chart offers; the first is covered by the stream alone. */
export const THROUGHPUT_WINDOWS = { '15m': 15 * MINUTE, '1h': 60 * MINUTE, '6h': 6 * 60 * MINUTE, '24h': 24 * 60 * MINUTE } as const;
export type ThroughputWindow = keyof typeof THROUGHPUT_WINDOWS;

/** Whether a window reaches past what the stream keeps, and so needs the history. */
export function needsHistory(window: ThroughputWindow): boolean {
  return THROUGHPUT_WINDOWS[window] > THROUGHPUT_WINDOWS['15m'];
}

/** The history's points older than the recent ones, then the recent ones: one series, oldest first. */
export function withHistory(recent: ThroughputSample[], history: ThroughputSample[]): ThroughputSample[] {
  const start = recent[0]?.t;
  if (start === undefined) return history;
  return [...history.filter((point) => point.t < start), ...recent];
}
