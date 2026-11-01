import { useQuery } from '@tanstack/react-query';
import { Lock, Pin } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';

import { namedTable } from './selectedTable';
import { DataTab } from '../data/DataTab';
import { datasetKey } from '../datasets/DatasetPage';
import { TableConnect } from './TableConnect';
import { TableHistoryTab } from '../detail/TableTab';
import { SchemaTab } from '../schema/SchemaTab';
import { PageBody, PageHeader } from '@/components/AppShell';
import { StatusLabel } from '@/components/Status';
import { Button, EmptyState, Panel, Skeleton } from '@/components/ui/primitives';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useApi, useDomain, useDomainPath } from '@/lib/domains';
import { useFleet } from '@/lib/fleet';
import { displayName, formatBytes, formatCount, formatMoment } from '@/lib/format';
import { useDetailStream } from '@/lib/live';
import { TABLE_TABS, tablePath, type TableTab } from '@/lib/paths';
import { isPinned, togglePin, usePins } from '@/lib/pins';
import { itemStatus, statusOf, type Status } from '@/lib/status';
import { readableTables, type CpDatasetDetail, type CpDatasetTable, type CpDetail } from '@shared/types';

/** Each tab, the question it answers, and the dataset permission it needs. */
const TABS: Array<{ key: TableTab; label: string; permission: string | null }> = [
  { key: 'data', label: 'Data', permission: 'data.query' },
  { key: 'schema', label: 'Schema', permission: 'dataset.view_schema' },
  { key: 'history', label: 'History', permission: null },
  { key: 'connect', label: 'Connect', permission: null },
];

/**
 * A table: what is in it (docs/11-feature-reference.md §11.5a). It answers one question — what is in
 * it — in four tabs: its rows, live ones above the waterline and committed ones below (Data); its
 * fields (Schema); its snapshots and maintenance (History); and how another engine reads it (Connect).
 *
 * A table lives in its dataset, which names it; the materialization that writes it feeds every tab.
 */
export function TablePage(): ReactNode {
  const api = useApi();
  const domainPath = useDomainPath();
  const { can } = useAuth();
  const { name: datasetName = '', table: tableName = '', tab } = useParams<{ name: string; table: string; tab?: string }>();
  const dataset = useQuery({ queryKey: datasetKey(datasetName), queryFn: () => api.dataset(datasetName), refetchInterval: 15_000, retry: 0 });
  const wanted = tableName.toLowerCase();
  const entry = dataset.data?.tables.find((table) => table.name.toLowerCase() === wanted && table.state !== 'dropped') ?? null;

  const header = (
    <PageHeader
      crumbs={<Crumbs dataset={datasetName} />}
      title={<TableTitle dataset={datasetName} table={entry?.name ?? tableName} />}
      meta={dataset.isPending ? <Skeleton className="h-5 w-64" /> : null}
    />
  );

  if (dataset.isError || (dataset.data && !entry)) {
    const missingDataset = dataset.error instanceof ApiError && dataset.error.status === 404;
    return (
      <>
        {header}
        <PageBody>
          <Panel>
            <EmptyState
              title={
                missingDataset ? `There is no dataset ${datasetName}` : dataset.isError ? 'The table could not be loaded' : `${datasetName} has no table ${tableName}`
              }
              description={
                dataset.error instanceof ApiError && !missingDataset
                  ? dataset.error.message
                  : missingDataset
                    ? 'It may have been deleted.'
                    : 'It may have been dropped, or never written here.'
              }
              action={
                <Link to={domainPath(missingDataset ? '/datasets' : `/datasets/${encodeURIComponent(datasetName)}`)} className="text-[13px] font-medium hover:underline">
                  {missingDataset ? 'All datasets' : `The tables in ${datasetName}`}
                </Link>
              }
            />
          </Panel>
        </PageBody>
      </>
    );
  }
  if (!dataset.data || !entry) {
    return (
      <>
        {header}
        <PageBody className="space-y-4">
          <Skeleton className="h-10" />
          <Skeleton className="h-[420px]" />
        </PageBody>
      </>
    );
  }
  if (dataset.data.locked || !can('materializations.view_details')) {
    return (
      <>
        {header}
        <PageBody>
          <p className="flex items-start gap-2 rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-raised)] px-4 py-3 text-[13px] text-[var(--color-ink-muted)]">
            <Lock className="mt-0.5 size-3.5 shrink-0" />
            {dataset.data.locked
              ? 'This dataset is locked to you: you see its tables’ names, not their schemas or data. Ask one of its owners for a role on it.'
              : 'Seeing a table needs seeing the materialization that writes it. Ask an admin for a role that does.'}
          </p>
        </PageBody>
      </>
    );
  }
  // An address in any case: the table's own spelling.
  if (entry.name !== tableName) return <Navigate to={domainPath(tablePath(dataset.data.name, entry.name, isTab(tab) ? tab : 'data'))} replace />;
  return <TableView key={`${entry.materialization_id}/${entry.name}`} dataset={dataset.data} entry={entry} tab={tab} />;
}

function isTab(value: string | undefined): value is TableTab {
  return (TABLE_TABS as readonly string[]).includes(value ?? '');
}

function TableView({ dataset, entry, tab }: { dataset: CpDatasetDetail; entry: CpDatasetTable; tab: string | undefined }): ReactNode {
  const domainPath = useDomainPath();
  const navigate = useNavigate();
  const { can } = useAuth();
  const { id: domainId } = useDomain();
  const { data: snapshot } = useDetailStream(entry.materialization_id);
  const { data: fleet } = useFleet(null);
  const detail = snapshot?.detail ?? null;
  const spec = detail ? namedTable(readableTables(detail.materialization), entry.name) : null;
  const record = detail?.tables.find((table) => table.name === entry.name) ?? null;
  const item = fleet?.items.find((candidate) => candidate.domain === domainId && candidate.materialization_id === entry.materialization_id);
  const status = tableStatus(entry, detail, item ? itemStatus(item) : null);
  const tabs = TABS.filter((item) => item.permission === null || can(item.permission, dataset.dataset_id));
  // A tab that is not one, or one the person may not open — from a shared link, say — is the first they may.
  const active = tabs.find((item) => item.key === (tab ?? 'data'))?.key ?? tabs[0]?.key ?? 'history';
  const materializationName = detail ? displayName(detail.materialization) : (entry.materialization_name ?? entry.materialization_id);

  return (
    <>
      <PageHeader
        crumbs={<Crumbs dataset={dataset.name} />}
        title={<TableTitle dataset={dataset.name} table={entry.name} />}
        meta={
          <>
            {status ? <StatusLabel status={status} animate={false} className="text-[13px]" /> : null}
            <Facts
              facts={[
                record?.valid_through ? (
                  <span key="through" title="Every record with a Kafka timestamp before this moment is in the table.">
                    complete through {formatMoment(record.valid_through)}
                  </span>
                ) : null,
                record?.totals.records !== undefined ? <span key="rows">{formatCount(record.totals.records)} rows</span> : null,
                record?.totals.bytes !== undefined ? <span key="bytes">{formatBytes(record.totals.bytes)}</span> : null,
                <span key="from">
                  from{' '}
                  <Link
                    to={domainPath(`/materializations/${encodeURIComponent(entry.materialization_id)}`)}
                    className="font-medium text-[var(--color-ink)] hover:underline"
                  >
                    {materializationName}
                  </Link>
                </span>,
              ]}
            />
          </>
        }
        actions={<PinButton domain={domainId} dataset={dataset.name} table={entry.name} materializationId={entry.materialization_id} />}
      >
        <div className="mx-auto max-w-[1400px] overflow-x-auto px-4 sm:px-6">
          <nav className="-mb-px flex gap-1" role="tablist">
            {tabs.map((item) => {
              const selected = active === item.key;
              return (
                <button
                  key={item.key}
                  role="tab"
                  aria-selected={selected}
                  type="button"
                  onClick={() => navigate(domainPath(tablePath(dataset.name, entry.name, item.key)), { replace: true })}
                  className={cn(
                    'border-b-2 px-3 pb-2.5 text-[13px] font-medium whitespace-nowrap transition-colors',
                    selected
                      ? 'border-[var(--color-ink)] text-[var(--color-ink)]'
                      : 'border-transparent text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
                  )}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>
        </div>
      </PageHeader>

      {!snapshot ? (
        <PageBody className="space-y-4">
          <Skeleton className="h-10" />
          <Skeleton className="h-[420px]" />
        </PageBody>
      ) : !detail || !spec ? (
        <PageBody>
          <Panel>
            <EmptyState
              title={detail ? `${materializationName} no longer writes ${entry.name}` : 'Cannot reach the control plane'}
              description={detail ? 'Its topic was removed from the materialization, and the table was not kept.' : (snapshot.error ?? 'Try again in a moment.')}
            />
          </Panel>
        </PageBody>
      ) : active === 'data' ? (
        <DataTab materializationId={entry.materialization_id} snapshot={snapshot} table={entry.name} />
      ) : active === 'schema' ? (
        <SchemaTab materializationId={entry.materialization_id} snapshot={snapshot} table={entry.name} />
      ) : active === 'connect' ? (
        <TableConnect snapshot={snapshot} table={spec} />
      ) : (
        <TableHistoryTab snapshot={snapshot} table={spec} />
      )}
    </>
  );
}

/**
 * A table's state: its materialization's, while it writes the table; otherwise what became of the
 * table — kept and read-only, being created, or being dropped.
 */
export function tableStatus(entry: CpDatasetTable, detail: CpDetail | null, fleet: Status | null): Status | null {
  if (entry.state === 'retired') return { kind: 'stopped', label: 'Kept', reason: 'No longer written; still readable', moving: false };
  if (entry.state === 'dropping') return { kind: 'stopped', label: 'Being dropped', reason: null, moving: true };
  if (entry.state === 'pending') return { kind: 'starting', label: 'Starting', reason: 'Being created', moving: true };
  if (fleet) return fleet;
  if (!detail) return null;
  return statusOf({
    desired: detail.status.desired_phase,
    observed: detail.status.observed_phase,
    reason: detail.status.phase_reason,
    health: detail.status.runtime_health.level,
    healthReason: detail.status.runtime_health.reason,
    everRan: detail.status.last_heartbeat != null || detail.status.runtime_progress !== undefined,
  });
}

/** `sales.orders`, its dataset quieter: the name SQL reads it by. */
function TableTitle({ dataset, table }: { dataset: string; table: string }): ReactNode {
  return (
    <span>
      <span className="font-medium text-[var(--color-ink-faint)]">{dataset}.</span>
      {table}
    </span>
  );
}

function Crumbs({ dataset }: { dataset: string }): ReactNode {
  const domainPath = useDomainPath();
  return (
    <>
      <Link to={domainPath('/datasets')} className="transition-colors hover:text-[var(--color-ink)]">
        Datasets
      </Link>
      <span className="px-1.5 text-[var(--color-ink-faint)]">/</span>
      <Link to={domainPath(`/datasets/${encodeURIComponent(dataset)}`)} className="transition-colors hover:text-[var(--color-ink)]">
        {dataset}
      </Link>
    </>
  );
}

/** A line of facts, a quiet dot between each. */
function Facts({ facts }: { facts: ReactNode[] }): ReactNode {
  const shown = facts.filter((fact) => fact !== null);
  return (
    <span className="numeric flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-[var(--color-ink-muted)]">
      {shown.map((fact, index) => (
        <span key={index} className="flex items-center gap-2">
          {index > 0 ? <span aria-hidden className="size-[3px] rounded-full bg-[var(--color-ink-faint)]" /> : null}
          {fact}
        </span>
      ))}
    </span>
  );
}

/** Keep the table in the sidebar, to come back to. */
function PinButton({ domain, dataset, table, materializationId }: { domain: string; dataset: string; table: string; materializationId: string }): ReactNode {
  const pins = usePins();
  const target = { kind: 'table' as const, domain, id: `${dataset}.${table}` };
  const pinned = isPinned(pins, target);
  return (
    <Button
      variant="ghost"
      onClick={() => togglePin({ ...target, label: `${dataset}.${table}`, materializationId })}
      aria-pressed={pinned}
      aria-label={pinned ? 'Unpin from the sidebar' : 'Pin to the sidebar'}
      title={pinned ? 'Unpin from the sidebar' : 'Pin to the sidebar'}
      className={cn('px-2.5', pinned && 'text-[var(--color-ink)]')}
    >
      <Pin className={cn('size-4', pinned && 'fill-current')} />
    </Button>
  );
}
