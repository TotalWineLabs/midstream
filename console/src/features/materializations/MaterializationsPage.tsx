import { Search } from 'lucide-react';
import { useDeferredValue, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { MaterializationRow } from './MaterializationRow';
import { NewMaterialization } from '../domains/NewMaterialization';
import { HiddenDomains } from '../domains/HiddenDomains';
import { PageBody, PageHeader } from '@/components/AppShell';
import { RelativeTime } from '@/components/Inline';
import { StatusGlyph } from '@/components/Status';
import { Button, EmptyState, Input, Panel, Skeleton } from '@/components/ui/primitives';
import { displayName, formatCount } from '@/lib/format';
import { domainPath, useManyDomains, useOptionalDomain } from '@/lib/domains';
import { useFleet, type DomainMaterialization } from '@/lib/fleet';
import { itemStatus, statusGroup, type StatusGroup } from '@/lib/status';
import { isDeletedPhase } from '@shared/types';

/** The groups, in the order people act on them (docs/10-design-system.md §10.6). */
const GROUPS: Array<{ group: StatusGroup; title: string }> = [
  { group: 'needs-you', title: 'Needs you' },
  { group: 'in-progress', title: 'In progress' },
  { group: 'flowing', title: 'Flowing' },
  { group: 'stopped', title: 'Stopped' },
];

/** What a row shows is what a search matches: its name, id, domain, topics, datasets and tables. */
function matches(item: DomainMaterialization, query: string): boolean {
  if (!query) return true;
  return [item.materialization_id, item.name, item.domain, item.domainName, ...item.source_topics, ...(item.datasets ?? []), ...item.tables]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase().includes(query));
}

/** Arrow keys, or j and k, move between rows; Enter opens one. */
function onListKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
  const forward = event.key === 'ArrowDown' || event.key === 'j';
  const back = event.key === 'ArrowUp' || event.key === 'k';
  if (!forward && !back) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-row]')];
  const at = rows.indexOf(document.activeElement as HTMLElement);
  const next = rows[Math.max(0, Math.min(rows.length - 1, at + (forward ? 1 : -1)))];
  if (!next) return;
  event.preventDefault();
  next.focus();
}

/**
 * Which one needs me? (docs/10-design-system.md §10.5) Every domain's materializations, or the
 * page's domain's, grouped by what someone does about them: the ones that need you first.
 */
export function MaterializationsPage(): ReactNode {
  const scope = useOptionalDomain();
  const { data } = useFleet(scope?.id ?? null);
  const manyDomains = useManyDomains();
  const showDomain = !scope && manyDomains;
  const [search, setSearch] = useState('');
  const [deleted, setDeleted] = useState(false);
  const query = useDeferredValue(search.trim().toLowerCase());

  const live = useMemo(() => (data?.items ?? []).filter((item) => !isDeletedPhase(item)), [data?.items]);
  const gone = useMemo(() => (data?.items ?? []).filter((item) => isDeletedPhase(item)), [data?.items]);
  const groups = useMemo(() => {
    const found = live.filter((item) => matches(item, query)).sort((left, right) => displayName(left).localeCompare(displayName(right)));
    return GROUPS.map(({ group, title }) => ({ group, title, items: found.filter((item) => statusGroup(itemStatus(item)) === group) })).filter((entry) => entry.items.length > 0);
  }, [live, query]);
  const shown = groups.reduce((sum, entry) => sum + entry.items.length, 0);

  return (
    <>
      <PageHeader title="Materializations" actions={<NewMaterialization materializations={data?.items} />}>
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3 px-4 pb-4 sm:px-6">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--color-ink-faint)]" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Find by name, topic, dataset or table"
              aria-label="Find a materialization"
              className="h-9 pl-9"
              spellCheck={false}
            />
          </div>
          {gone.length > 0 ? (
            <button type="button" onClick={() => setDeleted((value) => !value)} className="link text-[13px]">
              {deleted ? 'Back to the list' : `Recently deleted · ${gone.length}`}
            </button>
          ) : null}
        </div>
      </PageHeader>

      <PageBody className="space-y-6">
        {data ? <HiddenDomains hidden={data.hidden} what="materializations" /> : null}
        {!data ? (
          <Panel className="space-y-px p-5">
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} className="h-12" />
            ))}
          </Panel>
        ) : deleted ? (
          <DeletedList items={gone.filter((item) => matches(item, query))} showDomain={showDomain} />
        ) : live.length === 0 ? (
          <Panel>
            <EmptyState
              title="No materializations yet"
              description="A materialization reads Kafka topics and keeps each in an Iceberg table, live."
              action={<NewMaterialization materializations={data.items} />}
            />
          </Panel>
        ) : shown === 0 ? (
          <Panel>
            <EmptyState title="Nothing matches" description="Try a name, a topic, a dataset or a table." action={<Button onClick={() => setSearch('')}>Clear</Button>} />
          </Panel>
        ) : (
          <div className="space-y-6" onKeyDown={onListKeyDown}>
            {groups.map((entry) => (
              <section key={entry.group} aria-label={entry.title}>
                <h2 className="px-1 pb-2 text-[13px] font-semibold">
                  {entry.title} <span className="numeric font-normal text-[var(--color-ink-faint)]">{formatCount(entry.items.length)}</span>
                </h2>
                <Panel className="divide-y divide-[var(--color-line)] overflow-hidden">
                  {entry.items.map((item) => (
                    <MaterializationRow key={`${item.domain}/${item.materialization_id}`} item={item} showDomain={showDomain} wide />
                  ))}
                </Panel>
              </section>
            ))}
            <p className="px-1 text-[12px] text-[var(--color-ink-faint)] max-md:hidden">↑↓ or j k to move · ↵ to open</p>
          </div>
        )}
      </PageBody>
    </>
  );
}

/** Deleted materializations, kept a while after they go. */
function DeletedList({ items, showDomain }: { items: DomainMaterialization[]; showDomain: boolean }): ReactNode {
  if (items.length === 0) {
    return (
      <Panel>
        <EmptyState title="Nothing deleted lately" description="Deleted materializations stay listed here for a while after they go." />
      </Panel>
    );
  }
  return (
    <Panel className="divide-y divide-[var(--color-line)] overflow-hidden">
      {items.map((item) => (
        <Link
          key={`${item.domain}/${item.materialization_id}`}
          to={domainPath(item.domain, `/materializations/${encodeURIComponent(item.materialization_id)}`)}
          className="flex min-h-14 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-[var(--color-raised)] sm:px-5"
        >
          <StatusGlyph status={itemStatus(item)} size={14} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-medium">{displayName(item)}</p>
            <p className="truncate text-[12px] text-[var(--color-ink-muted)]">
              Deleted <RelativeTime value={item.updated_at} />
              {showDomain ? ` · ${item.domainName}` : ''}
            </p>
          </div>
        </Link>
      ))}
    </Panel>
  );
}
