/**
 * Whether a changed view of a table runs by itself (docs/11-feature-reference.md §11.8): a small
 * question is answered as it is asked; a big one says how much it would read and waits for Run.
 * Plain logic, no React.
 */

import type { ScopeEstimate } from '@shared/types';

import { formatBytes, formatCount } from '../../lib/format.ts';

/** A changed view runs by itself when what it would scan is known and within the limit; 0 is never. */
export function runsByItself(scope: ScopeEstimate | null, maxBytes: number): boolean {
  return scope !== null && maxBytes > 0 && scope.bytes <= maxBytes;
}

/** Why a changed view waits for Run, when its size is the reason; null otherwise. */
export function waitsForRun(scope: ScopeEstimate | null, maxBytes: number): string | null {
  if (scope === null || maxBytes <= 0 || runsByItself(scope, maxBytes)) return null;
  const rows = `${scope.rowsExact ? '' : 'about '}${formatCount(scope.rows)} ${scope.rows === 1 ? 'row' : 'rows'}`;
  return `Not run yet: this range holds ${rows} in ${formatBytes(scope.bytes)}, so it waits for Run`;
}
