import type { CpTableSpec } from '@shared/types';

/** The query parameter that named a table on a materialization's Data, Schema and Tables tabs, before tables had pages. */
export const TABLE_PARAM = 'table';

/**
 * The materialization's table `name` refers to, compared as SQL compares names; its first table
 * when `name` names none of them - or names one `allowed` refuses, when the first allowed one is.
 * Null for a materialization without tables, or without one allowed.
 */
export function resolveTable(
  tables: readonly CpTableSpec[],
  name: string | null | undefined,
  allowed: (table: CpTableSpec) => boolean = () => true,
): CpTableSpec | null {
  const wanted = name?.trim().toLowerCase();
  const named = wanted ? tables.find((table) => table.name.toLowerCase() === wanted) : undefined;
  if (named && allowed(named)) return named;
  return tables.find(allowed) ?? null;
}

/**
 * The table a page is about, by its name as SQL compares names — never another in its place. Null
 * when the materialization has no such table, or `allowed` refuses it.
 */
export function namedTable(
  tables: readonly CpTableSpec[],
  name: string,
  allowed: (table: CpTableSpec) => boolean = () => true,
): CpTableSpec | null {
  const wanted = name.trim().toLowerCase();
  const found = tables.find((table) => table.name.toLowerCase() === wanted);
  return found && allowed(found) ? found : null;
}
