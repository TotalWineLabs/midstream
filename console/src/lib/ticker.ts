/** Cells on a ticker digit's strip: 0–9 three times over. */
export const CELLS = 30;

/** Where a strip rests to show a digit: in its middle run, with room to roll either way. */
export function restFor(digit: number): number {
  return 10 + digit;
}

/**
 * The strip position that shows `digit`, rolled to from `position` the way the number moved:
 * forward through the digits as it grows (9 rolls on to 0, as an odometer's does), backward as it
 * shrinks. A roll that would run off the strip lands at rest instead, without rolling.
 */
export function rollTo(position: number, digit: number, trend: number): { position: number; rolls: boolean } {
  const shown = ((position % 10) + 10) % 10;
  const steps = trend >= 0 ? (digit - shown + 10) % 10 : -((shown - digit + 10) % 10);
  const next = position + steps;
  if (next < 0 || next >= CELLS) return { position: restFor(digit), rolls: false };
  return { position: next, rolls: steps !== 0 };
}

/** Which way a number moved: 1 up, -1 down, 0 when either side is not a number or nothing changed. */
export function trendOf(previous: number | null | undefined, next: number | null | undefined): number {
  if (typeof previous !== 'number' || typeof next !== 'number' || !Number.isFinite(previous) || !Number.isFinite(next)) return 0;
  return Math.sign(next - previous);
}
