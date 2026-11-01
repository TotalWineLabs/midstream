import { useQueries } from '@tanstack/react-query';
import { ArrowRight, Play } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { materializationLocation, newestCommit, partitionLabel, RuntimeVersion } from './OverviewTab';
import { TablesPanel } from './TablesPanel';
import { canResume, useLifecycleActions } from '../materializations/actions';
import { ProtectionChips, ProtectionStateBadge } from '../protection/ProtectionSummary';
import { PageBody } from '@/components/AppShell';
import { Identifier, RelativeTime } from '@/components/Inline';
import { Ticker } from '@/components/motion/Ticker';
import { Shimmer } from '@/components/motion/Shimmer';
import { Readout, formatReadoutRate } from '@/components/Readout';
import { StatusLabel, StatusPill } from '@/components/Status';
import { TimeSeriesChart, type ChartPoint } from '@/components/TimeSeriesChart';
import { Button, EmptyState, Panel, SegmentedControl } from '@/components/ui/primitives';
import { useAuth } from '@/lib/auth';
import { useMaterializationDefaults } from '@/lib/defaults';
import { useApi, useDomainPath } from '@/lib/domains';
import { displayName, formatBytes, formatCount, formatExact, formatTimestamp } from '@/lib/format';
import { statusOf, type Status } from '@/lib/status';
import { withFieldNames } from '@shared/fieldPaths';
import { backlogProgress, formatEta, lagTrend, type LagTrend } from '@shared/lagTrend';
import { readableTables, type CpDetail, type DataSummary, type DetailSnapshot } from '@shared/types';

/** What every table of a materialization holds together, from their snapshots' manifests. */
interface StorageSummary {
  tables: number;
  rows: number;
  bytes: number;
  objects: number;
  /** The earliest of the tables' `validThrough`: complete through it on every table; null when any is unknown. */
  validThrough: string | null;
  newestCommit: string | null;
}

function combineSummaries(summaries: DataSummary[]): StorageSummary | null {
  const available = summaries.filter((summary) => summary.available);
  if (available.length === 0) return null;
  const instant = (value: string | null): number => (value ? Date.parse(value) : Number.NaN);
  const through = summaries.map((summary) => summary.validThrough);
  const commits = available.map((summary) => summary.newestCommit).filter((value): value is string => value !== null);
  return {
    tables: summaries.length,
    rows: available.reduce((sum, summary) => sum + summary.rows, 0),
    bytes: available.reduce((sum, summary) => sum + summary.bytes, 0),
    objects: available.reduce((sum, summary) => sum + summary.objects, 0),
    validThrough: through.some((value) => value === null)
      ? null
      : through.reduce<string | null>((first, value) => (first === null || instant(value) < instant(first) ? value : first), null),
    newestCommit: commits.reduce<string | null>((last, value) => (last === null || instant(value) > instant(last) ? value : last), null),
  };
}

/** A clock time to read at a glance: `4:30 PM`, with the day when it is not today. */
function clockTime(epochMs: number, now: number): string {
  const at = new Date(epochMs);
  const sameDay = at.toDateString() === new Date(now).toDateString();
  return at.toLocaleString(undefined, sameDay ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

type LagWindow = '15m' | '1h' | '6h';
const LAG_WINDOWS: Record<LagWindow, number> = { '15m': 15 * 60_000, '1h': 60 * 60_000, '6h': 6 * 60 * 60_000 };

/**
 * Is it healthy, and what does it write? (docs/10-design-system.md §10.5) The number for its state
 * leads, with one line of context and its chart; four facts follow, then its tables. Everything
 * else is in the properties beside them, or in Diagnostics.
 */
export function DetailOverviewTab({ snapshot }: { snapshot: DetailSnapshot }): ReactNode {
  const api = useApi();
  const detail = snapshot.detail;
  const materialization = detail?.materialization;
  const tableNames = useMemo(() => (materialization ? readableTables(materialization) : []).map((table) => table.name), [materialization]);
  // What is in the tables, from their current snapshots: the counts queries over all time see.
  const summaryQueries = useQueries({
    queries: tableNames.map((table) => ({
      queryKey: ['data-summary', snapshot.materializationId, table],
      queryFn: () => api.dataSummary(snapshot.materializationId, table),
      refetchInterval: 15_000,
      retry: 0,
    })),
  });
  const summaries = summaryQueries.map((query) => query.data).filter((value): value is DataSummary => value !== undefined);
  const summary = summaries.length === tableNames.length ? combineSummaries(summaries) : null;
  const now = Date.parse(snapshot.generatedAt) || Date.now();
  const trend = useMemo(() => lagTrend(snapshot.lagHistory, { now }), [snapshot.lagHistory, now]);

  if (!detail) {
    return (
      <PageBody>
        <EmptyState title="Not found" description="This materialization is no longer in the control plane." />
      </PageBody>
    );
  }

  const status = statusOf({
    desired: detail.status.desired_phase,
    observed: detail.status.observed_phase,
    reason: detail.status.phase_reason,
    message: detail.status.phase_message ? withFieldNames(detail.status.phase_message) : null,
    health: detail.status.runtime_health.level,
    healthReason: detail.status.runtime_health.reason,
    catchingUp: trend.state === 'draining',
    everRan: detail.status.last_heartbeat != null || detail.status.runtime_progress !== undefined,
  });

  return (
    <PageBody>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6">
          <Panel className="px-5 pt-5 pb-4 sm:px-7 sm:pt-6">
            <StateReadout snapshot={snapshot} detail={detail} status={status} trend={trend} summary={summary} now={now} />
          </Panel>
          <Facts snapshot={snapshot} detail={detail} trend={trend} summary={summary} />
          <TablesPanel detail={detail} />
        </div>
        <Properties detail={detail} status={status} snapshot={snapshot} />
      </div>
    </PageBody>
  );
}

/** The number that matters for its state, set large, with one line of context and its chart. */
function StateReadout({
  snapshot,
  detail,
  status,
  trend,
  summary,
  now,
}: {
  snapshot: DetailSnapshot;
  detail: CpDetail;
  status: Status;
  trend: LagTrend;
  summary: StorageSummary | null;
  now: number;
}): ReactNode {
  const [lagWindow, setLagWindow] = useState<LagWindow>('1h');
  const { can } = useAuth();
  const { run, pending } = useLifecycleActions();
  const domainPath = useDomainPath();
  const lag = detail.status.consumer_lag?.total_lag ?? null;
  const rowSeries = useMemo<ChartPoint[]>(() => snapshot.series.map((point) => ({ t: point.t, value: point.rowsPerSecond })), [snapshot.series]);
  const lagSeries = useMemo<ChartPoint[]>(() => snapshot.lagHistory.map((point) => ({ t: point.t, value: point.lag })), [snapshot.lagHistory]);
  const committed = summary?.rows ?? null;
  const progress = status.kind === 'catching-up' ? backlogProgress(snapshot.lagHistory, committed, lag) : null;
  const pill = <StatusPill status={status} progress={progress} />;

  if (status.kind === 'catching-up') {
    const pieces = [
      trend.etaMs !== null ? `Caught up around ${clockTime(now + trend.etaMs, now)}` : null,
      progress !== null ? `${Math.round(progress * 100)}% there` : null,
      trend.perSecond !== null ? `falling ${formatCount(Math.round(-trend.perSecond))} a second` : null,
    ].filter(Boolean);
    return (
      <Readout pills={pill} value={lag} format={formatCount} unit="records behind" context={pieces.join(' · ')}>
        <div className="flex justify-end pb-1">
          <SegmentedControl value={lagWindow} onChange={setLagWindow} options={(Object.keys(LAG_WINDOWS) as LagWindow[]).map((value) => ({ value, label: value }))} />
        </div>
        <TimeSeriesChart
          points={lagSeries}
          from={now - LAG_WINDOWS[lagWindow]}
          to={Math.max(now, snapshot.lagHistory.at(-1)?.t ?? now)}
          height={200}
          baseline="auto"
          formatValue={(value) => `${formatExact(value)} records behind`}
          formatTick={formatCount}
          label="Records behind"
          empty="The trend appears with the next measurement."
        />
      </Readout>
    );
  }

  if (status.kind === 'flowing') {
    return (
      <Readout
        pills={pill}
        value={snapshot.rowsPerSecond}
        format={formatReadoutRate}
        unit="rows a second"
        context={
          summary?.validThrough ? (
            <>Complete through {formatTimestamp(summary.validThrough)} · every record before it is in the tables</>
          ) : summary?.newestCommit ? (
            <>
              Last commit <RelativeTime value={summary.newestCommit} />
            </>
          ) : (
            <>
              Last commit <RelativeTime value={newestCommit(detail)} />
            </>
          )
        }
      >
        <TimeSeriesChart
          points={rowSeries}
          from={Math.max(snapshot.series[0]?.t ?? now, now - 30 * 60_000)}
          to={now}
          height={180}
          formatValue={(value) => `${formatReadoutRate(value)} rows a second`}
          formatTick={formatCount}
          label="Rows a second"
          empty="Rates appear once every worker has reported twice."
        />
      </Readout>
    );
  }

  // Stopped, starting, or something wrong: the words lead, saying more than the pill above them,
  // and the way on sits beside them.
  const headline: ReactNode =
    status.kind === 'stopped'
      ? status.label === 'Deleting'
        ? 'Removing its runtime and tables'
        : status.moving
          ? 'Shutting down its workers'
          : (
              <>
                Stopped <RelativeTime value={detail.status.last_transition_time} />
              </>
            )
      : (status.reason ?? status.label);
  const context =
    status.kind === 'stopped'
      ? status.label === 'Deleting'
        ? null
        : status.moving
          ? 'Nothing is lost: Resume picks up where it left off.'
          : 'Its tables stay readable, and Resume picks up where it left off.'
      : status.kind === 'starting'
        ? null
        : detail.status.phase_message && withFieldNames(detail.status.phase_message) !== headline
          ? withFieldNames(detail.status.phase_message)
          : null;

  return (
    <section>
      <div className="flex flex-wrap items-center gap-2">{pill}</div>
      <p className="display mt-4 text-[28px] leading-tight font-semibold sm:text-[34px]">
        {status.moving ? <Shimmer>{headline}</Shimmer> : headline}
      </p>
      {context ? <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-[var(--color-ink-muted)]">{context}</p> : null}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        {status.kind === 'stopped' && !status.moving && canResume(detail) && can('materializations.resume') ? (
          <Button variant="primary" loading={pending === 'resume'} onClick={() => run('resume', detail.materialization.materialization_id, undefined, displayName(detail.materialization))}>
            <Play className="size-4" />
            Resume
          </Button>
        ) : null}
        {status.kind === 'attention' || status.kind === 'failed' ? (
          <Link to={domainPath(`/materializations/${encodeURIComponent(detail.materialization.materialization_id)}/runtime`)} className="inline-flex items-center gap-1 text-[13px] font-medium">
            Open Diagnostics <ArrowRight className="size-3.5" />
          </Link>
        ) : null}
      </div>
    </section>
  );
}

/** Four facts, then its tables. Nothing else. */
function Facts({ snapshot, detail, trend, summary }: { snapshot: DetailSnapshot; detail: CpDetail; trend: LagTrend; summary: StorageSummary | null }): ReactNode {
  const progress = detail.status.runtime_progress;
  const rows = summary?.rows ?? progress?.cumulative_rows_written ?? progress?.rows_written ?? null;
  const bytes = summary?.bytes ?? progress?.cumulative_bytes_written ?? progress?.bytes_written ?? null;
  const lag = detail.status.consumer_lag?.total_lag ?? null;
  const members = Object.keys(snapshot.memberRates).length;
  const stopped = detail.status.desired_phase === 'stopped';
  const workers = stopped ? 0 : members || (detail.autoscale?.replicas ?? detail.materialization.replicas ?? 1);
  const caughtUp = lag === 0 || trend.state === 'caught-up';

  return (
    <Panel className="grid grid-cols-2 divide-[var(--color-line)] sm:grid-cols-4 sm:divide-x">
      <Fact label="Rows committed" sub={summary ? (summary.tables > 1 ? `in ${summary.tables} tables` : 'in its table') : 'from its workers’ counts'}>
        <Ticker value={rows} format={formatCount} />
      </Fact>
      <Fact label="Size" sub={summary ? `${formatExact(summary.objects)} ${summary.objects === 1 ? 'file' : 'files'}` : null}>
        {formatBytes(bytes)}
      </Fact>
      <Fact
        label="Behind"
        sub={
          caughtUp
            ? null
            : trend.state === 'draining' && trend.etaMs !== null
              ? `${formatEta(trend.etaMs)} to go`
              : trend.state === 'growing'
                ? 'and growing'
                : null
        }
      >
        {caughtUp ? <span className="text-[var(--color-current-ink)]">Caught up</span> : <Ticker value={lag} format={formatCount} />}
      </Fact>
      <Fact
        label="Workers"
        sub={stopped ? 'none while stopped' : detail.autoscale?.replicas ? `scaled up from ${detail.autoscale.own_replicas}` : null}
      >
        <Ticker value={workers} format={formatCount} />
      </Fact>
    </Panel>
  );
}

function Fact({ label, sub, children }: { label: string; sub?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="min-w-0 px-5 py-4 max-sm:odd:border-r max-sm:[&:nth-child(-n+2)]:border-b">
      <p className="text-[12px] text-[var(--color-ink-faint)]">{label}</p>
      <p className="numeric mt-1 truncate text-[20px] leading-tight font-semibold">{children}</p>
      {sub ? <p className="mt-0.5 truncate text-[12px] text-[var(--color-ink-muted)]">{sub}</p> : null}
    </div>
  );
}

/** Its details, like a well-made issue tracker's: what it is, read at a glance, beside what it does. */
function Properties({ detail, status, snapshot }: { detail: CpDetail; status: Status; snapshot: DetailSnapshot }): ReactNode {
  const domainPath = useDomainPath();
  const protectionCatalog = useMaterializationDefaults().defaults?.protection ?? null;
  const materialization = detail.materialization;
  const drifting = detail.status.desired_phase !== detail.status.observed_phase;
  const members = Object.keys(snapshot.memberRates).length;
  return (
    <aside className="min-w-0 self-start lg:sticky lg:top-6">
      <Panel className="p-5">
        <h2 className="text-[13px] font-semibold">Properties</h2>
        <dl className="mt-4 space-y-4 text-[13px]">
          <Property label="Status">
            <StatusLabel status={status} showReason className="whitespace-normal" />
          </Property>
          {drifting ? <Property label="Target">{detail.status.desired_phase === 'stopped' ? 'Stopped' : detail.status.desired_phase === 'running' ? 'Running' : detail.status.desired_phase}</Property> : null}
          <Property label={materialization.source_topics.length === 1 ? 'Reads' : `Reads ${materialization.source_topics.length} topics`}>
            <ul className="space-y-0.5">
              {materialization.source_topics.map((topic) => (
                <li key={topic} className="ident break-all">
                  {topic}
                </li>
              ))}
            </ul>
          </Property>
          <Property label="Writes">
            <span className="ident">{materialization.datasets.join(', ') || '—'}</span>
            <span className="text-[var(--color-ink-muted)]">
              {' '}
              · {materialization.tables.length} {materialization.tables.length === 1 ? 'table' : 'tables'}
              {materialization.retired_tables?.length ? `, ${materialization.retired_tables.length} kept` : ''}
            </span>
          </Property>
          <Property label="Workers">
            {detail.status.desired_phase === 'stopped' ? 'None while stopped' : members || (materialization.replicas ?? 1)}
            {detail.autoscale?.replicas && detail.status.desired_phase !== 'stopped' ? <span className="text-[var(--color-ink-muted)]"> · scaled up from {detail.autoscale.own_replicas}</span> : null}
          </Property>
          <Property label="Partitioned by">{partitionLabel(detail.tables[0]?.partition_granularity ?? materialization.partition_granularity ?? null)}</Property>
          <Property label="Null records">{materialization.skip_tombstones ? 'Ignored' : 'Kept as rows'}</Property>
          {materialization.protection !== undefined ? (
            <Property label="Protection">
              <span className="flex flex-wrap items-center gap-1.5">
                <ProtectionChips policy={materialization.protection} catalog={protectionCatalog} />
                {detail.protection ? <ProtectionStateBadge summary={detail.protection} /> : null}
              </span>
            </Property>
          ) : null}
          <Property label="Created">
            {formatTimestamp(materialization.created_at)}
            {materialization.created_by ? <span className="text-[var(--color-ink-muted)]"> by {materialization.created_by}</span> : null}
          </Property>
          <Property label="Location">
            <span className="ident break-all text-[12px]">{materializationLocation(detail)}</span>
          </Property>
          <Property label="Id">
            <Identifier value={materialization.materialization_id} />
          </Property>
          <Property label="Workers’ version">
            <RuntimeVersion value={detail.status.runtime_version} />
          </Property>
        </dl>
        <Link
          to={domainPath(`/materializations/${encodeURIComponent(materialization.materialization_id)}/runtime`)}
          className="mt-5 flex items-center justify-between rounded-[var(--radius-control)] border border-[var(--color-line)] px-3 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--color-raised)]"
        >
          Diagnostics
          <ArrowRight className="size-3.5 text-[var(--color-ink-faint)]" />
        </Link>
      </Panel>
    </aside>
  );
}

function Property({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-[var(--color-ink-faint)]">{label}</dt>
      <dd className="mt-0.5 min-w-0">{children}</dd>
    </div>
  );
}
