/** Answers that end what a page shows: the person may no longer read it, or it is gone. */
const FINAL_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);

/**
 * Whether a page shows that reading what it is about failed, rather than the answer it has.
 *
 * A page that reads the same thing every few seconds keeps its last answer when one read fails — a
 * refresh never replaces what is on screen with an error (docs/10-design-system.md §10.7) — and the
 * next read tries again. A failure shows when there is no answer to keep, or when it is final: the
 * person may no longer read the thing, or it no longer exists.
 */
export function readFailed(read: { isError: boolean; data: unknown; error: unknown }): boolean {
  if (!read.isError) return false;
  return read.data === undefined || FINAL_STATUSES.has(statusOf(read.error) ?? 0);
}

function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('status' in error)) return null;
  return typeof error.status === 'number' ? error.status : null;
}
