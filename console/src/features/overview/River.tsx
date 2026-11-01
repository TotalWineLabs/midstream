import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { cn } from '@/lib/cn';
import { usePrefersReducedMotion } from '@/lib/motion';
import type { Status, StatusKind } from '@/lib/status';
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

const HEIGHT = 168;
/** Strands drawn at most: the busiest; the rest are counted beside the river. */
const MAX_STRANDS = 24;

/** A strand's colour: Current while it moves, a state's colour only when something is wrong. */
const STRAND: Record<StatusKind, string> = {
  flowing: 'var(--color-current)',
  'catching-up': 'var(--color-current)',
  starting: 'var(--color-dawn)',
  attention: 'var(--color-buoy)',
  failed: 'var(--color-flare)',
  stopped: 'var(--color-slate)',
};

/** Dots move faster as more flows: a whole period in eight seconds when barely anything does, in about one at tens of thousands a second. */
function flowSeconds(rate: number | null): number {
  return Math.max(1.1, Math.min(8, 8 - 1.55 * Math.log10(1 + Math.max(0, rate ?? 0))));
}

/**
 * The fleet as a river (docs/10-design-system.md §10.8): every materialization a strand from Kafka,
 * through Midstream, to the lake. A strand's width is its throughput and its dots move at its pace;
 * colour appears only where something is wrong; a stopped strand is still and dashed. Point at a
 * strand to name it, and open it with a click or Enter.
 */
export function River({
  strands,
  kafka,
  midstream,
  lake,
  className,
}: {
  strands: Strand[];
  /** The three labels above the river: its source, the materializations, its lake. */
  kafka: ReactNode;
  midstream: ReactNode;
  lake: ReactNode;
  className?: string;
}): ReactNode {
  const box = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(box);
  const reduced = usePrefersReducedMotion();
  const navigate = useNavigate();
  const [hover, setHover] = useState<string | null>(null);

  const drawn = useMemo(() => {
    const shown = [...strands].sort((left, right) => (right.rate ?? 0) - (left.rate ?? 0)).slice(0, MAX_STRANDS);
    const peak = Math.max(1e-9, ...shown.map((strand) => strand.rate ?? 0));
    // Problems ride on top, where the eye starts.
    const order: StatusKind[] = ['failed', 'attention', 'starting', 'catching-up', 'flowing', 'stopped'];
    shown.sort((left, right) => order.indexOf(left.status.kind) - order.indexOf(right.status.kind));
    return shown.map((strand) => ({
      ...strand,
      width: strand.status.kind === 'stopped' ? 1.25 : 1.75 + 9 * Math.sqrt(Math.max(0, strand.rate ?? 0) / peak),
    }));
  }, [strands]);

  const paths = useMemo(() => {
    if (width <= 0 || drawn.length === 0) return [];
    const spread = (top: number, bottom: number): number[] => {
      const total = drawn.reduce((sum, strand) => sum + strand.width, 0);
      const gap = drawn.length > 1 ? Math.max(1.5, (bottom - top - total) / (drawn.length - 1)) : 0;
      const used = total + gap * (drawn.length - 1);
      let cursor = (top + bottom) / 2 - used / 2;
      return drawn.map((strand) => {
        const middle = cursor + strand.width / 2;
        cursor += strand.width + gap;
        return middle;
      });
    };
    const left = spread(26, HEIGHT - 18);
    // Through Midstream the strands run close: one service carrying them all.
    const pinch = spread(HEIGHT / 2 - Math.min(26, 4 + drawn.length * 3), HEIGHT / 2 + Math.min(26, 4 + drawn.length * 3));
    const right = spread(34, HEIGHT - 26);
    const mid = width / 2;
    return drawn.map((strand, index) => ({
      strand,
      d: `M0 ${left[index]} C${width * 0.24} ${left[index]} ${width * 0.3} ${pinch[index]} ${mid} ${pinch[index]} S${width * 0.76} ${right[index]} ${width} ${right[index]}`,
    }));
  }, [drawn, width]);

  const hovered = paths.find((path) => path.strand.key === hover)?.strand ?? null;

  return (
    <div className={cn('relative', className)}>
      <div className="flex items-baseline justify-between gap-3 text-[12px] text-[var(--color-ink-muted)]">
        <span className="min-w-0 truncate">{kafka}</span>
        <span className="min-w-0 truncate text-center">{midstream}</span>
        <span className="min-w-0 truncate text-right">{lake}</span>
      </div>
      <div ref={box} className="relative mt-2" style={{ height: HEIGHT }}>
        {width > 0 ? (
          <svg width={width} height={HEIGHT} className="block overflow-visible" role="list" aria-label="Materializations, as strands from Kafka to the lake">
            <defs>
              {/* The river comes out of its source and runs into its lake: both ends fade. */}
              <linearGradient id="river-fade">
                <stop offset="0" stopColor="#fff" stopOpacity="0" />
                <stop offset="0.08" stopColor="#fff" />
                <stop offset="0.92" stopColor="#fff" />
                <stop offset="1" stopColor="#fff" stopOpacity="0" />
              </linearGradient>
              <mask id="river-ends">
                <rect width={width} height={HEIGHT} fill="url(#river-fade)" />
              </mask>
            </defs>
            <line x1={width / 2} x2={width / 2} y1={8} y2={HEIGHT - 8} stroke="var(--color-line-strong)" strokeDasharray="2 4" />
            <g mask="url(#river-ends)">
              {paths.map(({ strand, d }) => {
                const color = STRAND[strand.status.kind];
                const stopped = strand.status.kind === 'stopped';
                const faded = hover !== null && hover !== strand.key;
                const moving = !stopped && strand.status.kind !== 'failed' && (strand.rate ?? 0) > 0 && !reduced;
                return (
                  <g
                    key={strand.key}
                    role="listitem"
                    tabIndex={0}
                    aria-label={`${strand.label}: ${strand.status.label}`}
                    className="cursor-pointer outline-none"
                    style={{ opacity: faded ? 0.25 : 1, transition: 'opacity var(--duration-quick) var(--ease-out)' }}
                    onMouseEnter={() => setHover(strand.key)}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(strand.key)}
                    onBlur={() => setHover(null)}
                    onClick={() => void navigate(strand.to)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void navigate(strand.to);
                    }}
                  >
                    {/* A wide, invisible path: a thin strand is still easy to point at. */}
                    <path d={d} fill="none" stroke="transparent" strokeWidth={Math.max(12, strand.width + 8)} />
                    <path
                      d={d}
                      fill="none"
                      stroke={color}
                      strokeOpacity={stopped ? 0.7 : 0.38}
                      strokeWidth={strand.width}
                      strokeLinecap="round"
                      strokeDasharray={stopped ? '3 5' : undefined}
                    />
                    {moving ? (
                      <path
                        d={d}
                        fill="none"
                        stroke={color}
                        strokeWidth={Math.max(1.5, strand.width * 0.55)}
                        strokeLinecap="round"
                        strokeDasharray="0 18"
                        className="river-flow"
                        style={{ animationDuration: `${flowSeconds(strand.rate)}s` }}
                      />
                    ) : null}
                  </g>
                );
              })}
            </g>
          </svg>
        ) : null}
        {hovered ? (
          <p className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 rounded-[var(--radius-control)] border border-[var(--color-line-strong)] bg-[var(--color-pop)] px-2.5 py-1 text-[12px] whitespace-nowrap shadow-sm">
            <span className="font-medium">{hovered.label}</span>
            <span className="text-[var(--color-ink-muted)]"> · {hovered.status.label}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
