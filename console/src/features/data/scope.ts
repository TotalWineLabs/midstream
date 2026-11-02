/**
 * What a workbench is about (`Workbench.tsx`): the table it browses, or a statement starts from -
 * wherever it is - or none, for a statement over the lake (Explore). No React: its rules are tested
 * as plain functions.
 */

import { canonicalName, namedTables } from '@shared/statementNames';
import type { RunSnapshot, TableRef } from '@shared/types';

/** The table a workbench is about: where it is, as SQL names it, and what writes it. */
export interface WorkbenchSource extends TableRef {
  datasetId: string;
  /** The materialization writing it: its detail feeds the workbench's schemas, lag and live tail. */
  materializationId: string;
}

/** A table as SQL names it, `<domain>.<dataset>.<table>`, lowercase as SQL compares names; '' for none. */
export function sourceKey(table: TableRef | null | undefined): string {
  return table ? canonicalName(table.domain, table.dataset, table.table).toLowerCase() : '';
}

/** Whether two references name one table, as SQL compares names. */
export function sameTable(left: TableRef | null | undefined, right: TableRef | null | undefined): boolean {
  return sourceKey(left) === sourceKey(right);
}

/** A source as a request names it: its place, and nothing else. */
export function refOf(source: TableRef): TableRef {
  return { domain: source.domain, dataset: source.dataset, table: source.table };
}

/**
 * Whether a run, picked back up by its id - after a reload, from History - is about `source`: the
 * same table; with no source, a statement with none of its own.
 */
export function runBelongs(run: Pick<RunSnapshot, 'request'>, source: TableRef | null): boolean {
  const own = run.request.source ?? null;
  if (source === null) return run.request.kind === 'sql' && own === null;
  return own !== null && sameTable(own, source);
}

/**
 * The tables a statement names that the lake holds, each once, in the order it names them: what its
 * time range bounds, and so what the time picker's figures count. Names the lake does not hold - a
 * table still being typed - are left out.
 */
export function statementTables(sql: string, domains: readonly string[], lake: readonly TableRef[]): TableRef[] {
  const known = new Map(lake.map((table) => [sourceKey(table), table]));
  const found = new Map<string, TableRef>();
  for (const reference of namedTables(sql, domains)) {
    const key = canonicalName(reference.domain, reference.dataset, reference.table).toLowerCase();
    const table = known.get(key);
    if (table && !found.has(key)) found.set(key, refOf(table));
  }
  return [...found.values()];
}
