import type { ReactNode } from 'react';

import { clipRanges, splitFoundName } from './lake';
import { cn } from '@/lib/cn';
import { segmentName } from '@/lib/nameSearch';

/** How much of its end a name cut short keeps: where names that share a start differ. */
const KEPT_END = 14;

/**
 * A found table: its own name first, where it lives after it in faint - what tells tables apart
 * leads, and the place, shared by its neighbours, gives way first when the row is narrow.
 */
export function FoundName({ shown, ranges, strong = false }: { shown: string; ranges: Array<[number, number]>; strong?: boolean }): ReactNode {
  const { name, nameRanges, place, placeRanges } = splitFoundName(shown, ranges);
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className={cn('ident flex max-w-full shrink-0 text-[var(--color-ink)]', strong && 'font-semibold')}>
        <CutName text={name} ranges={nameRanges} />
      </span>
      {place ? (
        <span className="ident min-w-0 truncate text-[11px] text-[var(--color-ink-faint)]">
          <Marked text={place} ranges={placeRanges} />
        </span>
      ) : null}
    </span>
  );
}

/**
 * A name too long for its row, cut in the middle: its start, an ellipsis, and its end. The tables
 * of one place often share a start - `midstream_control_plane_app_…` - and differ at the end.
 */
export function CutName({ text, ranges = [] }: { text: string; ranges?: Array<[number, number]> }): ReactNode {
  if (text.length <= KEPT_END + 4) {
    return (
      <span className="min-w-0 truncate">
        <Marked text={text} ranges={ranges} />
      </span>
    );
  }
  const cut = text.length - KEPT_END;
  // Two boxes on screen read as two words to a screen reader: it hears the name whole instead.
  return (
    <span className="flex min-w-0">
      <span className="sr-only">{text}</span>
      <span aria-hidden className="min-w-0 truncate">
        <Marked text={text.slice(0, cut)} ranges={clipRanges(ranges, 0, cut)} />
      </span>
      <span aria-hidden className="shrink-0">
        <Marked text={text.slice(cut)} ranges={clipRanges(ranges, cut, text.length)} />
      </span>
    </span>
  );
}

/** A name with what the search matched in ink and bold. */
function Marked({ text, ranges }: { text: string; ranges: Array<[number, number]> }): ReactNode {
  if (ranges.length === 0) return text;
  return segmentName(text, ranges).map((segment, at) =>
    segment.match ? (
      <mark key={at} className="bg-transparent font-semibold text-[var(--color-ink)]">
        {segment.text}
      </mark>
    ) : (
      <span key={at}>{segment.text}</span>
    ),
  );
}
