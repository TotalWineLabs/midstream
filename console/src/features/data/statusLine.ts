import type { RunSnapshot } from '@shared/types';

/** What the status line leads with: the run on screen, or why there is none. */
export type StatusLineState = 'run' | 'starting' | 'refused' | 'idle' | 'blank';

/**
 * What the status line says. A start the server refused is not one under way: with no run on
 * screen it says it could not start, rather than shimmer *Starting…* above the refusal. A statement
 * not written yet has nothing to run, and the line says nothing of Run.
 */
export function statusLineState({
  run,
  starting,
  idle,
  refused,
  blank = false,
}: {
  run: Pick<RunSnapshot, 'id'> | null;
  starting: boolean;
  /** Nothing asked yet: a question waiting for Run. */
  idle: boolean;
  /** The last start was refused. */
  refused: boolean;
  /** A statement with nothing written in it yet. */
  blank?: boolean;
}): StatusLineState {
  if (!run && !starting) {
    if (blank) return 'blank';
    if (idle) return 'idle';
    if (refused) return 'refused';
  }
  return starting || !run ? 'starting' : 'run';
}
