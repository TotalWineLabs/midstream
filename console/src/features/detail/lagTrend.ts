// Type-only, so `node --test` can load this module without the bundler's path aliases.
import type { LagSample } from '@shared/types';

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

export interface LagTrendOptions {
  /** The console's clock: with no measurement in the last `windowMs` there is no trend. */
  now?: number;
  /** The span the rate is read over. */
  windowMs?: number;
  /** See `LAG_FLOOR_MS`. */
  floorMs?: number;
}

const NO_TREND = { perSecond: null, etaMs: null } as const;

/**
 * Which way consumer lag is heading, and how fast.
 *
 * A lag no larger than what arrived on the source topics in the last `floorMs` is the floor every
 * caught-up runtime sits on, and reads as caught up however it wobbles as batches commit. Above
 * it, the rate is the least-squares slope through the measurements of the last `windowMs`, so one
 * measurement taken just before or after a commit does not swing it; with fewer than three there,
 * the last few measurements stand in. A change smaller than 0.1% of the lag over the window, a
 * single record, or under half a record a second, is noise, and reads as steady.
 */
export function lagTrend(history: LagSample[], options: LagTrendOptions = {}): LagTrend {
  const { now, windowMs = 10 * 60_000, floorMs = LAG_FLOOR_MS } = options;
  const latest = history.at(-1);
  if (!latest) return { state: 'unknown', ...NO_TREND };
  if (now !== undefined && now - latest.t > windowMs) return { state: 'stale', ...NO_TREND };
  if (latest.lag === 0) return { state: 'caught-up', ...NO_TREND };
  const arrived = arrivedWithin(history, latest, floorMs);
  if (arrived !== null && latest.lag <= arrived) return { state: 'caught-up', ...NO_TREND };

  let points = history.filter((point) => point.t >= latest.t - windowMs);
  if (points.length < 3) points = history.slice(-5);
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

/**
 * Records that arrived on the source topics over the last `floorMs`, from the earliest measurement
 * inside it and scaled to the whole span; null when the history cannot say.
 */
function arrivedWithin(history: LagSample[], latest: LagSample, floorMs: number): number | null {
  if (latest.arrived === undefined) return null;
  const from = history.find((point) => point.arrived !== undefined && point.t >= latest.t - floorMs && point.t < latest.t);
  if (from?.arrived === undefined) return null;
  return ((latest.arrived - from.arrived) * floorMs) / (latest.t - from.t);
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
