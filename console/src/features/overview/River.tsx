import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { RiverEngine, type RiverPalette, type RiverStrand } from './riverEngine';
import { formatReadoutRate } from '@/components/Readout';
import { cn } from '@/lib/cn';
import { usePrefersReducedMotion } from '@/lib/motion';
import type { Status } from '@/lib/status';
import { useElementSize } from '@/lib/useElementSize';

export interface Strand {
  key: string;
  label: string;
  status: Status;
  /** Rows a second, or null before its workers have reported twice. */
  rate: number | null;
  /** Where the strand opens. */
  to: string;
}

/** A token's colour, as the theme now has it. */
function token(name: string): [number, number, number] {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1];
  if (!hex) return [128, 128, 128];
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function readPalette(): RiverPalette {
  return {
    dark: document.documentElement.classList.contains('dark'),
    raw: token('--color-ink-muted'),
    current: token('--color-current'),
    dawn: token('--color-dawn'),
    buoy: token('--color-buoy'),
    flare: token('--color-flare'),
    slate: token('--color-slate'),
    ink: token('--color-ink'),
  };
}

/** The theme's colours, read again whenever the theme changes. */
function usePalette(): RiverPalette {
  const [palette, setPalette] = useState(readPalette);
  useEffect(() => {
    const observer = new MutationObserver(() => setPalette(readPalette()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return palette;
}

/**
 * The fleet as a river (docs/10-design-system.md §10.8): every materialization a channel from Kafka,
 * through Midstream, into the lake, its records moving at its own pace (`riverEngine.ts`). Point at a
 * channel to name it; click to open it. The same channels are links for a keyboard or screen reader.
 */
export function River({
  strands,
  rows,
  kafka,
  midstream,
  lake,
  className,
}: {
  strands: Strand[];
  /** Rows committed across the fleet: how full the lake shows; null while unknown. */
  rows: number | null;
  /** The three labels above the river: its source, the materializations, its lake. */
  kafka: ReactNode;
  midstream: ReactNode;
  lake: ReactNode;
  className?: string;
}): ReactNode {
  const box = useRef<HTMLDivElement>(null);
  const bed = useRef<HTMLCanvasElement>(null);
  const water = useRef<HTMLCanvasElement>(null);
  const glow = useRef<HTMLCanvasElement>(null);
  const engine = useRef<RiverEngine | null>(null);
  const { width, height } = useElementSize(box);
  const reduced = usePrefersReducedMotion();
  const palette = usePalette();
  const navigate = useNavigate();
  const [hover, setHover] = useState<{ key: string; x: number; y: number } | null>(null);
  const [visible, setVisible] = useState(true);

  const riverStrands = useMemo<RiverStrand[]>(
    () => strands.map((strand) => ({ key: strand.key, label: strand.label, kind: strand.status.kind, rate: strand.rate })),
    [strands],
  );

  useEffect(() => {
    if (!bed.current || !water.current) return;
    engine.current = new RiverEngine(bed.current, water.current, glow.current, readPalette());
    return () => {
      engine.current?.destroy();
      engine.current = null;
    };
  }, []);

  useEffect(() => engine.current?.setPalette(palette), [palette]);
  useEffect(() => {
    if (width > 0 && height > 0) engine.current?.resize(width, height, window.devicePixelRatio || 1);
  }, [width, height]);
  useEffect(() => engine.current?.setStrands(riverStrands), [riverStrands]);
  useEffect(() => engine.current?.setLakeRows(rows), [rows]);
  useEffect(() => engine.current?.setHover(hover?.key ?? null), [hover?.key]);

  // Running only while on screen, in a tab that is showing, and when motion is welcome.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? true));
    observer.observe(element);
    const onVisibility = (): void => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  useEffect(() => {
    if (!engine.current) return;
    if (visible && !reduced) engine.current.start();
    else engine.current.stop();
  }, [visible, reduced]);

  const hovered = hover ? strands.find((strand) => strand.key === hover.key) : undefined;

  return (
    <div className={cn('relative', className)}>
      {/* Three columns, the middle one centred exactly: over the gate, which is the river's middle. */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-baseline gap-3 text-[12px] text-[var(--color-ink-muted)]">
        <span className="min-w-0 truncate">{kafka}</span>
        <span className="min-w-0 truncate text-center">{midstream}</span>
        <span className="min-w-0 truncate text-right">{lake}</span>
      </div>
      <div
        ref={box}
        className="relative mt-2 h-[200px] cursor-pointer sm:h-[250px]"
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const y = event.clientY - rect.top;
          const key = engine.current?.hit(x, y) ?? null;
          setHover(key ? { key, x, y } : null);
        }}
        onMouseLeave={() => setHover(null)}
        onClick={() => {
          const target = hover ? strands.find((strand) => strand.key === hover.key) : undefined;
          if (target) void navigate(target.to);
        }}
      >
        {/* Clipped to the river, so the bloom ends with the water rather than spilling past the panel. */}
        <div className="absolute inset-0 overflow-hidden">
          <canvas ref={bed} aria-hidden className="absolute inset-0 h-full w-full" />
          {/* The bloom: the water again, blurred beneath it - light in the dark, a soft tint in the light. */}
          <canvas
            ref={glow}
            aria-hidden
            className="absolute inset-0 h-full w-full opacity-40 mix-blend-multiply blur-[5px] dark:opacity-80 dark:mix-blend-screen dark:blur-[7px] dark:saturate-150"
          />
          <canvas ref={water} aria-hidden className="absolute inset-0 h-full w-full" />
        </div>
        {hovered && hover ? (
          <p
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-[var(--radius-control)] border border-[var(--color-line-strong)] bg-[var(--color-pop)] px-2.5 py-1 text-[12px] whitespace-nowrap shadow-sm"
            style={{ left: Math.min(Math.max(hover.x, 90), width - 90), top: Math.max(hover.y - 10, 24) }}
          >
            <span className="font-medium">{hovered.label}</span>
            <span className="text-[var(--color-ink-muted)]">
              {' '}
              · {hovered.status.label}
              {hovered.rate !== null && hovered.status.kind !== 'stopped' ? ` · ${formatReadoutRate(hovered.rate)} rows a second` : ''}
            </span>
          </p>
        ) : null}
      </div>
      <ul className="sr-only">
        {strands.map((strand) => (
          <li key={strand.key}>
            <Link to={strand.to}>
              {strand.label}: {strand.status.label}
              {strand.rate !== null ? `, ${formatReadoutRate(strand.rate)} rows a second` : ''}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
