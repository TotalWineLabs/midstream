import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Copy, ExternalLink, Lock, Plus, Search, X } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { searchLake, type LakeDataset, type LakeDomain, type LakeTable } from './lake';
import { DomainDot } from '@/components/DomainChip';
import { StatusGlyph } from '@/components/Status';
import { Button, Skeleton } from '@/components/ui/primitives';
import { domainApi } from '@/lib/api';
import { cn } from '@/lib/cn';
import { domainPath, tablePath } from '@/lib/paths';
import { rootQueryClient } from '@/lib/queryClient';
import { segmentName } from '@/lib/nameSearch';
import { FOCUS_SEARCH_EVENT, type FocusSearchKey } from '@/lib/shortcuts';
import type { CpSchemaField } from '@shared/types';

/** Search results the rail lists at once: a name narrows them. */
const SHOWN = 100;

/**
 * Explore's Tables rail (docs/design/explore.md §4.3): every domain, its datasets, their tables and
 * their columns, with a search over them. Choosing a table browses it in the exploration on screen,
 * or, while it writes SQL, puts the table's name in its statement; a column's name likewise.
 *
 * Locked datasets are listed with a lock: names are not secret, their schemas and data are.
 */
export function TablesRail({
  lake,
  many,
  scope,
  current,
  writingSql,
  onTable,
  onNewExploration,
  onColumn,
  onCopy,
  onClose,
  width,
}: {
  lake: readonly LakeDomain[];
  many: boolean;
  /** The domain the person came from: opened, the rest folded. */
  scope: string | null;
  /** The table the exploration on screen is about, whose dataset opens with the rail. */
  current: string | null;
  /** The exploration on screen writes SQL: a name goes into its statement. */
  writingSql: boolean;
  onTable: (table: LakeTable) => void;
  onNewExploration: (table: LakeTable) => void;
  onColumn: (table: LakeTable, column: string) => void;
  onCopy: (text: string) => void;
  onClose: () => void;
  /** Its width beside the explorations; null fills a phone's sheet. */
  width: number | null;
}): ReactNode {
  const [text, setText] = useState('');
  const query = useDeferredValue(text.trim());
  const input = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  // `/` finds a table, as it finds a setting on the Settings pages; ⌘K stays the command menu's.
  useEffect(() => {
    const focus = (event: Event): void => {
      if ((event as CustomEvent<FocusSearchKey>).detail !== '/') return;
      event.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener(FOCUS_SEARCH_EVENT, focus);
    return () => window.removeEventListener(FOCUS_SEARCH_EVENT, focus);
  }, []);

  // What is open: the domain the person came from, or every one; the dataset of the table on screen.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(lake.filter((domain) => scope === null || domain.id === scope).map((domain) => domain.id)));
  const currentDataset = current ? current.slice(0, current.lastIndexOf('.')) : null;
  useEffect(() => {
    if (!currentDataset) return;
    const domain = currentDataset.slice(0, currentDataset.indexOf('.'));
    setOpen((was) => (was.has(currentDataset) && was.has(domain) ? was : new Set([...was, domain, currentDataset])));
  }, [currentDataset]);
  const toggle = (key: string): void => setOpen((was) => (was.has(key) ? new Set([...was].filter((entry) => entry !== key)) : new Set([...was, key])));

  const matches = useMemo(() => (query ? searchLake(lake, query, { qualified: many }).slice(0, SHOWN) : []), [lake, query, many]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setText('');
      return;
    }
    if (!query) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, Math.max(matches.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = matches[active];
      if (chosen && chosen.table.queryable) onTable(chosen.table);
    }
  };

  const loading = lake.length === 0 || lake.every((domain) => domain.loading);
  const empty = !loading && lake.every((domain) => domain.datasets.length === 0);
  const rowProps = { many, writingSql, current, onTable, onNewExploration, onColumn, onCopy };

  return (
    <aside
      aria-label="Tables"
      className={cn('flex min-h-0 shrink-0 flex-col bg-[var(--color-surface)]', width === null ? 'w-full' : 'border-r border-[var(--color-line)]')}
      style={width === null ? undefined : { width }}
    >
      <header className="flex items-center gap-2 px-3 pt-3 pb-2">
        <h2 className="min-w-0 flex-1 text-[13px] font-semibold">Tables</h2>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close the table list" title="Close the table list" className="px-1.5 max-md:size-11">
          <X className="size-4" />
        </Button>
      </header>
      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[var(--color-ink-faint)]" />
          <input
            ref={input}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Find a table"
            aria-label="Find a table"
            role="combobox"
            aria-expanded={query.length > 0}
            aria-controls="tables-rail-list"
            aria-activedescendant={query && matches[active] ? `rail-match-${active}` : undefined}
            className="h-8 w-full rounded-[var(--radius-control)] border border-[var(--color-line-strong)] bg-[var(--color-shelf)] pr-7 pl-8 text-[12.5px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-ink-muted)]"
          />
          {text ? null : <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border border-[var(--color-line)] px-1 text-[10px] text-[var(--color-ink-faint)]">/</kbd>}
        </div>
      </div>

      <div ref={list} id="tables-rail-list" className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {loading ? (
          <div className="space-y-2 px-2 py-1" aria-label="Loading tables">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-5" />
            ))}
          </div>
        ) : query ? (
          matches.length === 0 ? (
            <p className="px-3 py-4 text-[12px] text-[var(--color-ink-muted)]">No table has that name.</p>
          ) : (
            <ul role="listbox" aria-label="Tables found">
              {matches.map((match, index) => (
                <li key={match.table.key}>
                  <TableRow
                    {...rowProps}
                    table={match.table}
                    shown={match.shown}
                    ranges={match.ranges}
                    depth={0}
                    option={{ index, active: index === active, onHover: () => setActive(index) }}
                  />
                </li>
              ))}
            </ul>
          )
        ) : empty ? (
          <div className="px-3 py-4 text-[12px] leading-relaxed text-[var(--color-ink-muted)]">
            <p>Nothing to explore yet: no dataset you may see holds a table.</p>
            <Link to="/datasets" className="link mt-2 inline-block font-medium text-[var(--color-ink)]">
              Datasets
            </Link>
          </div>
        ) : (
          <ul aria-label="Domains">
            {lake.map((domain) =>
              many ? (
                <li key={domain.id}>
                  <DomainNode domain={domain} open={open} onToggle={toggle} rowProps={rowProps} />
                </li>
              ) : (
                domain.datasets.map((dataset) => (
                  <li key={dataset.key}>
                    <DatasetNode dataset={dataset} depth={0} open={open} onToggle={toggle} rowProps={rowProps} />
                  </li>
                ))
              ),
            )}
          </ul>
        )}
      </div>
    </aside>
  );
}

type RowProps = {
  many: boolean;
  writingSql: boolean;
  current: string | null;
  onTable: (table: LakeTable) => void;
  onNewExploration: (table: LakeTable) => void;
  onColumn: (table: LakeTable, column: string) => void;
  onCopy: (text: string) => void;
};

/** A row's indent, by how deep it sits. */
const indent = (depth: number): string => (depth === 0 ? 'pl-2' : depth === 1 ? 'pl-6' : depth === 2 ? 'pl-10' : 'pl-14');

function DomainNode({ domain, open, onToggle, rowProps }: { domain: LakeDomain; open: ReadonlySet<string>; onToggle: (key: string) => void; rowProps: RowProps }): ReactNode {
  const expanded = open.has(domain.id);
  const healthy = domain.config.status === 'ok' && domain.config.connected;
  return (
    <>
      <button
        type="button"
        onClick={() => onToggle(domain.id)}
        aria-expanded={expanded}
        className="flex h-8 w-full items-center gap-1.5 rounded-[var(--radius-control)] pr-2 pl-1 text-left text-[12.5px] font-semibold text-[var(--color-ink)] transition-colors hover:bg-[var(--color-raised)]"
      >
        <ChevronRight className={cn('size-3.5 shrink-0 text-[var(--color-ink-faint)] transition-transform', expanded && 'rotate-90')} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{domain.name}</span>
        {/* A domain's dot only when it needs saying: unreachable, reconnecting, not usable. */}
        {healthy ? null : <DomainDot domain={domain.config} />}
      </button>
      {expanded ? (
        domain.access !== 'ok' ? (
          <p className="py-1 pr-2 pl-6 text-[11.5px] text-[var(--color-ink-muted)]">
            {domain.access === 'sign_in_required' ? (
              <>
                <Link to={`/sign-in/${encodeURIComponent(domain.id)}`} className="link font-medium text-[var(--color-ink)]">
                  Sign in
                </Link>{' '}
                to {domain.name} to see its tables.
              </>
            ) : domain.access === 'forbidden' ? (
              `Your groups in ${domain.name} show none of its tables.`
            ) : (
              `${domain.name} cannot be asked right now.`
            )}
          </p>
        ) : domain.loading ? (
          <div className="py-1 pr-2 pl-6">
            <Skeleton className="h-4" />
          </div>
        ) : domain.datasets.length === 0 ? (
          <p className="py-1 pr-2 pl-6 text-[11.5px] text-[var(--color-ink-muted)]">No tables yet.</p>
        ) : (
          <ul>
            {domain.datasets.map((dataset) => (
              <li key={dataset.key}>
                <DatasetNode dataset={dataset} depth={1} open={open} onToggle={onToggle} rowProps={rowProps} />
              </li>
            ))}
          </ul>
        )
      ) : null}
    </>
  );
}

function DatasetNode({
  dataset,
  depth,
  open,
  onToggle,
  rowProps,
}: {
  dataset: LakeDataset;
  depth: number;
  open: ReadonlySet<string>;
  onToggle: (key: string) => void;
  rowProps: RowProps;
}): ReactNode {
  const expanded = open.has(dataset.key);
  return (
    <>
      <button
        type="button"
        onClick={() => onToggle(dataset.key)}
        aria-expanded={expanded}
        title={dataset.locked ? `Locked: you see its tables’ names, not their schemas or data. Ask one of its owners for a role on ${dataset.name}.` : dataset.description || undefined}
        className={cn(
          'flex h-8 w-full items-center gap-1.5 rounded-[var(--radius-control)] pr-2 text-left text-[12.5px] transition-colors hover:bg-[var(--color-raised)]',
          depth === 0 ? 'pl-1' : 'pl-5',
          dataset.locked ? 'text-[var(--color-ink-muted)]' : 'text-[var(--color-ink)]',
        )}
      >
        <ChevronRight className={cn('size-3.5 shrink-0 text-[var(--color-ink-faint)] transition-transform', expanded && 'rotate-90')} aria-hidden />
        <span className="ident min-w-0 flex-1 truncate">{dataset.name}</span>
        {dataset.locked ? <Lock className="size-3 shrink-0 text-[var(--color-ink-faint)]" aria-label="Locked" /> : null}
        <span className="numeric shrink-0 text-[11px] text-[var(--color-ink-faint)]">{dataset.tables.length}</span>
      </button>
      {expanded ? (
        dataset.tables.length === 0 ? (
          <p className={cn('py-1 pr-2 text-[11.5px] text-[var(--color-ink-muted)]', indent(depth + 1))}>No tables yet.</p>
        ) : (
          <ul>
            {dataset.tables.map((table) => (
              <li key={table.key}>
                <TableRow {...rowProps} table={table} shown={table.ref.table} ranges={[]} depth={depth + 1} expandable open={open} onToggle={onToggle} />
              </li>
            ))}
          </ul>
        )
      ) : null}
    </>
  );
}

/** What choosing a table does, said where it can be done. */
function tableTitle(table: LakeTable, writingSql: boolean): string {
  if (table.locked) return `Locked: ask one of the owners of ${table.ref.dataset} for a role on it.`;
  if (!table.queryable) return `You may not query ${table.ref.dataset}.`;
  const name = `${table.ref.domain}.${table.ref.dataset}.${table.ref.table}`;
  if (writingSql) return `Put ${name} in the statement`;
  return table.browsable ? `Browse ${name}` : `Query ${name} in SQL`;
}

function TableRow({
  table,
  shown,
  ranges,
  depth,
  writingSql,
  current,
  onTable,
  onNewExploration,
  onColumn,
  onCopy,
  expandable = false,
  open,
  onToggle,
  option,
}: RowProps & {
  table: LakeTable;
  shown: string;
  ranges: Array<[number, number]>;
  depth: number;
  /** In the tree: its columns open beneath it. */
  expandable?: boolean;
  open?: ReadonlySet<string>;
  onToggle?: (key: string) => void;
  /** In search results: an option of the list the search box moves through. */
  option?: { index: number; active: boolean; onHover: () => void };
}): ReactNode {
  const usable = table.queryable;
  const columnsKey = `${table.key}#columns`;
  const expanded = expandable && (open?.has(columnsKey) ?? false);
  const isCurrent = current === table.key;
  const name = `${table.ref.domain}.${table.ref.dataset}.${table.ref.table}`;
  return (
    <>
      <div
        className={cn(
          'group flex h-8 items-center gap-1 rounded-[var(--radius-control)] pr-1 transition-colors hover:bg-[var(--color-raised)]',
          option?.active && 'bg-[var(--color-raised)]',
          isCurrent && 'bg-[var(--color-raised)] shadow-[inset_2px_0_0_var(--color-ink)]',
          expandable ? (depth <= 1 ? 'pl-5' : 'pl-9') : 'pl-2',
        )}
        onMouseMove={option?.onHover}
      >
        {expandable ? (
          <button
            type="button"
            onClick={() => onToggle?.(columnsKey)}
            aria-expanded={expanded}
            aria-label={expanded ? `Hide the columns of ${shown}` : `Show the columns of ${shown}`}
            disabled={!usable}
            className="grid size-5 shrink-0 place-items-center rounded text-[var(--color-ink-faint)] hover:text-[var(--color-ink)] disabled:opacity-40"
          >
            <ChevronRight className={cn('size-3 transition-transform', expanded && 'rotate-90')} aria-hidden />
          </button>
        ) : null}
        <button
          type="button"
          id={option ? `rail-match-${option.index}` : undefined}
          data-index={option?.index}
          role={option ? 'option' : undefined}
          aria-selected={option ? option.active : undefined}
          aria-disabled={!usable}
          onClick={usable ? () => onTable(table) : undefined}
          title={tableTitle(table, writingSql)}
          className={cn('flex h-8 min-w-0 flex-1 items-center gap-2 text-left text-[12.5px]', usable ? 'text-[var(--color-ink)]' : 'cursor-default text-[var(--color-ink-faint)]')}
        >
          <span className="grid size-3.5 shrink-0 place-items-center" aria-hidden>
            {table.locked ? <Lock className="size-3" /> : table.status ? <StatusGlyph status={table.status} /> : null}
          </span>
          <span className="ident min-w-0 truncate">
            {ranges.length > 0
              ? segmentName(shown, ranges).map((segment, at) =>
                  segment.match ? (
                    <mark key={at} className="bg-transparent font-semibold text-[var(--color-ink)]">
                      {segment.text}
                    </mark>
                  ) : (
                    <span key={at}>{segment.text}</span>
                  ),
                )
              : shown}
          </span>
        </button>
        {usable ? (
          <span className="flex shrink-0 items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
            {table.browsable ? (
              <RowAction label={`Browse ${name} in a new exploration`} onClick={() => onNewExploration(table)}>
                <Plus className="size-3.5" />
              </RowAction>
            ) : null}
            <RowAction label={`Copy ${name}`} onClick={() => onCopy(name)}>
              <Copy className="size-3.5" />
            </RowAction>
            {table.browsable ? (
              <Link
                to={domainPath(table.ref.domain, tablePath(table.ref.dataset, table.ref.table))}
                aria-label={`Open the page of ${name}`}
                title="Open its page"
                className="grid size-6 place-items-center rounded text-[var(--color-ink-faint)] hover:bg-[var(--color-ridge)] hover:text-[var(--color-ink)]"
              >
                <ExternalLink className="size-3.5" />
              </Link>
            ) : null}
          </span>
        ) : null}
      </div>
      {expanded ? <TableColumns table={table} depth={depth} writingSql={writingSql} onColumn={onColumn} /> : null}
    </>
  );
}

function RowAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid size-6 place-items-center rounded text-[var(--color-ink-faint)] hover:bg-[var(--color-ridge)] hover:text-[var(--color-ink)]"
    >
      {children}
    </button>
  );
}

/**
 * A table's columns, by the names SQL reads them by, read when first opened. A kept table - one the
 * fleet no longer lists as written - is found through its dataset first.
 */
function TableColumns({
  table,
  depth,
  writingSql,
  onColumn,
}: {
  table: LakeTable;
  depth: number;
  writingSql: boolean;
  onColumn: (table: LakeTable, column: string) => void;
}): ReactNode {
  const writer = useTableWriter(table);
  const schema = useQuery(
    {
      queryKey: ['lake-schema', table.ref.domain, writer.materializationId, table.ref.table],
      queryFn: () => domainApi(table.ref.domain).schema(writer.materializationId as string, table.ref.table),
      enabled: writer.materializationId !== null,
      staleTime: 5 * 60_000,
      retry: 0,
    },
    rootQueryClient,
  );
  const fields = useMemo(() => columnsOf(schema.data?.fields ?? []), [schema.data]);
  const pad = depth <= 1 ? 'pl-11' : 'pl-[3.75rem]';
  if (writer.pending || schema.isLoading) {
    return (
      <div className={cn('py-1 pr-2', pad)}>
        <Skeleton className="h-4" />
      </div>
    );
  }
  if (writer.materializationId === null || schema.isError) {
    return <p className={cn('py-1 pr-2 text-[11.5px] text-[var(--color-ink-muted)]', pad)}>Its columns cannot be read now.</p>;
  }
  return (
    <ul aria-label={`Columns of ${table.ref.dataset}.${table.ref.table}`}>
      {fields.map((field) => (
        <li key={field.name}>
          <button
            type="button"
            onClick={() => onColumn(table, field.name)}
            title={writingSql ? `Put "${field.name}" in the statement` : `Copy ${field.name}`}
            className={cn('flex h-7 w-full items-center gap-2 rounded-[var(--radius-control)] pr-2 text-left text-[12px] transition-colors hover:bg-[var(--color-raised)]', pad)}
          >
            <span className="ident min-w-0 flex-1 truncate text-[var(--color-ink)]">{field.name}</span>
            <span className="ident shrink-0 text-[11px] text-[var(--color-ink-faint)]">{field.type}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A schema's columns as SQL reads them: fields first, then the Kafka metadata. */
function columnsOf(fields: readonly CpSchemaField[]): Array<{ name: string; type: string }> {
  const leaves = fields.filter((field) => field.kind !== 'container');
  const metadata = leaves.filter((field) => field.kind === 'metadata');
  const payload = leaves.filter((field) => field.kind !== 'metadata');
  const seen = new Set<string>();
  return [...payload, ...metadata]
    .filter((field) => (seen.has(field.name) ? false : (seen.add(field.name), true)))
    .map((field) => ({ name: field.name, type: shortType(field.type) }));
}

/** A type in a word: `struct`, `list`, or the scalar. */
function shortType(type: string): string {
  const base = type.replace(/<.*$/, '');
  return base === 'timestamptz' ? 'timestamp' : base;
}

/**
 * The materialization writing a table: the fleet's, or - for a kept table, which the fleet no
 * longer lists - its dataset's record of it, read when someone needs it.
 */
export function useTableWriter(table: Pick<LakeTable, 'ref' | 'materializationId'> | null): { materializationId: string | null; pending: boolean } {
  const lookup = useQuery(
    {
      queryKey: ['lake-dataset', table?.ref.domain ?? null, table?.ref.dataset ?? null],
      queryFn: () => domainApi(table?.ref.domain as string).dataset(table?.ref.dataset as string),
      enabled: table !== null && table.materializationId === null,
      staleTime: 30_000,
      retry: 0,
    },
    rootQueryClient,
  );
  if (!table) return { materializationId: null, pending: false };
  if (table.materializationId !== null) return { materializationId: table.materializationId, pending: false };
  const entry = lookup.data?.tables.find((candidate) => candidate.name.toLowerCase() === table.ref.table.toLowerCase() && candidate.state !== 'dropped');
  return { materializationId: entry?.materialization_id ?? null, pending: lookup.isLoading };
}
