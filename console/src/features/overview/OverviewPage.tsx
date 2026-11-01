import { ArrowRight } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { River, type Strand } from './River';
import { HiddenDomains } from '../domains/HiddenDomains';
import { NewMaterialization } from '../domains/NewMaterialization';
import { MaterializationRow } from '../materializations/MaterializationRow';
import { PageBody, PageHeader } from '@/components/AppShell';
import { Mark } from '@/components/Logo';
import { Readout, formatReadoutRate } from '@/components/Readout';
import { StatusGlyph, StatusPill } from '@/components/Status';
import { Panel, Skeleton } from '@/components/ui/primitives';
import { displayName, formatCount } from '@/lib/format';
import { domainPath, useManyDomains, useOptionalDomain } from '@/lib/domains';
import { useFleet, type DomainMaterialization } from '@/lib/fleet';
import { itemStatus, statusGroup, type Status, type StatusGroup } from '@/lib/status';
import { isDeletedPhase, type DomainFleet } from '@shared/types';

/** Rows the Overview lists before "See all". */
const LISTED = 8;
const GROUP_ORDER: StatusGroup[] = ['needs-you', 'in-progress', 'flowing', 'stopped'];

interface Entry {
  item: DomainMaterialization;
  status: Status;
}

/**
 * Is everything flowing? (docs/10-design-system.md §10.5) The fleet's rows a second lead, with what
 * needs someone and what's on track; the river shows each materialization's share; what needs you
 * says so once, with the way in; then the materializations, the ones that need you first.
 */
export function OverviewPage(): ReactNode {
  const scope = useOptionalDomain();
  const { data } = useFleet(scope?.id ?? null);
  const manyDomains = useManyDomains();
  const showDomain = !scope && manyDomains;

  // Deleted materializations stay in the fleet for a while; nothing here is about them.
  const entries = useMemo<Entry[]>(
    () =>
      (data?.items ?? [])
        .filter((item) => !isDeletedPhase(item))
        .map((item) => ({ item, status: itemStatus(item) }))
        .sort((left, right) => GROUP_ORDER.indexOf(statusGroup(left.status)) - GROUP_ORDER.indexOf(statusGroup(right.status))),
    [data?.items],
  );
  const needing = entries.filter((entry) => statusGroup(entry.status) === 'needs-you');
  const tables = entries.reduce((sum, entry) => sum + entry.item.tables.length, 0);
  const topics = new Set(entries.flatMap((entry) => entry.item.source_topics.map((topic) => `${entry.item.domain}/${topic}`))).size;
  const rows = data?.totals.rowsCommitted ?? 0;
  const strands = useMemo<Strand[]>(
    () =>
      entries.map(({ item, status }) => ({
        key: `${item.domain}/${item.materialization_id}`,
        label: displayName(item),
        status,
        rate: item.rowsPerSecond,
        to: domainPath(item.domain, `/materializations/${encodeURIComponent(item.materialization_id)}`),
      })),
    [entries],
  );

  return (
    <>
      <PageHeader title={scope ? scope.name : 'Overview'} actions={<NewMaterialization materializations={data?.items} />} />

      <PageBody className="space-y-6">
        {!data ? (
          <>
            <Skeleton className="h-[360px]" />
            <Skeleton className="h-48" />
          </>
        ) : (
          <>
            <HiddenDomains hidden={data.hidden} what="materializations" />
            {entries.length === 0 ? (
              <EmptyFleet items={data.items} />
            ) : (
              <>
                <Panel className="px-5 pt-5 pb-4 sm:px-7 sm:pt-6">
                  <Readout
                    pills={
                      <>
                        {needing.length > 0 ? (
                          <StatusPill status={{ kind: needing.some((entry) => entry.status.kind === 'failed') ? 'failed' : 'attention', label: `${needing.length} need${needing.length === 1 ? 's' : ''} you`, reason: null, moving: false }} />
                        ) : null}
                        {entries.length > needing.length ? (
                          <StatusPill
                            status={{
                              kind: 'flowing',
                              label: needing.length === 0 ? (entries.length === 1 ? 'On track' : `All ${entries.length} on track`) : `${entries.length - needing.length} on track`,
                              reason: null,
                              moving: true,
                            }}
                            animate={false}
                          />
                        ) : null}
                      </>
                    }
                    value={data.totals.rowsPerSecond}
                    format={formatReadoutRate}
                    unit="rows a second"
                    context={
                      <>
                        into {formatCount(tables)} {tables === 1 ? 'table' : 'tables'} · {formatCount(rows)} rows committed
                      </>
                    }
                  >
                    <River
                      strands={strands}
                      rows={data.totals.rowsCommitted}
                      kafka={
                        <>
                          <b className="font-semibold text-[var(--color-ink)]">Kafka</b> · {formatCount(topics)} {topics === 1 ? 'topic' : 'topics'}
                        </>
                      }
                      midstream={
                        <>
                          <b className="font-semibold text-[var(--color-ink)]">Midstream</b> · {formatCount(entries.length)}
                        </>
                      }
                      lake={
                        <>
                          <b className="font-semibold text-[var(--color-ink)]">Lake</b> · {formatCount(rows)} rows
                        </>
                      }
                    />
                  </Readout>
                </Panel>

                {needing.length > 0 ? <NeedsYou entries={needing} showDomain={showDomain} /> : null}

                <Panel className="overflow-hidden">
                  <header className="flex items-center justify-between gap-4 px-4 pt-4 pb-2 sm:px-5">
                    <h2 className="text-[15px] font-semibold">
                      Materializations <span className="numeric font-normal text-[var(--color-ink-faint)]">{formatCount(entries.length)}</span>
                    </h2>
                    {entries.length > LISTED ? (
                      <Link to={scope ? domainPath(scope.id, '/materializations') : '/materializations'} className="link text-[13px]">
                        See all
                      </Link>
                    ) : null}
                  </header>
                  <div className="divide-y divide-[var(--color-line)] pb-1">
                    {entries.slice(0, LISTED).map(({ item }) => (
                      <MaterializationRow key={`${item.domain}/${item.materialization_id}`} item={item} showDomain={showDomain} />
                    ))}
                  </div>
                </Panel>

                {showDomain && data.domains.length > 1 ? <DomainsPanel domains={data.domains} /> : null}
              </>
            )}
          </>
        )}
      </PageBody>
    </>
  );
}

/** What needs someone, said once each, with the way in. Gone on a good day. */
function NeedsYou({ entries, showDomain }: { entries: Entry[]; showDomain: boolean }): ReactNode {
  return (
    <section aria-label="Needs you" className="space-y-2">
      {entries.slice(0, 4).map(({ item, status }) => (
        <Link
          key={`${item.domain}/${item.materialization_id}`}
          to={domainPath(item.domain, `/materializations/${encodeURIComponent(item.materialization_id)}`)}
          className="flex items-center gap-3 rounded-[var(--radius-panel)] px-4 py-3 transition-opacity hover:opacity-90 sm:px-5"
          style={{ background: status.kind === 'failed' ? 'var(--color-flare-wash)' : 'var(--color-buoy-wash)' }}
        >
          <StatusGlyph status={status} size={14} />
          <p className="min-w-0 flex-1 text-[14px]">
            <span className="font-semibold">{displayName(item)}</span>
            {showDomain ? <span className="text-[var(--color-ink-muted)]"> in {item.domainName}</span> : null}
            <span className="text-[var(--color-ink-muted)]">
              {' '}
              · {status.label}
              {status.reason ? `: ${status.reason}` : ''}
            </span>
          </p>
          <span className="flex shrink-0 items-center gap-1 text-[13px] font-medium">
            Open <ArrowRight className="size-3.5" />
          </span>
        </Link>
      ))}
    </section>
  );
}

/** Nothing to show yet: what a materialization is, once, and the way to make the first. */
function EmptyFleet({ items }: { items: DomainMaterialization[] }): ReactNode {
  return (
    <Panel className="flex flex-col items-center px-6 py-16 text-center">
      <Mark size={44} working className="text-[var(--color-current)]" />
      <h2 className="display mt-5 text-[22px] font-semibold">Nothing is flowing yet</h2>
      <p className="mt-2 max-w-md text-[14px] leading-relaxed text-[var(--color-ink-muted)]">
        A materialization reads Kafka topics and keeps each in an Iceberg table. Its rows show here within seconds, and in
        every engine after each commit.
      </p>
      <div className="mt-6">
        <NewMaterialization materializations={items} />
      </div>
    </Panel>
  );
}

/** Each domain's fleet, one row each: what the overview of every domain adds. */
function DomainsPanel({ domains }: { domains: readonly DomainFleet[] }): ReactNode {
  return (
    <Panel className="overflow-hidden">
      <header className="px-4 pt-4 pb-2 sm:px-5">
        <h2 className="text-[15px] font-semibold">Domains</h2>
      </header>
      <div className="divide-y divide-[var(--color-line)]">
        {domains.map((entry) => {
          const totals = entry.snapshot!.totals;
          return (
            <Link
              key={entry.domain}
              to={domainPath(entry.domain)}
              className="grid grid-cols-[minmax(0,1.6fr)_repeat(3,minmax(0,1fr))] items-center gap-4 px-4 py-3 transition-colors hover:bg-[var(--color-raised)] sm:px-5"
            >
              <div className="min-w-0">
                <p className="truncate text-[14px] font-medium">{entry.name}</p>
                <p className="ident truncate text-[12px] text-[var(--color-ink-muted)]">{entry.domain}</p>
              </div>
              <span className="text-right text-[13px]">
                {formatCount(totals.materializations)} <span className="text-[var(--color-ink-muted)]">{totals.materializations === 1 ? 'materialization' : 'materializations'}</span>
              </span>
              <span className="numeric text-right text-[13px]">{totals.rowsPerSecond === null ? '—' : `${formatReadoutRate(totals.rowsPerSecond)}/s`}</span>
              <span className="numeric text-right text-[13px] text-[var(--color-ink-muted)]">{formatCount(totals.rowsCommitted)} rows</span>
            </Link>
          );
        })}
      </div>
    </Panel>
  );
}
