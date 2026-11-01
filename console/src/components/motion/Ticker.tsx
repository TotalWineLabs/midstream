import { useState, type CSSProperties, type ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { formatExact } from '@/lib/format';
import { usePrefersReducedMotion } from '@/lib/motion';
import { restFor, rollTo, trendOf } from '@/lib/ticker';

const STRIP = Array.from({ length: 30 }, (_, index) => index % 10);

/**
 * A live number whose digits roll to their new values, up as it grows and down as it shrinks, so a
 * change reads as movement in a direction rather than a flicker (docs/10-design-system.md §10.7).
 *
 * Digits are matched from the right, so the ones stay the ones as the number grows a digit; a digit
 * or separator the number gains rises into place. Screen readers get the formatted number once.
 * For numbers that change while someone watches them — rates, counts, lag — not static figures.
 */
export function Ticker({
  value,
  format = formatExact,
  className,
}: {
  value: number | null | undefined;
  format?: (value: number | null | undefined) => string;
  className?: string;
}): ReactNode {
  const reduced = usePrefersReducedMotion();
  const [seen, setSeen] = useState({ value, trend: 0, settled: false });
  if (!Object.is(seen.value, value)) setSeen({ value, trend: trendOf(seen.value, value), settled: true });

  const text = format(value);
  const chars = Array.from(text);
  // Nothing rises on the first render: only what a change brings.
  const enter = seen.settled && !reduced;

  return (
    <span className={cn('ticker', className)}>
      <span className="sr-only">{text}</span>
      <span aria-hidden className="contents">
        {chars.map((char, index) => {
          const fromRight = chars.length - index;
          return char >= '0' && char <= '9' ? (
            <Digit key={`d${fromRight}`} digit={Number(char)} trend={seen.trend} reduced={reduced} enter={enter} />
          ) : (
            <Symbol key={`s${fromRight}${char}`} char={char} enter={enter} />
          );
        })}
      </span>
    </span>
  );
}

function Digit({ digit, trend, reduced, enter }: { digit: number; trend: number; reduced: boolean; enter: boolean }): ReactNode {
  const [enters] = useState(enter);
  const [strip, setStrip] = useState({ digit, position: restFor(digit), rolling: false });
  if (strip.digit !== digit) {
    const next = reduced ? { position: restFor(digit), rolls: false } : rollTo(strip.position, digit, trend);
    setStrip({ digit, position: next.position, rolling: next.rolls });
  }

  return (
    <span className={cn('ticker-digit', strip.rolling && 'rolling', enters && 'ticker-enter')}>
      <span className="ticker-rest">{digit}</span>
      <span
        className="ticker-strip"
        style={{ '--pos': strip.position } as CSSProperties}
        // Back to the middle run, showing the same digit, ready to roll again either way.
        onTransitionEnd={() => setStrip((current) => ({ ...current, position: restFor(current.digit), rolling: false }))}
      >
        {STRIP.map((cell, index) => (
          <span key={index}>{cell}</span>
        ))}
      </span>
    </span>
  );
}

function Symbol({ char, enter }: { char: string; enter: boolean }): ReactNode {
  const [enters] = useState(enter);
  return <span className={cn(enters && 'ticker-enter')}>{char}</span>;
}
