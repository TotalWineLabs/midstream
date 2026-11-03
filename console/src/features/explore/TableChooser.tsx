import { ChevronDown, Search } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { searchLake, type LakeDomain, type LakeTable, type TableMatch } from './lake';
import { StatusGlyph } from '@/components/Status';
import { Popover } from '@/components/ui/Popover';
import { cn } from '@/lib/cn';
import { segmentName } from '@/lib/nameSearch';
import type { TableRef } from '@shared/types';

/** Tables the chooser lists at once: a name narrows them. */
const SHOWN = 60;

/**
 * The composer's source, in an exploration (docs/design/explore.md §4.4): the table it browses, by
 * its full name, and the way to choose another - a search over every table the person may browse.
 */
export function TableChooser({
  lake,
  source,
  many,
  onChoose,
}: {
  lake: readonly LakeDomain[];
  source: TableRef | null;
  /** The console serves several domains: names carry theirs. */
  many: boolean;
  onChoose: (table: LakeTable) => void;
}): ReactNode {
  return (
    <Popover
      width={420}
      trigger={({ toggle, open, id }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={id}
          aria-label={source ? `From ${source.domain}.${source.dataset}.${source.table}: choose another table` : 'Choose a table'}
          data-role="from"
          className="inline-flex h-8 max-w-[min(420px,60vw)] shrink-0 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2.5 text-[12px] text-[var(--color-ink)] transition-colors hover:bg-[var(--color-raised)]"
        >
          <span className="shrink-0 text-[var(--color-ink-muted)]">From</span>
          {source ? (
            <span className="ident min-w-0 truncate">
              <span className="text-[var(--color-ink-faint)]">{source.domain}.</span>
              {source.dataset}.{source.table}
            </span>
          ) : (
            <span className="font-medium">Choose a table</span>
          )}
          <ChevronDown className="size-3.5 shrink-0 text-[var(--color-ink-faint)]" />
        </button>
      )}
    >
      {({ close }) => (
        <ChooserBody
          lake={lake}
          many={many}
          current={source}
          onChoose={(table) => {
            close();
            onChoose(table);
          }}
        />
      )}
    </Popover>
  );
}

function ChooserBody({
  lake,
  many,
  current,
  onChoose,
}: {
  lake: readonly LakeDomain[];
  many: boolean;
  current: TableRef | null;
  onChoose: (table: LakeTable) => void;
}): ReactNode {
  const [text, setText] = useState('');
  const query = useDeferredValue(text);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  // Only what the person may browse: a locked table is named in the rail, never offered here.
  const matches = useMemo<TableMatch[]>(
    () => searchLake(lake, query, { qualified: many }).filter((match) => match.table.browsable).slice(0, SHOWN),
    [lake, query, many],
  );
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, Math.max(matches.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = matches[active];
      if (chosen) onChoose(chosen.table);
    }
  };

  return (
    <div className="flex max-h-[min(480px,calc(100dvh-240px))] flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--color-line)] px-3">
        <Search className="size-3.5 shrink-0 text-[var(--color-ink-faint)]" />
        <input
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={many ? 'A table, a dataset, or domain.dataset.table' : 'A table, or dataset.table'}
          aria-label="Choose a table to browse"
          role="combobox"
          aria-expanded="true"
          aria-controls="table-chooser-results"
          aria-activedescendant={matches[active] ? `table-choice-${active}` : undefined}
          className="h-10 min-w-0 flex-1 bg-transparent text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)]"
        />
      </div>
      <div ref={list} id="table-chooser-results" role="listbox" aria-label="Tables" className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {matches.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12px] text-[var(--color-ink-muted)]">
            {query.trim() ? 'No table you may browse has that name.' : 'There is no table you may browse yet.'}
          </p>
        ) : (
          matches.map((match, index) => {
            const chosen = current !== null && match.table.key === `${current.domain}.${current.dataset}.${current.table}`.toLowerCase();
            return (
              <button
                key={match.table.key}
                id={`table-choice-${index}`}
                data-index={index}
                type="button"
                role="option"
                aria-selected={index === active}
                onMouseMove={() => setActive(index)}
                onClick={() => onChoose(match.table)}
                title={match.table.topic ? `From topic ${match.table.topic}` : undefined}
                className={cn(
                  'flex h-9 w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 text-left text-[12.5px] transition-colors',
                  index === active ? 'bg-[var(--color-raised)] text-[var(--color-ink)]' : 'text-[var(--color-ink-muted)]',
                )}
              >
                <span className="grid size-4 shrink-0 place-items-center" aria-hidden>
                  {match.table.status ? <StatusGlyph status={match.table.status} /> : null}
                </span>
                <span className={cn('ident min-w-0 flex-1 truncate', chosen ? 'font-semibold text-[var(--color-ink)]' : 'text-[var(--color-ink)]')}>
                  {segmentName(match.shown, match.ranges).map((segment, at) =>
                    segment.match ? (
                      <mark key={at} className="bg-transparent font-semibold text-[var(--color-ink)]">
                        {segment.text}
                      </mark>
                    ) : (
                      <span key={at}>{segment.text}</span>
                    ),
                  )}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
