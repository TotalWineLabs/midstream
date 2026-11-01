import type { ReactNode } from 'react';

import { Shimmer } from './motion/Shimmer';
import { Ticker } from './motion/Ticker';
import { cn } from '@/lib/cn';

/**
 * The number that leads a screen (docs/10-design-system.md §10.8): its state in pills, the number
 * large in the display face with its unit in words, one line of context, and its chart.
 */
export function Readout({
  pills,
  value,
  format,
  unit,
  context,
  children,
  className,
}: {
  pills?: ReactNode;
  value: number | null | undefined;
  format: (value: number | null | undefined) => string;
  unit: ReactNode;
  context?: ReactNode;
  /** The number's chart, beneath it. */
  children?: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <section className={cn('min-w-0', className)}>
      {pills ? <div className="flex flex-wrap items-center gap-2">{pills}</div> : null}
      <p className="mt-4 flex min-h-[46px] flex-wrap items-baseline gap-x-3 gap-y-1 sm:min-h-[63px]">
        {value === null || value === undefined ? (
          // Not measured yet, as when the console has just started: say so, rather than a dash set large.
          <span className="self-center text-[16px] text-[var(--color-ink-muted)] sm:text-[18px]">
            <Shimmer>Measuring {unit}…</Shimmer>
          </span>
        ) : (
          <>
            <Ticker value={value} format={format} className="display text-[44px] leading-[1.05] font-semibold sm:text-[60px]" />
            <span className="text-[16px] text-[var(--color-ink-muted)] sm:text-[18px]">{unit}</span>
          </>
        )}
      </p>
      {context ? <p className="mt-2 text-[14px] text-[var(--color-ink-muted)]">{context}</p> : null}
      {children ? <div className="mt-5">{children}</div> : null}
    </section>
  );
}

/** A rate for a readout: tenths below ten, whole numbers to a million, then compact. */
export function formatReadoutRate(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value < 0.05) return '0';
  if (value < 10) return value.toFixed(1);
  if (value < 1_000_000) return Math.round(value).toLocaleString('en-US');
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}
