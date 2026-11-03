/**
 * A run the console no longer has.
 *
 * Runs live in the console's memory, so a restart - a new version, or the pod killed for running out
 * of memory - takes every run with it. Followed from then on, a run would answer 404 to every poll
 * and to Stop, and stay on screen as running forever, its clock frozen. Instead it ends, as failed,
 * saying why. Kept free of React so it can be tested as plain functions (`useRun.ts` wires them).
 */

import type { RunSnapshot } from '@shared/types';

export const RUN_LOST_CODE = 'run_lost';
export const RUN_LOST_MESSAGE = 'The console lost this run, most likely because it restarted. Run it again.';

/** Whether an answer about a run says the console no longer has it. A server still restarting answers otherwise, and is asked again. */
export function runGone(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 404;
}

/** The run on screen, ended because the console lost it. */
export function lostRun(run: RunSnapshot, now: number = Date.now()): RunSnapshot {
  const { queued: _, ...settled } = run;
  return {
    ...settled,
    state: 'failed',
    phase: 'done',
    finishedAt: new Date(now).toISOString(),
    error: { code: RUN_LOST_CODE, message: RUN_LOST_MESSAGE },
  };
}
