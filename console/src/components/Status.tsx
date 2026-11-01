import { useId, type CSSProperties, type ReactNode } from 'react';

import { cn } from '@/lib/cn';
import type { Status, StatusKind } from '@/lib/status';

/** The colour of each state's shape. Current means flowing and nothing else. */
const COLOR: Record<StatusKind, string> = {
  flowing: 'var(--color-current)',
  'catching-up': 'var(--color-current)',
  starting: 'var(--color-dawn)',
  attention: 'var(--color-buoy)',
  failed: 'var(--color-flare)',
  stopped: 'var(--color-slate)',
};

/** The colour of its word: the same hue, dark enough to read as text. */
const INK: Record<StatusKind, string> = {
  flowing: 'var(--color-current-ink)',
  'catching-up': 'var(--color-current-ink)',
  starting: 'var(--color-dawn-ink)',
  attention: 'var(--color-buoy-ink)',
  failed: 'var(--color-flare-ink)',
  stopped: 'var(--color-ink-muted)',
};

const WASH: Record<StatusKind, string> = {
  flowing: 'var(--color-current-wash)',
  'catching-up': 'var(--color-current-wash)',
  starting: 'var(--color-dawn-wash)',
  attention: 'var(--color-buoy-wash)',
  failed: 'var(--color-flare-wash)',
  stopped: 'var(--color-raised)',
};

/** A wave of parabolic arcs, a period every 6.8 units, three periods long so it can drift one. */
const WAVE = 'q1.7 -2.2 3.4 0 t3.4 0 t3.4 0 t3.4 0 t3.4 0 t3.4 0';

/**
 * A state's shape: a wave, a filling ring, a dotted ring, a diamond, an octagon or a hollow square,
 * so status reads without colour and better with it (docs/10-design-system.md §Status).
 *
 * A state on its way somewhere turns until it settles. A flowing wave drifts only where `animate`
 * asks — the one status a page is about — since a list of drifting waves is noise.
 */
export function StatusGlyph({
  status,
  progress,
  animate = false,
  size = 12,
  className,
}: {
  status: Pick<Status, 'kind' | 'moving'>;
  /** How far a catch-up has come, 0 to 1; without it the ring turns. */
  progress?: number | null;
  animate?: boolean;
  size?: number;
  className?: string;
}): ReactNode {
  const fade = useId();
  const color = COLOR[status.kind];
  const box = { width: size, height: size, viewBox: '0 0 12 12', className: cn('shrink-0', className), 'aria-hidden': true } as const;

  if (status.kind === 'flowing') {
    return (
      <svg {...box}>
        <defs>
          <linearGradient id={`${fade}-g`}>
            <stop offset="0" stopColor="#fff" stopOpacity="0.15" />
            <stop offset="0.25" stopColor="#fff" />
            <stop offset="0.75" stopColor="#fff" />
            <stop offset="1" stopColor="#fff" stopOpacity="0.15" />
          </linearGradient>
          <mask id={`${fade}-m`}>
            <rect width="12" height="12" fill={`url(#${fade}-g)`} />
          </mask>
        </defs>
        <g mask={`url(#${fade}-m)`} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round">
          <g className={animate ? 'glyph-flow' : undefined}>
            <path d={`M-6.8 4.4${WAVE}`} />
            <path d={`M-5.1 8.4${WAVE}`} />
          </g>
        </g>
      </svg>
    );
  }

  if (status.kind === 'catching-up') {
    const known = typeof progress === 'number' && Number.isFinite(progress);
    const arc = known ? Math.max(4, Math.min(100, progress * 100)) : 28;
    return (
      <svg {...box}>
        <circle cx="6" cy="6" r="4.25" fill="none" stroke={color} strokeOpacity="0.25" strokeWidth="2.1" />
        <circle
          cx="6"
          cy="6"
          r="4.25"
          fill="none"
          stroke={color}
          strokeWidth="2.1"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${arc} 100`}
          transform="rotate(-90 6 6)"
          className={cn('glyph-fill', !known && 'glyph-turn')}
        />
      </svg>
    );
  }

  if (status.kind === 'starting' || (status.kind === 'stopped' && status.moving)) {
    return (
      <svg {...box}>
        <circle
          cx="6"
          cy="6"
          r="4.4"
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          pathLength={40}
          strokeDasharray="0 4"
          className="glyph-turn"
        />
      </svg>
    );
  }

  if (status.kind === 'attention') {
    return (
      <svg {...box}>
        <rect x="2.4" y="2.4" width="7.2" height="7.2" rx="1.3" fill={color} transform="rotate(45 6 6)" />
        <path d="M6 3.7v2.6" stroke="#1a1300" strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="6" cy="8.2" r="0.75" fill="#1a1300" />
      </svg>
    );
  }

  if (status.kind === 'failed') {
    return (
      <svg {...box}>
        <polygon points="3.9,0.9 8.1,0.9 11.1,3.9 11.1,8.1 8.1,11.1 3.9,11.1 0.9,8.1 0.9,3.9" fill={color} />
        <rect x="3.3" y="5.25" width="5.4" height="1.5" rx="0.75" fill="#fff" />
      </svg>
    );
  }

  return (
    <svg {...box}>
      <rect x="2" y="2" width="8" height="8" rx="1.6" fill="none" stroke={color} strokeWidth="2" />
    </svg>
  );
}

/** The shape and the word, in the state's ink, with the reason after it when there is room. */
export function StatusLabel({
  status,
  progress,
  showReason = false,
  animate = false,
  className,
}: {
  status: Status;
  progress?: number | null;
  showReason?: boolean;
  animate?: boolean;
  className?: string;
}): ReactNode {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 font-medium whitespace-nowrap', className)}>
      <StatusGlyph status={status} progress={progress} animate={animate} />
      <span style={{ color: INK[status.kind] }}>{status.label}</span>
      {showReason && status.reason ? <span className="truncate font-normal text-[var(--color-ink-muted)]">· {status.reason}</span> : null}
    </span>
  );
}

/** The state on its own wash, for a page header or a readout, where it leads. */
export function StatusPill({
  status,
  progress,
  animate = true,
  className,
}: {
  status: Status;
  progress?: number | null;
  animate?: boolean;
  className?: string;
}): ReactNode {
  return (
    <span
      className={cn('inline-flex h-6 items-center gap-1.5 rounded-full pr-2.5 pl-2 text-[12px] font-semibold whitespace-nowrap', className)}
      style={{ background: WASH[status.kind], color: INK[status.kind] } as CSSProperties}
      title={status.reason ?? undefined}
    >
      <StatusGlyph status={status} progress={progress} animate={animate} />
      {status.label}
    </span>
  );
}
