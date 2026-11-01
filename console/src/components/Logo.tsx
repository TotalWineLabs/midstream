import { useEffect, useState, type ReactNode } from 'react';

import { cn } from '@/lib/cn';

/** The stream: it rises twice and settles into a line, the waterline where the lake begins. */
const STREAM = 'M11,44 C14,33 16.6,14.5 21,14.5 C25.4,14.5 27,44 31.5,44 C35.6,44 36.6,25 40.6,25 C44.2,25 45.2,44 49.5,44 L56,44';

/** Whether a mark has drawn itself yet: once a page load, not again on every page it reappears on. */
let drawn = false;

/** Heavier at small sizes, so the stroke holds its weight beside text. */
function strokeFor(size: number): number {
  if (size <= 20) return 7;
  if (size <= 32) return 6.4;
  return 5.6;
}

/**
 * Midstream's mark, one solid stroke in one colour (docs/10-design-system.md §Identity).
 *
 * Alone it takes the text colour around it; on its tile it is the app icon, ink on Current. It draws
 * itself once when the console opens, and while `working` the stream flows through it.
 */
export function Mark({
  size = 24,
  tile = false,
  working = false,
  label,
  className,
}: {
  size?: number;
  /** On its aqua tile, as the app icon. */
  tile?: boolean;
  /** Something is on its way: the stream flows through until it arrives. */
  working?: boolean;
  /** For a mark standing in for the name; one beside the name says nothing more. */
  label?: string;
  className?: string;
}): ReactNode {
  const [draw] = useState(() => !drawn);
  useEffect(() => {
    drawn = true;
  }, []);

  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={cn('shrink-0', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {tile ? <rect width="64" height="64" rx="15" fill="#3EF0C5" /> : null}
      <path
        d={STREAM}
        transform="translate(-1.5 3.4)"
        pathLength={100}
        fill="none"
        stroke={tile ? '#07090C' : 'currentColor'}
        strokeWidth={strokeFor(size)}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={working ? 'mark-flow' : draw ? 'mark-draw' : undefined}
      />
    </svg>
  );
}

/** The mark in Current beside the name, set in the display face. */
export function Lockup({ size = 22, className }: { size?: number; className?: string }): ReactNode {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <Mark size={size} className="text-[var(--color-current)]" />
      <span className="font-display text-[17px] leading-none font-semibold tracking-[-0.022em]">Midstream</span>
    </span>
  );
}
