import { useMemo, useRef, useState, type ReactNode } from 'react';

import { axisMarks, binLabel, binPartitions, partitionSpan, type BinLevel, type PartitionBin } from './partitions';
import { EmptyState, Panel, SegmentedControl } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { formatBytes, formatCount, formatExact } from '@/lib/format';
import { useElementSize } from '@/lib/useElementSize';
import type { TableMetadataView, TablePartitionRow } from '@shared/types';

type Measure = 'bytes' | 'files' | 'records';

const MEASURES: Array<{ value: Measure; label: string }> = [
  { value: 'bytes', label: 'Size' },
  { value: 'files', label: 'Files' },
  { value: 'records', label: 'Rows' },
];

const HEIGHT = 176;
/** Room above the bars for the peak's label, and below for the time axis. */
const TOP = 20;
const BOTTOM = 24;
/** The narrowest a column may be, gap included, before partitions are binned coarser. */
const MIN_SLOT = 5;

function measured(bin: Pick<PartitionBin, 'bytes' | 'files' | 'records'>, measure: Measure): number {
  return measure === 'bytes' ? bin.bytes : measure === 'files' ? bin.files : bin.records;
}

/** What a column holds besides the measure the chart draws: never the same number twice in a line. */
function rest(bin: Pick<PartitionBin, 'bytes' | 'files' | 'records' | 'smallFiles'>, measure: Measure): string {
  return [
    measure === 'files' ? `${formatCount(bin.smallFiles)} small` : `${formatCount(bin.files)} files, ${formatCount(bin.smallFiles)} small`,
    measure === 'bytes' ? null : formatBytes(bin.bytes),
    measure === 'records' ? null : `${formatCount(bin.records)} rows`,
  ]
    .filter((part) => part !== null)
    .join(' · ');
}

function say(value: number, measure: Measure): string {
  if (measure === 'bytes') return formatBytes(value);
  return `${formatCount(value)} ${measure === 'files' ? (value === 1 ? 'file' : 'files') : value === 1 ? 'row' : 'rows'}`;
}

const SPAN: Record<'hour' | 'day' | 'month', [string, string]> = { hour: ['hour', 'hours'], day: ['day', 'days'], month: ['month', 'months'] };

/**
 * Where a table's data is in time (docs/11-feature-reference.md §11.10): its partitions as columns
 * on a true time axis — size, files or rows — those the next compaction takes stronger, the work
 * waiting on them; a state's colour never paints a series (§10.8). Hundreds of partitions are
 * binned as finely as the width allows. The line above the chart reads out the whole table, or
 * the column pointed at; **List** gives every partition's exact numbers.
 */
export function PartitionsPanel({ metadata }: { metadata: TableMetadataView | null }): ReactNode {
  const [measure, setMeasure] = useState<Measure>('bytes');
  const [view, setView] = useState<'chart' | 'list'>('chart');
  const partitions = metadata?.partitions ?? [];
  const due = partitions.filter((row) => row.compactionDue).length;
  const span = useMemo(() => partitionSpan(partitions), [partitions]);
  const [one, many] = SPAN[span?.granularity ?? 'day'];
  const counted = span?.timed ?? 0;

  return (
    <Panel className="overflow-hidden">
      <header className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-2">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">Partitions</h2>
          <p className="numeric mt-1 text-[13px] text-[var(--color-ink-muted)]">
            {metadata ? (
              <>
                {span ? `${formatExact(counted)} ${counted === 1 ? one : many} · ${binLabel(span.first, span.granularity)} to ${binLabel(span.last, span.granularity)}` : 'Unpartitioned'}
                {due > 0 ? ` · ${formatExact(due)} due for compaction` : ' · nothing due for compaction'}
              </>
            ) : (
              'Read from the table itself, which this console cannot reach right now.'
            )}
          </p>
        </div>
        {partitions.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl value={measure} onChange={setMeasure} options={MEASURES} />
            <SegmentedControl
              value={view}
              onChange={setView}
              options={[
                { value: 'chart', label: 'Chart' },
                { value: 'list', label: 'List' },
              ]}
            />
          </div>
        ) : null}
      </header>
      {partitions.length === 0 ? (
        <EmptyState title="No data files" description="Partitions appear with the first commit." />
      ) : view === 'list' ? (
        <PartitionList partitions={partitions} />
      ) : (
        <Columns partitions={partitions} measure={measure} due={due > 0} totals={metadata?.totals ?? null} />
      )}
      {metadata && partitions.length > 0 ? (
        <p className="border-t border-[var(--color-line)] px-5 py-2.5 text-[12px] text-[var(--color-ink-faint)]">
          Files under {formatBytes(metadata.smallFileBytes)} count as small; compaction merges a partition’s small files once there
          are enough of them, and leaves the newest partitions while they are still being written.
        </p>
      ) : null}
    </Panel>
  );
}

function Columns({
  partitions,
  measure,
  due,
  totals,
}: {
  partitions: readonly TablePartitionRow[];
  measure: Measure;
  due: boolean;
  totals: TableMetadataView['totals'] | null;
}): ReactNode {
  const box = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(box);
  const [hover, setHover] = useState<number | null>(null);
  const binned = useMemo(() => binPartitions(partitions, Math.max(12, Math.floor((width || 600) / MIN_SLOT))), [partitions, width]);
  const { bins, level, untimed } = binned;
  const values = bins.map((bin) => measured(bin, measure));
  const peak = Math.max(1, ...values);
  const slot = bins.length > 0 ? width / bins.length : 0;
  const gap = slot >= 7 ? 2 : slot >= 3 ? 1 : 0;
  const bar = Math.min(24, Math.max(1, slot - gap));
  const plot = HEIGHT - TOP - BOTTOM;
  const base = TOP + plot;
  const marks = axisMarks(bins, level, Math.max(2, Math.floor(width / 72)));
  const hovered = hover !== null ? bins[hover] : undefined;

  return (
    <div className="px-5 pb-4">
      <Readout bin={hovered} level={level} measure={measure} totals={totals} />
      <div ref={box} className="relative" onPointerLeave={() => setHover(null)}>
        {width > 0 ? (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label={`${MEASURES.find((item) => item.value === measure)?.label} by ${level}: ${bins.length} ${bins.length === 1 ? level : `${level}s`}`}
            className="block overflow-visible"
          >
            <line x1={0} x2={width} y1={TOP} y2={TOP} className="stroke-[var(--color-line)]" strokeWidth={1} />
            <text x={0} y={TOP - 6} className="numeric fill-[var(--color-ink-faint)] text-[11px]">
              {say(peak, measure)}
            </text>
            {bins.map((bin, index) => {
              const value = values[index] as number;
              const height = value > 0 ? Math.max(1.5, (value / peak) * plot) : 0;
              const x = index * slot + (slot - bar) / 2;
              const radius = Math.min(3, bar / 2, height);
              // Due partitions stronger, the rest quiet; pointing at a column lifts it and quiets the rest.
              const strength = bin.due > 0 ? 1 : 0.45;
              const lifted = hover === null || hover === index;
              return (
                <g key={bin.start}>
                  {height > 0 ? (
                    <path
                      d={columnPath(x, base - height, bar, height, radius)}
                      className={cn('transition-opacity duration-150', hover === index ? 'fill-[var(--color-ink)]' : 'fill-[var(--color-ink-muted)]')}
                      opacity={hover === index ? 1 : strength * (lifted ? 1 : 0.55)}
                    />
                  ) : null}
                  {/* The whole column is the target, not only its painted pixels. */}
                  <rect x={index * slot} y={TOP} width={Math.max(slot, 1)} height={plot} fill="transparent" onPointerEnter={() => setHover(index)} />
                </g>
              );
            })}
            <line x1={0} x2={width} y1={base + 0.5} y2={base + 0.5} className="stroke-[var(--color-line-strong)]" strokeWidth={1} />
            {marks.map((mark) => (
              <g key={mark.index} transform={`translate(${mark.index * slot},${base})`}>
                <line y1={0} y2={4} className="stroke-[var(--color-line-strong)]" strokeWidth={1} />
                <text y={17} className="numeric fill-[var(--color-ink-faint)] text-[11px]">
                  {mark.label}
                </text>
              </g>
            ))}
          </svg>
        ) : (
          <div style={{ height: HEIGHT }} />
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[var(--color-ink-muted)]">
        <Key className="bg-[var(--color-ink-muted)] opacity-45">Partitions</Key>
        {due ? <Key className="bg-[var(--color-ink-muted)]">Due for compaction</Key> : null}
        {untimed ? (
          <span className="numeric">
            {partitions.some((row) => row.key === null) ? 'Unpartitioned' : 'No timestamp'}: {say(measured(untimed, measure), measure)}
            {measure !== 'files' ? ` · ${say(untimed.files, 'files')}` : ''}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** A column with its data end rounded and its foot square on the baseline. */
function columnPath(x: number, y: number, width: number, height: number, radius: number): string {
  const r = Math.max(0, radius);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

function Key({ className, children }: { className: string; children: ReactNode }): ReactNode {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={cn('size-2 rounded-[2px]', className)} />
      {children}
    </span>
  );
}

/**
 * The readout above the chart: the whole table, or the column pointed at — its value first, then
 * which time it is, then the rest of what it holds. A line of its own, so it never covers the chart.
 */
function Readout({
  bin,
  level,
  measure,
  totals,
}: {
  bin: PartitionBin | undefined;
  level: BinLevel;
  measure: Measure;
  totals: TableMetadataView['totals'] | null;
}): ReactNode {
  if (!bin) {
    return (
      <p className="numeric flex h-7 items-baseline gap-2 truncate text-[12px] text-[var(--color-ink-muted)]">
        {totals ? (
          <>
            <span className="text-[14px] font-semibold text-[var(--color-ink)]">{say(measured(totals, measure), measure)}</span>
            <span>in all · {rest(totals, measure)}</span>
          </>
        ) : null}
      </p>
    );
  }
  const several = bin.partitions > 1;
  return (
    <p className="numeric flex h-7 items-baseline gap-2 truncate text-[12px] text-[var(--color-ink-muted)]">
      <span className="text-[14px] font-semibold text-[var(--color-ink)]">{bin.partitions === 0 ? 'No data' : say(measured(bin, measure), measure)}</span>
      <span className="truncate">
        {binLabel(bin.start, level)}
        {several ? ` · ${bin.partitions} partitions` : ''}
        {bin.partitions > 0 ? ` · ${rest(bin, measure)}` : ''}
        {bin.due > 0 ? (
          <span className="font-medium text-[var(--color-ink)]"> · {several ? `${bin.due} of ${bin.partitions} due for compaction` : 'due for compaction'}</span>
        ) : null}
      </span>
    </p>
  );
}

/** Every partition, newest first, with its exact numbers: what the chart draws, to read and to copy. */
function PartitionList({ partitions }: { partitions: readonly TablePartitionRow[] }): ReactNode {
  return (
    <div className="max-h-[360px] overflow-y-auto border-t border-[var(--color-line)]">
      <table className="w-full text-[12px]">
        <thead className="sticky top-0 bg-[var(--color-surface)]">
          <tr className="text-left text-[var(--color-ink-faint)]">
            <th className="px-5 py-2 font-normal">Partition</th>
            <th className="px-2 py-2 text-right font-normal">Files</th>
            <th className="px-2 py-2 text-right font-normal">Small</th>
            <th className="px-2 py-2 text-right font-normal">Size</th>
            <th className="px-2 py-2 text-right font-normal">Rows</th>
            <th className="px-5 py-2 font-normal">Compaction</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-line)]">
          {partitions.map((row) => (
            <tr key={row.key ?? 'none'}>
              <td className="numeric px-5 py-1.5">{row.key === null ? 'unpartitioned' : row.key === '__null__' ? 'no timestamp' : row.key}</td>
              <td className="numeric px-2 py-1.5 text-right">{formatExact(row.files)}</td>
              <td className="numeric px-2 py-1.5 text-right text-[var(--color-ink-muted)]">{formatExact(row.smallFiles)}</td>
              <td className="numeric px-2 py-1.5 text-right">{formatBytes(row.bytes)}</td>
              <td className="numeric px-2 py-1.5 text-right">{formatExact(row.records)}</td>
              <td className={cn('px-5 py-1.5', row.compactionDue ? 'font-medium text-[var(--color-ink)]' : 'text-[var(--color-ink-faint)]')}>
                {row.compactionDue ? 'Due' : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
