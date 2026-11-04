import type { LagSample } from './types.ts';

export type LagState = 'caught-up' | 'draining' | 'growing' | 'steady' | 'stale' | 'unknown';

export interface LagTrend {
  state: LagState;
  /** Change in lag, records per second: negative while the runtime gains on the topic. Null without a trend. */
  perSecond: number | null;
  /** Time left to reach zero at the current pace, while draining. */
  etaMs: number | null;
}

/**
 * The most a caught-up runtime holds uncommitted, as time: offsets commit only once their rows are
 * in the table, so a batch can wait for its ceiling (600 s) and then for the next commit (30 s).
 */
export const LAG_FLOOR_MS = 630_000;

/**
 * How far behind the topics a caught-up runtime's workers may have read: each reports what it
 * handled on its heartbeat (every 30 s), and the lag is measured as late again. Records unread
 * beyond what arrives in this span — at the floor's pace, and at least `READ_FLOOR_RECORDS`, which a
 * worker reads in a second — are a backlog, however recently they arrived.
 */
export const READ_FLOOR_MS = 120_000;
export const READ_FLOOR_RECORDS = 1_000;

export interface LagTrendOptions {
  /** The console's clock: with no measurement in the last `windowMs` there is no trend. */
  now?: number;
  /** The span the rate is read over. */
  windowMs?: number;
  /** See `LAG_FLOOR_MS`. */
  floorMs?: number;
  /** See `READ_FLOOR_MS`. */
  readFloorMs?: number;
}

const NO_TREND = { perSecond: null, etaMs: null } as const;

/**
 * Which way consumer lag is heading, and how fast.
 *
 * A lag no larger than what arrived on the source topics in the last `floorMs` is the floor every
 * caught-up runtime sits on, and reads as caught up however it wobbles as batches commit — so long
 * as its workers have read all but what arrived in the last `readFloorMs`: a backlog that arrived
 * in one burst is within the first and not the second, and is worked through, not waited on. Above
 * it, the rate is the least-squares slope through the measurements of the last `windowMs`, so one
 * measurement taken just before or after a commit does not swing it; with fewer than three there,
 * the last few measurements stand in; a backlog that began inside the window is read from the
 * measurements since it began. A change smaller than 0.1% of the lag over the window, a
 * single record, or under half a record a second, is noise, and reads as steady.
 */
export function lagTrend(history: LagSample[], options: LagTrendOptions = {}): LagTrend {
  const { now, windowMs = 10 * 60_000, floorMs = LAG_FLOOR_MS, readFloorMs = READ_FLOOR_MS } = options;
  const latest = history.at(-1);
  if (!latest) return { state: 'unknown', ...NO_TREND };
  if (now !== undefined && now - latest.t > windowMs) return { state: 'stale', ...NO_TREND };
  if (onFloor(latest, arrivedWithin(history, latest, floorMs), floorMs, readFloorMs)) return { state: 'caught-up', ...NO_TREND };

  let points = history.filter((point) => point.t >= latest.t - windowMs);
  // A backlog that began inside the window is read from where it began: the floor before it would
  // read as growth.
  const backlog = sinceFloor(history, points, floorMs, readFloorMs);
  if (backlog.length >= 2) points = backlog;
  else if (points.length < 3) points = history.slice(-5);
  if (points.length < 2) return { state: 'unknown', ...NO_TREND };

  const meanT = points.reduce((sum, point) => sum + point.t, 0) / points.length;
  const meanLag = points.reduce((sum, point) => sum + point.lag, 0) / points.length;
  let covariance = 0;
  let variance = 0;
  for (const point of points) {
    covariance += (point.t - meanT) * (point.lag - meanLag);
    variance += (point.t - meanT) ** 2;
  }
  if (variance === 0) return { state: 'unknown', ...NO_TREND };
  const perSecond = (covariance / variance) * 1000;

  const spanSeconds = ((points.at(-1) as LagSample).t - (points[0] as LagSample).t) / 1000;
  const change = Math.abs(perSecond) * spanSeconds;
  if (Math.abs(perSecond) < 0.5 || change < Math.max(1, latest.lag * 0.001)) return { state: 'steady', perSecond, etaMs: null };
  if (perSecond > 0) return { state: 'growing', perSecond, etaMs: null };
  return { state: 'draining', perSecond, etaMs: (latest.lag / -perSecond) * 1000 };
}

/** The measurements in `points` after the last one on its floor; none when none of them is. */
function sinceFloor(history: LagSample[], points: LagSample[], floorMs: number, readFloorMs: number): LagSample[] {
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const point = points[index] as LagSample;
    if (onFloor(point, arrivedWithin(history, point, floorMs), floorMs, readFloorMs)) return points.slice(index + 1);
  }
  return [];
}

/**
 * Records that arrived on the source topics over the last `spanMs`, from the earliest measurement
 * inside it and scaled to the whole span; null when the history cannot say.
 */
function arrivedWithin(history: LagSample[], latest: LagSample, spanMs: number): number | null {
  const from = history.find((point) => point.arrived !== undefined && point.t >= latest.t - spanMs && point.t < latest.t);
  return from ? arrivedBetween(from, latest, spanMs) : null;
}

/** What arrived from `from` to `point`, scaled to `spanMs`; null when the two cannot say. */
function arrivedBetween(from: LagSample, point: LagSample, spanMs: number): number | null {
  if (point.arrived === undefined || from.arrived === undefined || point.t <= from.t) return null;
  return ((point.arrived - from.arrived) * spanMs) / (point.t - from.t);
}

/**
 * Whether a measured lag is the floor (`LAG_FLOOR_MS`): none at all, or within what arrived over the
 * floor, with everything read but what arrives in `READ_FLOOR_MS` at the same pace, when the
 * workers say what they read.
 */
function onFloor(point: LagSample, arrived: number | null, floorMs: number, readFloorMs: number): boolean {
  if (point.lag === 0) return true;
  if (arrived === null || point.lag > arrived) return false;
  return point.unread === undefined || point.unread <= Math.max(READ_FLOOR_RECORDS, (arrived * readFloorMs) / floorMs);
}

/**
 * How far a falling backlog has come, 0 to 1: from its peak since the lag last sat at its floor to
 * now. Null without a backlog, and null when the history does not reach back to where the backlog
 * began — a console started mid-backlog has seen only part of it, so its peak would overstate the
 * start; `backlogProgress` then measures by rows instead. One pass from the newest measurement
 * back, the floor's window following it, so a long history costs no more than its length.
 */
export function catchUpProgress(history: LagSample[], floorMs = LAG_FLOOR_MS, readFloorMs = READ_FLOOR_MS): number | null {
  const latest = history.at(-1);
  if (!latest || latest.lag <= 0) return null;
  let peak = latest.lag;
  let start = history.length - 1;
  let began = false;
  for (let index = history.length - 2; index >= 0; index -= 1) {
    const point = history[index] as LagSample;
    // The earliest measurement inside this one's floor window: it only moves back as this one does.
    while (start > 0 && (history[start - 1] as LagSample).t >= point.t - floorMs) start -= 1;
    if (start >= index) start = index;
    if (onFloor(point, arrivedBetween(history[start] as LagSample, point, floorMs), floorMs, readFloorMs)) {
      began = true;
      break;
    }
    peak = Math.max(peak, point.lag);
  }
  if (!began) return null;
  return peak > 0 ? Math.min(1, Math.max(0, (peak - latest.lag) / peak)) : null;
}

/**
 * How far a catch-up has come, as best it can be told: from the backlog's peak when the history saw
 * it begin, otherwise the share of what the topics hold that is in the tables — rows committed out of
 * rows committed and records behind. Null when neither can be told.
 */
export function backlogProgress(history: LagSample[], rowsCommitted: number | null, behind: number | null): number | null {
  const fromPeak = catchUpProgress(history);
  if (fromPeak !== null) return fromPeak;
  if (rowsCommitted === null || behind === null || rowsCommitted + behind <= 0) return null;
  return Math.min(1, Math.max(0, rowsCommitted / (rowsCommitted + behind)));
}

/** `3h 10m`, `12m`, `45s`: a duration to read at a glance, to the nearest sensible unit. */
export function formatEta(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
