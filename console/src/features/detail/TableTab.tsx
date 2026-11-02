import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Play, TriangleAlert } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { reprotectCounts } from '../protection/protection';
import { PageBody } from '@/components/AppShell';
import { RelativeTime } from '@/components/Inline';
import { StatusLabel } from '@/components/Status';
import { StatCard } from '@/components/StatCard';
import { useToast } from '@/components/ui/Toast';
import { Badge, Button, EmptyState, Panel, PanelHeader, Skeleton } from '@/components/ui/primitives';
import { ApiError } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { formatBytes, formatDuration, formatExact, formatTimestamp, humanize } from '@/lib/format';
import { useApi, useDomainPath } from '@/lib/domains';
import { tablePath } from '@/lib/paths';
import { plainStatus } from '@/lib/status';
import type { CpMaintenanceRun, CpTable, CpTableSpec, DetailSnapshot, MaintenanceJob, TableMetadataView, TableSnapshotRow } from '@shared/types';

/** A table's record and its metadata, read from the control plane and from the table itself. */
export function useTableDetail(materializationId: string, table: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['table', materializationId, table],
    queryFn: () => api.table(materializationId, table),
    refetchInterval: 10_000,
  });
}

/** What a tab says while its table is read, when it cannot be, and before it exists; null once it can show it. */
export function readState(query: ReturnType<typeof useTableDetail>, table: CpTableSpec): ReactNode | null {
  if (query.isPending) {
    return (
      <PageBody className="space-y-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </PageBody>
    );
  }
  if (query.isError || !query.data) {
    return (
      <PageBody>
        <Panel>
          <EmptyState
            icon={<TriangleAlert className="size-6" />}
            title="The table could not be read"
            description={query.error instanceof Error ? query.error.message : 'Try again in a moment.'}
          />
        </Panel>
      </PageBody>
    );
  }
  const { record, metadata, metadataError } = query.data;
  if (!record && !metadata) {
    return (
      <PageBody>
        <Panel>
          <EmptyState
            title="No table yet"
            description={
              metadataError && metadataError !== 'the table has not been created yet'
                ? metadataError
                : `The control plane creates the table right after it discovers the schema of ${table.source_topic}.`
            }
          />
        </Panel>
      </PageBody>
    );
  }
  return null;
}

/**
 * A table's history, on its page: what it holds now, the snapshots its commits and maintenance made,
 * and the maintenance that keeps it fast. Two sources, each enough on its own: the control plane's
 * record, which the runtime's commit and maintenance events keep, and the table itself, which the
 * console reads directly.
 */
export function TableHistoryTab({ snapshot, table }: { snapshot: DetailSnapshot; table: CpTableSpec }): ReactNode {
  const materializationId = snapshot.materializationId;
  const query = useTableDetail(materializationId, table.name);
  const state = readState(query, table);
  if (state || !query.data) return state;
  const { record, metadata, metadataError } = query.data;
  const several = (snapshot.detail?.materialization.tables.length ?? 1) > 1;
  return (
    <PageBody className="space-y-6">
      <TableFigures record={record} metadata={metadata} />
      {metadataError ? (
        <p className="rounded-lg border border-[var(--color-line)] px-4 py-3 text-[12px] text-[var(--color-ink-muted)]">
          Showing the control plane’s record only: {metadataError}.
        </p>
      ) : null}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <SnapshotsPanel table={table} metadata={metadata} />
        <MaintenancePanel materializationId={materializationId} table={table.name} several={several} record={record} />
      </div>
    </PageBody>
  );
}

function TableFigures({ record, metadata }: { record: CpTable | null; metadata: TableMetadataView | null }): ReactNode {
  const records = metadata?.totals.records ?? record?.totals.records ?? null;
  const bytes = metadata?.totals.bytes ?? record?.totals.bytes ?? null;
  const files = metadata?.totals.files ?? record?.totals.files ?? null;
  const small = metadata?.totals.smallFiles ?? record?.live?.small_files ?? null;
  const snapshots = metadata?.snapshotCount ?? record?.snapshots ?? null;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        label="Rows"
        value={formatExact(records)}
        hint={
          record?.valid_through ? (
            <span title="Every record with a Kafka timestamp before this moment is in the table.">
              complete through {formatTimestamp(record.valid_through)}
            </span>
          ) : (
            'in the current snapshot'
          )
        }
      />
      <StatCard
        label="Size"
        value={formatBytes(bytes)}
        hint={files ? `${formatBytes((bytes ?? 0) / files)} per file on average` : 'no data files yet'}
      />
      <StatCard
        label="Data files"
        value={formatExact(files)}
        hint={
          small !== null && files ? (
            <span title="Files below the runtimes’ small-file size, which compaction merges.">
              {formatExact(small)} small ({Math.round((small / files) * 100)}%)
            </span>
          ) : null
        }
      />
      <StatCard
        label="Last commit"
        value={record?.last_commit_at ? <RelativeTime value={record.last_commit_at} /> : '—'}
        hint={`${snapshots === null ? '—' : formatExact(snapshots)} ${snapshots === 1 ? 'snapshot' : 'snapshots'} kept${record?.last_commit_duration_ms ? ` · took ${formatDuration(record.last_commit_duration_ms)}` : ''}`}
      />
    </div>
  );
}

function offsetsText(offsets: Record<string, number> | null): string {
  if (!offsets) return '—';
  const entries = Object.entries(offsets).sort(([a], [b]) => Number(a) - Number(b));
  if (entries.length === 0) return '—';
  const shown = entries.slice(0, 4).map(([partition, offset]) => `p${partition} ${formatExact(offset)}`);
  return entries.length > 4 ? `${shown.join(' · ')} · +${entries.length - 4} more` : shown.join(' · ');
}

function operationLabel(snapshot: TableSnapshotRow): ReactNode {
  if (snapshot.operation === 'append') return <Badge>append</Badge>;
  // Files rewritten to mask what was written in plain text (handbook 22 §22.14).
  if (snapshot.materializerOperation === 'reprotect') return <Badge tone="accent">reprotect</Badge>;
  if (snapshot.operation === 'replace') return <Badge tone="accent">compaction</Badge>;
  return <Badge>{snapshot.operation}</Badge>;
}

function SnapshotsPanel({ table: spec, metadata }: { table: CpTableSpec; metadata: TableMetadataView | null }): ReactNode {
  const domainPath = useDomainPath();
  const navigate = useNavigate();
  // Reading the table as it was is a query, on its dataset.
  const canQuery = useCan('data.query', spec.dataset_id);
  const [showAll, setShowAll] = useState(false);
  const snapshots = metadata?.snapshots ?? [];
  const shown = showAll ? snapshots : snapshots.slice(0, 12);
  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Snapshots"
        description={
          metadata
            ? `${formatExact(metadata.snapshotCount)} kept. Each commit is one; ${canQuery ? 'open one to read the table as it was.' : 'the newest is current.'}`
            : 'Read from the table itself, which this console cannot reach right now.'
        }
      />
      {snapshots.length === 0 ? (
        <EmptyState title="No snapshots yet" description="The first commit creates the first snapshot." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[12px]">
            <thead>
              <tr className="border-b border-[var(--color-line)] bg-[var(--color-raised)] text-left text-[12px] text-[var(--color-ink-muted)]">
                <th className="px-5 py-2 font-medium">Committed</th>
                <th className="px-2 py-2 font-medium">Operation</th>
                <th className="px-2 py-2 text-right font-medium whitespace-nowrap">Added</th>
                <th className="px-2 py-2 text-right font-medium">Files</th>
                <th className="px-2 py-2 text-right font-medium">Rows</th>
                <th className="px-5 py-2 font-medium">Offsets reached</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-line)]">
              {shown.map((item) => {
                // The Data tab reads the latest data only, so only the current snapshot opens it.
                const opens = canQuery && item.current;
                return (
                  <tr
                    key={item.snapshotId}
                    className={cn(opens && 'cursor-pointer hover:bg-[var(--color-raised)]')}
                    title={`Snapshot ${item.snapshotId}${opens ? ' — open it in the Data tab' : ''}`}
                    onClick={opens ? () => navigate(domainPath(tablePath(spec.dataset, spec.name))) : undefined}
                  >
                    <td className="px-5 py-2 whitespace-nowrap">
                      <span className="numeric">{formatTimestamp(item.committedAt)}</span>
                      {item.current ? (
                        <Badge tone="accent" className="ml-2">
                          current
                        </Badge>
                      ) : null}
                    </td>
                    <td className="px-2 py-2">{operationLabel(item)}</td>
                    <td className="numeric px-2 py-2 text-right">
                      {item.operation === 'append' && item.addedRecords !== null ? `+${formatExact(item.addedRecords)}` : '—'}
                    </td>
                    <td className="numeric px-2 py-2 text-right text-[var(--color-ink-muted)]">
                      {item.addedFiles !== null ? `+${formatExact(item.addedFiles)}` : ''}
                      {item.deletedFiles ? ` −${formatExact(item.deletedFiles)}` : ''}
                    </td>
                    <td className="numeric px-2 py-2 text-right">{formatExact(item.totalRecords)}</td>
                    <td className="numeric max-w-[260px] truncate px-5 py-2 text-[var(--color-ink-muted)]">{offsetsText(item.offsets)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {snapshots.length > 12 ? (
            <button
              type="button"
              onClick={() => setShowAll((value) => !value)}
              className="flex w-full items-center justify-center gap-1 border-t border-[var(--color-line)] py-2 text-[12px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
            >
              <ChevronDown className={cn('size-3.5 transition-transform', showAll && 'rotate-180')} />
              {showAll ? 'Show fewer' : `Show all ${snapshots.length}`}
            </button>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

const JOBS: Array<{ job: MaintenanceJob; label: string; description: string }> = [
  {
    job: 'compaction',
    label: 'Compaction',
    description: 'Merges a partition’s small files into large ones, so reads open fewer files.',
  },
  {
    job: 'expire_snapshots',
    label: 'Snapshot expiry',
    description: 'Forgets snapshots past the retention window; the table’s history starts later.',
  },
  {
    job: 'orphan_cleanup',
    label: 'Orphan cleanup',
    description: 'Deletes files no snapshot references, such as those a compaction replaced.',
  },
];

/** Shown once asked for, from the Protection tab, which runs it on every table. */
const REPROTECT = {
  job: 'reprotect' as const,
  label: 'Reprotect',
  description: 'Rewrites the files holding in plain text what the table masks now. Asked from the Protection tab.',
};

function MaintenancePanel({
  materializationId,
  table,
  several,
  record,
}: {
  materializationId: string;
  table: string;
  /** Whether the materialization has other tables, which these jobs leave alone. */
  several: boolean;
  record: CpTable | null;
}): ReactNode {
  const api = useApi();
  const canMaintain = useCan('materializations.maintain');
  const toast = useToast();
  const queryClient = useQueryClient();
  const maintain = useMutation({
    mutationFn: (job: MaintenanceJob) => api.maintain(materializationId, job, table),
    onSuccess: (_accepted, job) => {
      toast.success(
        `${JOBS.find((item) => item.job === job)?.label ?? humanize(job)} of ${table} requested`,
        'The maintenance app runs it next — one job at a time — and reports the outcome here, whether or not the runtime runs.',
      );
      void queryClient.invalidateQueries({ queryKey: ['table', materializationId, table] });
    },
    onError: (error) => toast.error('Maintenance could not be requested', error instanceof ApiError ? error.message : String(error)),
  });

  const latest = useMemo(() => {
    const byJob = new Map<string, CpMaintenanceRun>();
    for (const run of record?.maintenance ?? []) {
      const known = byJob.get(run.job);
      if (!known || Date.parse(run.completed_at) > Date.parse(known.completed_at)) byJob.set(run.job, run);
    }
    return byJob;
  }, [record?.maintenance]);
  // The maintenance app's report; a runtime before 2.0 ran its own and said so on its heartbeat.
  const running = record?.maintenance_job ?? record?.live?.maintenance ?? null;
  const jobs = latest.has('reprotect') || record?.reprotect || running?.job === 'reprotect' ? [...JOBS, REPROTECT] : JOBS;

  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Maintenance"
        description={
          several
            ? 'The maintenance app runs these on every table in turn, one job at a time, whether or not the runtime runs (Settings › Compaction & retention). Run now asks for this table.'
            : 'The maintenance app runs these on its own schedule, whether or not the runtime runs (Settings › Compaction & retention).'
        }
      />
      <ul className="divide-y divide-[var(--color-line)]">
        {jobs.map((item) => {
          const last = latest.get(item.job) ?? null;
          const active = running?.job === item.job;
          const asked = item.job === 'reprotect' && !active ? (record?.reprotect ?? null) : null;
          return (
            <li key={item.job} className="flex items-start gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
                  {item.label}
                  {active ? (
                    <StatusLabel status={plainStatus('starting', `Running${running?.partition ? ` · ${running.partition}` : ''}`)} className="text-[12px]" />
                  ) : asked ? (
                    <span title={`Asked by ${asked.requested_by}`} className="inline-flex">
                      <StatusLabel status={plainStatus('starting', 'Requested')} className="text-[12px]" />
                    </span>
                  ) : last ? (
                    <OutcomeBadge outcome={last.outcome} />
                  ) : null}
                </p>
                <p className="mt-0.5 text-[12px] text-[var(--color-ink-muted)]">{item.description}</p>
                {last ? (
                  <p className="numeric mt-1 text-[12px] text-[var(--color-ink-muted)]">
                    <RelativeTime value={last.completed_at} />
                    {last.partition ? ` · ${last.partition}` : ''}
                    {countsText(last) ? ` · ${countsText(last)}` : ''}
                    {last.duration_ms ? ` · ${formatDuration(last.duration_ms)}` : ''}
                  </p>
                ) : (
                  <p className="mt-1 text-[12px] text-[var(--color-ink-faint)]">Not run yet.</p>
                )}
                {last?.message && last.outcome !== 'succeeded' ? (
                  <p
                    className={cn(
                      'mt-1 text-[12px]',
                      last.outcome === 'skipped' ? 'text-[var(--color-ink-muted)]' : 'text-[var(--color-buoy-ink)]',
                    )}
                  >
                    {last.message}
                  </p>
                ) : null}
              </div>
              {canMaintain && item.job !== 'reprotect' ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={maintain.isPending || active}
                  onClick={() => maintain.mutate(item.job)}
                  title={`Run ${item.label.toLowerCase()} now`}
                >
                  <Play className="size-3.5" />
                  Run now
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/** How a job's last run ended: a failure in Flare with its shape, anything else in plain words. */
function OutcomeBadge({ outcome }: { outcome: string }): ReactNode {
  if (outcome === 'failed') return <StatusLabel status={plainStatus('failed', 'Failed')} className="text-[12px]" />;
  if (outcome === 'succeeded') return <Badge>Succeeded</Badge>;
  if (outcome === 'skipped') return <Badge>Nothing to do</Badge>;
  // Stopped for a drop, or by a maintenance member that went away: it runs again when it is next due.
  return <Badge>{humanize(outcome)}</Badge>;
}

/** The counts a job reports, in words: `12 files → 1`, `40 snapshots expired`, `3 files deleted`. */
function countsText(run: CpMaintenanceRun): string {
  const counts = run.counts ?? {};
  const count = (key: string): number | undefined => (typeof counts[key] === 'number' ? counts[key] : undefined);
  const parts: string[] = [];
  if (run.job === 'compaction') {
    if (count('inputs') !== undefined && count('outputs') !== undefined) {
      parts.push(`${formatExact(count('inputs'))} files → ${formatExact(count('outputs'))}`);
    } else if (count('inputs') !== undefined) parts.push(`${formatExact(count('inputs'))} files`);
    if (count('input_bytes') !== undefined) parts.push(formatBytes(count('input_bytes')));
  } else if (run.job === 'expire_snapshots') {
    if (count('expired') !== undefined) parts.push(`${formatExact(count('expired'))} snapshots expired`);
    if (count('remaining') !== undefined) parts.push(`${formatExact(count('remaining'))} kept`);
  } else if (run.job === 'orphan_cleanup') {
    if (count('deleted') !== undefined) parts.push(`${formatExact(count('deleted'))} files deleted`);
    if (count('listed') !== undefined) parts.push(`${formatExact(count('listed'))} listed`);
  } else if (run.job === 'reprotect') {
    parts.push(...reprotectCounts(run));
  }
  return parts.join(' · ');
}
