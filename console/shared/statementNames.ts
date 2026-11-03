/**
 * How a statement names tables (handbook 20): always with their domain, `<domain>.<dataset>.<table>`,
 * so a statement reads the same wherever it is pasted; the native Iceberg table is
 * `<domain>_iceberg.<dataset>.<table>`. In DuckDB the domain is a catalog, the dataset a schema.
 *
 * Shared, so the browser reads the tables a draft names by the same rules the server runs it by.
 * Dependency-free: imported by the server and the browser alike.
 */

import { NATIVE_CATALOG_SUFFIX } from './tableNames.ts';

/** A table a statement names. */
export interface TableReference {
  domain: string;
  dataset: string;
  table: string;
  /** Named as its native Iceberg table, `<domain>_iceberg.…`. */
  native: boolean;
  /** As the statement wrote it, for a message. */
  written: string;
}

/** A table's name in SQL: `<domain>.<dataset>.<table>`. */
export function canonicalName(domain: string, dataset: string, table: string): string {
  return `${domain}.${dataset}.${table}`;
}

/** The catalog a domain's native tables are in: `<domain>_iceberg`. */
export function nativeCatalog(domain: string): string {
  return `${domain}${NATIVE_CATALOG_SUFFIX}`;
}

/** An identifier: quoted, with `""` for a quote inside, or bare. */
const PART = String.raw`("(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
const DOT = String.raw`\s*\.\s*`;

function unquote(token: string): string {
  return token.startsWith('"') ? token.slice(1, -1).replace(/""/g, '"') : token;
}

/**
 * Every table a statement names in one of `domains`, each once, in the order they first appear:
 * three dotted names whose first is a domain id, or its native catalog. SQL compares names without
 * regard to case, so they are read lowercase; a fourth name - a column - after them is not part of
 * the table's.
 */
export function namedTables(statement: string, domains: readonly string[]): TableReference[] {
  const known = new Map<string, { domain: string; native: boolean }>();
  for (const domain of domains) {
    known.set(domain.toLowerCase(), { domain, native: false });
    known.set(nativeCatalog(domain).toLowerCase(), { domain, native: true });
  }
  const pattern = new RegExp(`(?<![\\w$."])${PART}${DOT}${PART}${DOT}${PART}`, 'g');
  const found = new Map<string, TableReference>();
  for (const match of stripStringsAndComments(statement, { keepLength: true }).matchAll(pattern)) {
    const catalog = known.get(unquote(match[1] as string).toLowerCase());
    if (!catalog) continue;
    const dataset = unquote(match[2] as string).toLowerCase();
    const table = unquote(match[3] as string).toLowerCase();
    const key = `${catalog.native ? 'n' : 'l'}:${canonicalName(catalog.domain, dataset, table)}`;
    if (!found.has(key)) found.set(key, { domain: catalog.domain, dataset, table, native: catalog.native, written: match[0] });
  }
  return [...found.values()];
}

/**
 * The tables of `tables` a statement names without their domain - `sales.orders`, or the native
 * `iceberg.sales.orders` of before - each once: a statement must name its domain.
 */
export function unqualifiedReferences(statement: string, tables: ReadonlyArray<{ dataset: string; table: string }>): string[] {
  const byName = new Set(tables.map((entry) => `${entry.dataset}.${entry.table}`.toLowerCase()));
  // Two dotted names not after a dot - nor before a third, which makes them a table's own name - or
  // three that start with the old native catalog.
  const two = new RegExp(`(?<![\\w$."])${PART}${DOT}${PART}(?!${DOT}[A-Za-z_"])`, 'g');
  const native = new RegExp(`(?<![\\w$."])iceberg${DOT}${PART}${DOT}${PART}`, 'gi');
  const stripped = stripStringsAndComments(statement, { keepLength: true });
  const found = new Set<string>();
  for (const match of stripped.matchAll(two)) {
    const name = `${unquote(match[1] as string)}.${unquote(match[2] as string)}`.toLowerCase();
    if (byName.has(name)) found.add(name);
  }
  for (const match of stripped.matchAll(native)) {
    const name = `${unquote(match[1] as string)}.${unquote(match[2] as string)}`.toLowerCase();
    if (byName.has(name)) found.add(`iceberg.${name}`);
  }
  return [...found];
}

/**
 * Blank out string literals and comments so keyword scanning cannot be fooled by data.
 *
 * By default quoted identifiers are blanked too and the text shrinks. `keepLength` blanks string
 * literals and comments with spaces instead and keeps quoted identifiers, so a position in the
 * result is the same position in the statement.
 */
export function stripStringsAndComments(sql: string, options: { keepLength?: boolean } = {}): string {
  const keep = options.keepLength ?? false;
  let result = '';
  let index = 0;
  const blank = (text: string): string => text.replace(/[^\n]/g, ' ');

  while (index < sql.length) {
    const char = sql[index] as string;
    const next = sql[index + 1];

    if (char === '-' && next === '-') {
      // A `--` comment runs to the first carriage return or line feed, as DuckDB ends it (so a
      // forbidden token hidden after `--x\r` is still scanned); the terminator itself is kept.
      const offset = sql.slice(index).search(/[\r\n]/);
      const end = offset === -1 ? sql.length : index + offset;
      if (keep) result += blank(sql.slice(index, end));
      index = end;
      continue;
    }
    if (char === '/' && next === '*') {
      const found = sql.indexOf('*/', index + 2);
      const end = found === -1 ? sql.length : found + 2;
      if (keep) result += blank(sql.slice(index, end));
      index = end;
      continue;
    }
    if (char === "'" || char === '"' || char === '$') {
      const quote = char;
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (sql[cursor] === quote) {
          if (sql[cursor + 1] === quote) {
            cursor += 2;
            continue;
          }
          break;
        }
        cursor += 1;
      }
      const end = Math.min(cursor + 1, sql.length);
      if (keep) result += quote === '"' ? sql.slice(index, end) : blank(sql.slice(index, end));
      // Preserve identifier boundaries so `"a"."b"` does not collapse into one token.
      else result += quote === '"' ? ' x ' : ' ';
      index = cursor + 1;
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}
