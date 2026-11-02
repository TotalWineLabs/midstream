import { ChevronDown, ChevronUp, Copy, Filter, X } from 'lucide-react';
import { useEffect, useMemo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { groupColumns } from './columns';
import { readJsonShape } from './jsonShape';
import { ProtectedMark } from '../protection/ProtectionSummary';
import { fieldProtectionText } from '../protection/protection';
import { useTabShown } from '@/components/TabPanel';
import { Button } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/cn';
import { useMaterializationDefaults } from '@/lib/defaults';
import { formatCell, formatExact, formatInstant, isInstantType, localZone } from '@/lib/format';
import { rowNester } from '@shared/fieldPaths';
import type { BrowseFilter, QueryColumn } from '@shared/types';

/**
 * One row's every field, in a properties column beside the grid (docs/10-design-system.md §10.10),
 * or a sheet over it on a phone, where there is no room beside it.
 *
 * A materialized row is wide and mostly nested paths; reading one across a horizontally scrolling
 * grid is the slowest way to read it. Here every field is on one vertical axis, grouped the same way
 * as the column list, hidden ones included, with per-field copy and filter-to-this-value. The grid
 * stays usable beside it: another row's gutter shows that row instead.
 */
export function RowProperties({
  row,
  columns,
  schemaOrder,
  index,
  total,
  live = false,
  sheet = false,
  onClose,
  onStep,
  onFilter,
}: {
  row: Record<string, unknown>;
  columns: QueryColumn[];
  schemaOrder: string[];
  /** The row's place in the whole result, from 0. */
  index: number;
  total: number;
  /** Past the table's last commit: shown by the console from Kafka, not in the table yet. */
  live?: boolean;
  /** Over the page rather than beside the grid. */
  sheet?: boolean;
  onClose: () => void;
  onStep: (delta: number) => void;
  /** Filter the view to a value; absent where the view has no filters, such as a statement's. */
  onFilter?: (filter: BrowseFilter) => void;
}): ReactNode {
  const catalog = useMaterializationDefaults().defaults?.protection ?? null;
  const toast = useToast();
  const groups = useMemo(() => groupColumns(columns, schemaOrder), [columns, schemaOrder]);
  const zone = useMemo(() => localZone(), []);
  // The same layout exports use: the record rebuilt from its field paths, or one key per column.
  const nest = useMemo(
    () => rowNester(columns.map((column) => column.name), { jsonColumns: new Set(columns.filter((column) => column.json).map((column) => column.name)) }),
    [columns],
  );

  // The row stays open while another of the page's tabs is shown, and its keys are that tab's.
  const shown = useTabShown();
  useEffect(() => {
    if (!shown) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      // Beside the grid the page stays in use: keys typed into a field are that field's.
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowDown' || event.key === 'j') onStep(1);
      else if (event.key === 'ArrowUp' || event.key === 'k') onStep(-1);
      else return;
      event.preventDefault();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, onStep, shown]);

  const copy = (text: string, label: string): void => {
    void navigator.clipboard.writeText(text);
    toast.success('Copied', label);
  };

  const partition = row._kafka_partition;
  const offset = row._kafka_offset;
  const identity =
    partition !== null && partition !== undefined && offset !== null && offset !== undefined
      ? `partition ${String(partition)} · offset ${typeof offset === 'number' ? formatExact(offset) : String(offset)}`
      : null;

  const body = (
    <>
      <header className="flex items-center gap-1 border-b border-[var(--color-line)] py-2.5 pr-2 pl-4">
        <div className="min-w-0 flex-1">
          <h2 className="numeric text-[13px] font-semibold">
            Row {formatExact(index + 1)} <span className="font-normal text-[var(--color-ink-muted)]">of {formatExact(total)}</span>
          </h2>
          <p className="truncate text-[11px] text-[var(--color-ink-muted)]">
            {live ? <span className="text-[var(--color-current-ink)]">Live, not in the table yet</span> : null}
            {live && identity ? ' · ' : null}
            {identity ? <span className="numeric">{identity}</span> : null}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => onStep(-1)} disabled={index === 0} aria-label="Previous row" title="Previous row (↑ or k)" className="px-1.5">
          <ChevronUp className="size-4" />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onStep(1)} disabled={index >= total - 1} aria-label="Next row" title="Next row (↓ or j)" className="px-1.5">
          <ChevronDown className="size-4" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          title="Copy this row as JSON, in the layout chosen under Export"
          onClick={() => {
            const nested = readJsonShape() === 'nested';
            copy(JSON.stringify(nested ? nest(row) : row, null, 2), nested ? 'Row copied as nested JSON' : 'Row copied as flat JSON');
          }}
        >
          <Copy className="size-3.5" />
          JSON
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close the row" title="Close (Esc)" className="px-1.5">
          <X className="size-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.map((group) => (
          <section key={group.id}>
            <h3 className="sticky top-0 z-10 border-b border-[var(--color-line)] bg-[var(--color-raised)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-ink-muted)]">
              {group.label}
            </h3>
            <dl>
              {group.columns.map((column) => {
                const value = row[column.name];
                const empty = value === null || value === undefined;
                const masked = column.protection !== undefined;
                // Copy and filter use the stored value; an instant is also shown in local time.
                const text = formatCell(value);
                const instant = !empty && !masked && typeof value === 'string' && isInstantType(column.type);
                return (
                  <div
                    key={column.name}
                    className="group grid grid-cols-[minmax(0,40%)_minmax(0,1fr)] items-start gap-3 border-b border-[var(--color-line)] px-4 py-2 last:border-b-0 hover:bg-[var(--color-raised)]"
                  >
                    <dt
                      className="flex min-w-0 items-center gap-1 pt-px text-[var(--color-ink-muted)]"
                      title={`${column.name} · ${column.type}${column.protection ? ` · masked: ${fieldProtectionText(column.protection, catalog)}` : ''}`}
                    >
                      <span className="ident truncate text-[11px]">{column.name}</span>
                      <ProtectedMark protection={column.protection} />
                    </dt>
                    <dd className="flex min-w-0 items-start gap-1">
                      <span
                        className={cn(
                          'min-w-0 flex-1 break-all',
                          masked
                            ? cn('veil -mx-1 rounded-[4px] px-1', empty && 'italic')
                            : cn('numeric text-[12px]', empty ? 'text-[var(--color-ink-faint)] italic' : 'text-[var(--color-ink)]'),
                        )}
                      >
                        {empty ? (
                          column.protection?.mask === 'redact' ? 'withheld' : 'null'
                        ) : instant ? (
                          <>
                            {formatInstant(text)} <span className="text-[var(--color-ink-muted)]">{zone.label}</span>
                            <span className="block text-[11px] text-[var(--color-ink-muted)]">{text}</span>
                          </>
                        ) : (
                          text
                        )}
                      </span>
                      {empty ? null : (
                        <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                          {onFilter ? (
                            <button
                              type="button"
                              title="Filter to this value"
                              aria-label={`Filter to ${column.name}`}
                              onClick={() => onFilter({ column: column.name, operator: 'eq', value: text })}
                              className="rounded p-0.5 text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
                            >
                              <Filter className="size-3" />
                            </button>
                          ) : null}
                          <button
                            type="button"
                            title="Copy value"
                            aria-label={`Copy ${column.name}`}
                            onClick={() => copy(text, column.name)}
                            className="rounded p-0.5 text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
                          >
                            <Copy className="size-3" />
                          </button>
                        </span>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </section>
        ))}
      </div>
    </>
  );

  if (sheet) {
    // A phone has no room beside the grid: the row covers it, and closing returns to it.
    return createPortal(
      <aside role="dialog" aria-modal="true" aria-label="Row" className="slide-in-right fixed inset-0 z-50 flex flex-col bg-[var(--color-surface)]">
        {body}
      </aside>,
      document.body,
    );
  }
  return (
    <aside aria-label="Row" className="slide-in-right flex w-[380px] shrink-0 flex-col border-l border-[var(--color-line)] bg-[var(--color-surface)] xl:w-[420px]">
      {body}
    </aside>
  );
}
