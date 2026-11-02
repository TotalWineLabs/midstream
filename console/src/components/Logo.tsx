import { useEffect, useId, useState, type ReactNode } from 'react';

import { MARK_DISPLAY, MARK_DISPLAY_LINE, MARK_TEXT, MARK_TEXT_LINE } from './markPaths';
import { cn } from '@/lib/cn';

/** Whether a mark has drawn itself yet: once a page load, not again on every page it reappears on. */
let drawn = false;

/**
 * Midstream's mark: one stream drawn with a pen, heavier on the way down and easing off along the
 * tail, in one colour (docs/10-design-system.md §10.2). The shapes come from `design/mark/mark.py`.
 *
 * Alone it takes the text colour around it; on its tile it is the app icon, ink on Current. At 32 px
 * and under it uses the text cut, heavier and with less contrast, so its thin strokes hold. It draws
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
  const mask = useId();
  const text = size <= 32;
  const motion = working ? 'mark-flow' : draw ? 'mark-draw' : null;

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
      {tile ? <rect width="64" height="64" rx="15" fill="var(--brand-tile)" /> : null}
      {motion ? (
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          {/* The pen's path, wide enough to uncover every width of the stroke as it travels. */}
          <path
            d={text ? MARK_TEXT_LINE : MARK_DISPLAY_LINE}
            pathLength={100}
            fill="none"
            // A mask: white is what shows, not a colour.
            stroke="white"
            strokeWidth={11}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={motion}
          />
        </mask>
      ) : null}
      <path d={text ? MARK_TEXT : MARK_DISPLAY} fill={tile ? 'var(--brand-ink)' : 'currentColor'} mask={motion ? `url(#${mask})` : undefined} />
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
