import { Lock, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { RelativeTime } from '@/components/Inline';
import { StatusLabel } from '@/components/Status';
import { Badge, Panel } from '@/components/ui/primitives';
import { useAuth } from '@/lib/auth';
import { formatBytes, formatCount, formatExact, humanize } from '@/lib/format';
import { plainStatus } from '@/lib/status';
import type { CpDetail, CpLiveTable, CpTableSpec, CpTableSummary, TableState } from '@shared/types';
import { useDomainPath } from '@/lib/domains';
import { tablePath } from '@/lib/paths';

/** A row of the panel: a table, its record once created, and its place in the materialization. */
interface TableRow {
  spec: CpTableSpec;
  record: CpTableSummary | null;
  state: TableState;
}

/** The written tables in the order of their topics, the kept ones, then any being dropped or dropped. */
function tableRows(detail: CpDetail): TableRow[] {
  const records = new Map(detail.tables.map((record) => [record.name, record]));
  const leaving = detail.tables.filter((record) => record.state === 'dropping' || record.state === 'dropped');
  return [
    ...detail.materialization.tables.map((spec) => ({ spec, record: records.get(spec.name) ?? null, state: 'active' as const })),
    ...(detail.materialization.retired_tables ?? []).map((spec) => ({ spec, record: records.get(spec.name) ?? null, state: 'retired' as const })),
    ...leaving.map((record) => ({
      spec: { name: record.name, source_topic: record.source_topic, dataset: record.dataset, dataset_id: record.dataset_id },
      record,
      state: record.state as TableState,
    })),
  ];
}

/**
 * Every table of the materialization: one per source topic, each in its dataset, with what it holds,
 * how far its topic is behind, and anything wrong with it; then the tables kept read-only after their
 * topics were removed, and any being dropped.
 *
 * Totals come from the control plane's table records, which every commit updates; lag from its
 * last measurement of each topic. A table's name opens its page — on its rows, for someone who may
 * query its dataset; its dataset, the dataset's page. A lock marks a table whose dataset the person
 * may not read.
 */
export function TablesPanel({ detail }: { detail: CpDetail }): ReactNode {
  const domainPath = useDomainPath();
  const { can } = useAuth();
  const canSeeDatasets = can('datasets.view');
  const rows = tableRows(detail);
  const kept = detail.materialization.retired_tables?.length ?? 0;
  const live = detail.status.runtime_progress?.tables ?? {};
  const lag = detail.status.consumer_lag?.topics ?? {};

  return (
    <Panel className="overflow-hidden">
      <header className="px-5 pt-4 pb-3">
        <h2 className="text-[15px] font-semibold">
          Tables <span className="numeric font-normal text-[var(--color-ink-faint)]">{detail.materialization.tables.length}</span>
          {kept ? <span className="text-[13px] font-normal text-[var(--color-ink-muted)]"> · {kept} kept, no longer written</span> : null}
        </h2>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-[12px]">
          <thead>
            <tr className="border-y border-[var(--color-line)] text-left text-[12px] whitespace-nowrap text-[var(--color-ink-faint)]">
              <th className="px-5 py-2 font-normal">Table · topic</th>
              <th className="px-2 py-2 text-right font-normal">Rows</th>
              <th className="px-2 py-2 text-right font-normal">Size</th>
              <th className="px-2 py-2 text-right font-normal">Files</th>
              <th className="px-2 py-2 text-right font-normal" title="Records on the topic the runtime has not yet committed">
                Lag
              </th>
              <th className="px-2 py-2 font-normal">Schema</th>
              <th className="px-2 py-2 font-normal">Last commit</th>
              <th className="px-5 py-2 font-normal">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-line)]">
            {rows.map(({ spec, record, state }) => {
              const written = state === 'active';
              const readable = written || state === 'retired';
              const block = written ? (live[spec.name] ?? null) : null;
              const topicLag = written ? lag[spec.source_topic] : undefined;
              const locked = !can('dataset.view_schema', spec.dataset_id);
              const queryable = can('data.query', spec.dataset_id);
              const qualified = `${spec.dataset}.${spec.name}`;
              return (
                <tr key={spec.name} className={state === 'dropping' || state === 'dropped' ? 'align-top opacity-60' : 'align-top'}>
                  <td className="px-5 py-2">
                    <span className="flex items-center gap-1.5">
                      {canSeeDatasets ? (
                        <Link
                          to={domainPath(`/datasets/${encodeURIComponent(spec.dataset)}`)}
                          className="ident text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] hover:underline"
                          title={`Dataset ${spec.dataset}`}
                        >
                          {spec.dataset}.
                        </Link>
                      ) : (
                        <span className="ident text-[var(--color-ink-muted)]">{spec.dataset}.</span>
                      )}
                      {!readable ? (
                        <span className="ident -ml-1.5 font-medium line-through decoration-[var(--color-ink-faint)]">{spec.name}</span>
                      ) : canSeeDatasets ? (
                        <Link
                          to={domainPath(tablePath(spec.dataset, spec.name, queryable ? 'data' : 'history'))}
                          className="ident -ml-1.5 font-medium text-[var(--color-ink)] hover:underline"
                          title={`Open ${qualified}`}
                        >
                          {spec.name}
                        </Link>
                      ) : (
                        <span className="ident -ml-1.5 font-medium">{spec.name}</span>
                      )}
                      {locked ? (
                        <span title={`Dataset ${spec.dataset} is locked to you: its schemas and data need a role on it`}>
                          <Lock className="size-3 text-[var(--color-ink-faint)]" aria-label="locked" />
                        </span>
                      ) : null}
                    </span>
                    <span className="numeric block break-all text-[11px] text-[var(--color-ink-muted)]">{spec.source_topic}</span>
                  </td>
                  <td className="numeric px-2 py-2 text-right whitespace-nowrap">{record ? formatExact(record.totals.records ?? 0) : '—'}</td>
                  <td className="numeric px-2 py-2 text-right whitespace-nowrap">{record ? formatBytes(record.totals.bytes ?? 0) : '—'}</td>
                  <td className="numeric px-2 py-2 text-right whitespace-nowrap text-[var(--color-ink-muted)]">{record ? formatExact(record.totals.files ?? 0) : '—'}</td>
                  <td className="numeric px-2 py-2 text-right whitespace-nowrap" title={topicLag?.error ?? (written ? undefined : 'Not read any more')}>
                    {topicLag?.error ? <span className="text-[var(--color-buoy-ink)]">?</span> : written ? formatCount(topicLag?.total_lag ?? null) : '—'}
                  </td>
                  <td className="numeric px-2 py-2 whitespace-nowrap text-[var(--color-ink-muted)]">{record?.schema_id != null ? `schema ${record.schema_id}` : '—'}</td>
                  <td className="px-2 py-2 whitespace-nowrap text-[var(--color-ink-muted)]">
                    <RelativeTime value={record?.last_commit_at ?? block?.last_commit_at ?? null} />
                  </td>
                  <td className="px-5 py-2">
                    <TableStatus record={record} block={block} state={state} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function TableStatus({ record, block, state }: { record: CpTableSummary | null; block: CpLiveTable | null; state: TableState }): ReactNode {
  if (state === 'dropping' && !record?.last_error) {
    return (
      <span title="Its files and records are being deleted. It left its dataset, and freed its name there, when its drop was asked for." className="inline-flex">
        <StatusLabel status={plainStatus('starting', 'Dropping')} className="text-[12px]" />
      </span>
    );
  }
  if (state === 'dropped') {
    return (
      <Badge title={`Dropped with object deletion off: its files stay at ${record?.location ?? 'its location'}, so this materialization does not use its name again; its dataset may.`}>
        dropped · files kept
      </Badge>
    );
  }
  if (state === 'retired' && !record?.last_error) {
    return (
      <Badge title="Its topic was removed: the table is no longer written, and stays readable. Adding the topic back writes it again.">
        kept · read-only
      </Badge>
    );
  }
  if (!record) {
    return (
      <span title="The control plane creates each table after it has sampled its topic." className="inline-flex">
        <StatusLabel status={plainStatus('starting', 'Not created yet')} className="text-[12px]" />
      </span>
    );
  }
  if (record.last_error) {
    return (
      <span className="flex min-w-0 items-start gap-1.5 text-[var(--color-flare-ink)]" title={record.last_error.message}>
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span className="line-clamp-2">{record.last_error.message}</span>
      </span>
    );
  }
  const running = record.maintenance_job ?? block?.maintenance ?? null;
  if (running) {
    return (
      <span title={running.partition ? `${running.job.replace(/_/g, ' ')} · ${running.partition}` : undefined} className="inline-flex">
        <StatusLabel
          status={plainStatus('starting', running.job === 'compaction' ? 'Compacting' : running.job === 'reprotect' ? 'Masking rows' : humanize(running.job))}
          className="text-[12px]"
        />
      </span>
    );
  }
  if ((block?.pending_files ?? 0) > 0) {
    return (
      <span className="text-[var(--color-ink-muted)]">
        {formatExact(block?.pending_files ?? 0)} {block?.pending_files === 1 ? 'file' : 'files'} awaiting commit
      </span>
    );
  }
  return <span className="text-[var(--color-ink-muted)]">Written</span>;
}
