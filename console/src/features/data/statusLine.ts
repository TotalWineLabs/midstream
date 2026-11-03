import type { RunSnapshot } from '@shared/types';

/** What the status line leads with: the run on screen, or why there is none. */
export type StatusLineState = 'run' | 'starting' | 'refused' | 'idle';

/**
 * What the status line says. A start the server refused is not one under way: with no run on
 * screen it says it could not start, rather than shimmer *Starting…* above the refusal.
 */
export function statusLineState({
  run,
  starting,
  idle,
  refused,
}: {
  run: Pick<RunSnapshot, 'id'> | null;
  starting: boolean;
  /** Nothing asked yet: a question waiting for Run. */
  idle: boolean;
  /** The last start was refused. */
  refused: boolean;
}): StatusLineState {
  if (!run && !starting) {
    if (idle) return 'idle';
    if (refused) return 'refused';
  }
  return starting || !run ? 'starting' : 'run';
}
