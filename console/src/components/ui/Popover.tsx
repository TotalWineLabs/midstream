import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** The least room a popover keeps from the edges of the window. */
const EDGE = 16;

import { cn } from '@/lib/cn';

/**
 * Lightweight anchored popover.
 *
 * Rendered inline rather than through a portal: every use site sits inside the explorer toolbar,
 * so inline keeps the panel inside the same stacking and scroll context as its trigger and avoids
 * having to track the anchor's position on scroll.
 */
export function Popover({
  trigger,
  children,
  align = 'start',
  side = 'bottom',
  width = 320,
  defaultOpen = false,
  className,
}: {
  trigger: (props: { open: boolean; toggle: () => void; id: string }) => ReactNode;
  children: (props: { close: () => void }) => ReactNode;
  align?: 'start' | 'end';
  /** Which side of the trigger the panel opens on; `top` for triggers near the bottom of the page. */
  side?: 'bottom' | 'top';
  width?: number;
  /** Open when it first renders: a link that points at it, say. */
  defaultOpen?: boolean;
  className?: string;
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen);
  const panelRef = useRef<HTMLDivElement>(null);
  // How far the panel moves sideways to stay inside the window: anchored to its trigger, a wide
  // panel would otherwise run off a phone's screen.
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const panel = panelRef.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      const left = rect.left - shift;
      const right = rect.right - shift;
      const next = left < EDGE ? EDGE - left : right > window.innerWidth - EDGE ? window.innerWidth - EDGE - right : 0;
      if (Math.abs(next - shift) > 0.5) setShift(next);
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, shift]);
  const containerRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      {trigger({ open, toggle: () => setOpen((value) => !value), id })}
      {open ? (
        <div
          ref={panelRef}
          id={id}
          role="dialog"
          // `translate`, not `transform`: the fade-in animates `transform`, which would hide the shift
          // while it plays and send the measurement round in a loop.
          style={{ width, translate: shift ? `${shift}px 0` : undefined }}
          className={cn(
            'fade-in absolute z-40 max-w-[calc(100vw-2rem)]',
            side === 'top' ? 'bottom-[calc(100%+6px)]' : 'top-[calc(100%+6px)]',
            'rounded-[var(--radius-panel)] border border-[var(--color-line-strong)]',
            'bg-[var(--color-pop)] shadow-xl shadow-black/10 dark:shadow-black/50',
            align === 'end' ? 'right-0' : 'left-0',
            className,
          )}
        >
          {children({ close: () => setOpen(false) })}
        </div>
      ) : null}
    </div>
  );
}
