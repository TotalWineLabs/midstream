/**
 * The registry of runs, and the only way one is created.
 *
 * Runs live in this process, which matches the console's single-replica deployment: a run's
 * counts, stored result and listeners are all here. Nothing outside this module decides how a
 * query executes — `startRun` looks at what was asked and picks the run kind.
 */

import { config } from '../config.ts';
import { badRequest, notFound } from '../errors.ts';
import { logger } from '../logger.ts';
import { cancelledError, withSandbox } from '../data/duckdb.ts';
import { loadCatalog, noTableCatalog, pauseWarming, type Catalog } from '../data/catalog.ts';
import { logicalColumns, resolveFilters } from '../data/logical.ts';
import { assertReadOnlyStatement } from '../data/sql.ts';
import { BrowseRun } from './browse.ts';
import { canonicalName } from './names.ts';
import { StatementRun, statementError, type StatementSource } from './statement.ts';
import { listOf, statementViews } from './view.ts';
import type { Run, RunDataset, RunInit } from './run.ts';
import type { TailAccess } from './tail.ts';
import type { RunRequest, TableRef, TimeRange } from '../../shared/types.ts';

const runs = new Map<string, Run>();

/**
 * Admission for scanning, so a burst of runs queues rather than saturating DuckDB.
 *
 * Only the scanning phase is admitted. A run the manifests answer on their own — the first page of
 * any table, a time range over whole files — never waits behind someone else's scan. Background
 * footer warming waits while any run is admitted.
 *
 * At most `runConcurrency` runs scan at once, and at most `runConcurrencyPerPerson` of one person's:
 * someone with several explorations open cannot take every scan. A run waiting only for the
 * person's own is passed over, not waited behind, so it never holds up anyone else's.
 */
let scanning = 0;
const scanningBy = new Map<string, number>();
const waiting: Array<{ person: string; grant: () => void; signal: AbortSignal; reject: (cause: unknown) => void }> = [];

/** Why a run waits its turn: behind the person's own runs, or behind everyone's. */
export type QueueReason = 'own' | 'others';

function ownLimitReached(person: string): boolean {
  const limit = config.runConcurrencyPerPerson;
  return limit > 0 && (scanningBy.get(person) ?? 0) >= limit;
}

function canScan(person: string): boolean {
  return scanning < config.runConcurrency && !ownLimitReached(person);
}

/**
 * Wait for a turn to scan, as `person`; `onQueued` hears, once, that the run has to wait and behind
 * whose runs. Resolves to the release, which must be called when the scan is done. Exported for
 * tests; runs reach it through `RunInit.admit`.
 */
export function admit(signal: AbortSignal, person: string, onQueued?: (reason: QueueReason) => void): Promise<() => void> {
  if (signal.aborted) return Promise.reject(cancelledError());
  const grant = (): (() => void) => {
    scanning += 1;
    scanningBy.set(person, (scanningBy.get(person) ?? 0) + 1);
    const resumeWarming = pauseWarming();
    return once(() => {
      scanning -= 1;
      const left = (scanningBy.get(person) ?? 1) - 1;
      if (left > 0) scanningBy.set(person, left);
      else scanningBy.delete(person);
      resumeWarming();
      pump();
    });
  };
  if (canScan(person)) return Promise.resolve(grant());
  onQueued?.(ownLimitReached(person) ? 'own' : 'others');
  return new Promise((resolve, reject) => {
    const entry = {
      person,
      signal,
      reject,
      grant: () => resolve(grant()),
    };
    waiting.push(entry);
    signal.addEventListener(
      'abort',
      () => {
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
        reject(cancelledError());
      },
      { once: true },
    );
  });
}

/** Grant waiting runs their turn, oldest first, passing over anyone at their own limit. */
function pump(): void {
  let index = 0;
  while (scanning < config.runConcurrency && index < waiting.length) {
    const next = waiting[index] as (typeof waiting)[number];
    if (next.signal.aborted) {
      waiting.splice(index, 1);
      continue;
    }
    if (ownLimitReached(next.person)) {
      index += 1;
      continue;
    }
    waiting.splice(index, 1);
    next.grant();
  }
}

function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}

/** One of a materialization's tables, as the control plane describes it. */
export interface RunTableSource {
  /** The domain it is in (handbook 20). */
  domain: string;
  /** The materialization that writes it. */
  materializationId: string;
  /** Its name in its dataset: SQL reads it as `<domain>.<dataset>.<name>`, and `<domain>_iceberg.<dataset>.<name>`. */
  name: string;
  /** The dataset it is in: its namespace in SQL. */
  dataset: string;
  datasetId: string;
  /** Its location; null before the control plane has created it. */
  location: string | null;
}

/**
 * A table a statement names, found in its domain (handbook 20): where it lives, and how its live tail
 * is read - through its own domain's tail app, as the person is there.
 */
export interface ResolvedTable extends RunTableSource {
  tail: TailAccess | null;
}

export interface StartRunInput {
  /**
   * The domain the run belongs to: its own table's; for a statement without one, the domain of the
   * first table it names, else the settings home's.
   */
  domain: string;
  /** The materialization writing the run's own table; null for a statement without one. */
  materializationId: string | null;
  /** Who is starting the run, as the domain knows them. Nobody else can read it. */
  ownerId: string;
  /**
   * Who the person is across the console, for admission (`runConcurrencyPerPerson`): their email,
   * which is the same person in every domain (handbook 20); `ownerId` when they have none.
   */
  person?: string;
  /**
   * The tables the run may be about, in order: a materialization's every table, from its own
   * route; the one a request names by reference, from the console's (`POST /api/runs`); none for a
   * statement with no table of its own.
   */
  tables: RunTableSource[];
  request: RunRequest;
  /**
   * How the run reads its own table's live tail. A request with `liveTail: false`, or `asOf` an older
   * snapshot, reads none whatever this says.
   */
  tail?: TailAccess | null;
  /**
   * A statement's tables, in the order it names them, found in their domains by whoever starts the
   * run (`routes/data.ts`), which has checked the person may query each.
   */
  sources?: ResolvedTable[];
  /** Tables a statement could name, by their full names, so an error can say which there are. */
  tableNames?: string[];
}

/**
 * The tables a run reads: the one it browses; a statement's named tables, or - a statement that
 * names none - its request's table, if it has one. Whoever starts it must be allowed to query each.
 */
export function tablesRead(
  tables: RunTableSource[],
  request: Pick<RunRequest, 'kind' | 'table'>,
  sources: readonly RunTableSource[] = [],
): RunTableSource[] {
  if (request.kind === 'sql' && sources.length > 0) return [...sources];
  // A statement with no table of its own that names none reads no table at all: `SELECT 1`.
  if (request.kind === 'sql' && tables.length === 0) return [];
  return [pickTable(tables, request.table)];
}

/** Whether a run reads its tables' live tails: not as of an older snapshot, nor when asked not to. */
export function readsTails(request: Pick<RunRequest, 'asOf' | 'liveTail'>): boolean {
  return !request.asOf && request.liveTail !== false;
}

/** The datasets of some tables, each once, in their domains. */
function datasetsOf(tables: RunTableSource[]): RunDataset[] {
  const byId = new Map(tables.map((table) => [`${table.domain}:${table.datasetId}`, { domain: table.domain, id: table.datasetId, name: table.dataset }]));
  return [...byId.values()];
}

/** A table, as a request names it wherever it is. */
function refOf(table: RunTableSource): TableRef {
  return { domain: table.domain, dataset: table.dataset, table: table.name };
}

/**
 * Create a run, start it, and return it at once; progress arrives through `subscribe`.
 *
 * A browse run reads its table (`request.table`, the first of `tables` by default). A statement
 * reads every table it names, each pinned to its current snapshot — the request's table to `asOf`
 * when it names one — and no other; it may have no table of its own (`tables` empty), and may name
 * none.
 */
export async function startRun(input: StartRunInput): Promise<Run> {
  validateRange(input.request);
  const statement = input.request.kind === 'sql' ? assertReadOnlyStatement(input.request.sql ?? '') : null;
  // A browse run is always about a table; a statement may have none of its own.
  const selected = statement === null || input.tables.length > 0 ? pickTable(input.tables, input.request.table) : null;
  const named = statement === null ? [] : (input.sources ?? []);
  const datasets = datasetsOf(tablesRead(input.tables, input.request, named));
  // A run as of an older snapshot is about the past: what arrived since is not part of it.
  const tails = readsTails(input.request);
  const tail = tails ? (input.tail ?? null) : null;
  const person = input.person ?? input.ownerId;
  const admitAs: RunInit['admit'] = (signal, onQueued) => admit(signal, person, onQueued);
  const source = selected ? refOf(selected) : null;

  if (statement === null) {
    const table = selected as RunTableSource;
    const catalog = await loadCatalog(table.materializationId, table.location, {
      fresh: true,
      snapshotId: input.request.asOf ?? null,
      table: table.name,
    });
    assertReadable(catalog);
    const columns = logicalColumns(catalog.schema, catalog.forkMap, catalog.protection);
    // The run echoes its request back, so it carries the filters as applied: a link that still
    // names `payload.status` gets a run, and a request, about `status`.
    const request = { ...input.request, table: table.name, source, filters: resolveFilters(input.request.filters ?? [], columns) };
    return register(
      new BrowseRun({
        domain: input.domain,
        materializationId: input.materializationId,
        ownerId: input.ownerId,
        tableName: table.name,
        datasets,
        request,
        catalog,
        columns,
        admit: admitAs,
        tail,
      }),
    );
  }

  // The request's table is read as of `asOf`; every other table at its current snapshot.
  const isRequested = (table: RunTableSource): boolean =>
    selected !== null && table.domain === selected.domain && table.materializationId === selected.materializationId && table.name === selected.name;
  const sources: StatementSource[] = await Promise.all(
    named.map(async (table): Promise<StatementSource> => {
      const catalog = await loadCatalog(table.materializationId, table.location, {
        fresh: true,
        snapshotId: isRequested(table) ? (input.request.asOf ?? null) : null,
        table: table.name,
      });
      assertReadable(catalog);
      return {
        domain: table.domain,
        namespace: table.dataset,
        datasetId: table.datasetId,
        name: table.name,
        catalog,
        columns: logicalColumns(catalog.schema, catalog.forkMap, catalog.protection),
        tail: tails ? table.tail : null,
      };
    }),
  );
  // The run is about the request's table when the statement reads it, else the first it reads; a
  // statement that reads no table at all is about the request's table, or about none.
  const primary =
    sources.find((_source, index) => isRequested(named[index] as RunTableSource)) ??
    sources[0] ??
    (selected === null
      ? null
      : await (async (): Promise<StatementSource> => {
          const catalog = await loadCatalog(selected.materializationId, selected.location, { fresh: true, table: selected.name });
          return {
            domain: selected.domain,
            namespace: selected.dataset,
            datasetId: selected.datasetId,
            name: selected.name,
            catalog,
            columns: logicalColumns(catalog.schema, catalog.forkMap, catalog.protection),
            tail: null,
          };
        })());
  return register(
    new StatementRun({
      domain: input.domain,
      materializationId: input.materializationId,
      ownerId: input.ownerId,
      tableName: primary?.name ?? null,
      datasets,
      request: { ...input.request, table: selected?.name ?? null, source },
      catalog: primary?.catalog ?? noTableCatalog(),
      columns: primary?.columns ?? [],
      admit: admitAs,
      tail,
      statement,
      sources,
      tableNames: input.tableNames ?? input.tables.map((table) => canonicalName(table.domain, table.dataset, table.name)),
    }),
  );
}

export interface RefreshRunInput {
  run: Run;
  /** Who is refreshing: the run's owner, as `getRun` checked. A run that replaces it is theirs too. */
  ownerId: string;
  /** Who the person is across the console, for a run that replaces it (`StartRunInput.person`). */
  person?: string;
  /** The tables the run may be about, as they are now (`StartRunInput.tables`). */
  tables: RunTableSource[];
  /** A statement's tables, found in their domains again: a run that replaces it reads them as they are now. */
  sources?: ResolvedTable[];
  tableNames?: string[];
  /** The run's range resolved again, for a run that replaces it: a relative range slides. */
  range?: TimeRange | null;
  /** How the refreshed run reads its tail now: the person's current session, the switches as they are. */
  tail: TailAccess | null;
}

/**
 * Bring a run up to date: append the live tail's newest records to it, or start a run in its place.
 *
 * A browse run whose table is still at the snapshot it is pinned to only fetches the records past
 * its tail's `through`, so its rows grow and every row read before keeps its identity. A run is
 * replaced — the same request, its range resolved again — when a commit has landed since it
 * started, when it failed or was cancelled, when it is a statement (whose result is materialized),
 * or when its tail was off on this side when it started and is on now. Nothing else replaces one:
 * a run on the same snapshot would fetch the same tail, so a tail that cannot be had stays the
 * run's status until the table's next commit. A run as of an older snapshot, or still running, is
 * answered as it is. The run a new one replaces expires within a minute unless it is still read.
 */
export async function refreshRun(input: RefreshRunInput): Promise<{ replaced: boolean; run: Run }> {
  const { run } = input;
  const replace = async (): Promise<{ replaced: true; run: Run }> => {
    const request = input.range ? { ...run.request, range: input.range } : run.request;
    const next = await startRun({
      domain: run.domain,
      materializationId: run.materializationId,
      ownerId: input.ownerId,
      ...(input.person ? { person: input.person } : {}),
      tables: input.tables,
      request,
      tail: input.tail,
      ...(input.sources ? { sources: input.sources } : {}),
      ...(input.tableNames ? { tableNames: input.tableNames } : {}),
    });
    run.expireWithin(REPLACED_RUN_GRACE_MS);
    return { replaced: true, run: next };
  };
  if (run.request.asOf) return { replaced: false, run };
  if (run.state === 'running') return { replaced: false, run };
  if (run.request.kind === 'sql' || run.state !== 'succeeded' || !(run instanceof BrowseRun)) return replace();

  const table = pickTable(input.tables, run.tableName);
  const catalog = await loadCatalog(table.materializationId, table.location, { fresh: true, table: table.name });
  if ((catalog.snapshot?.snapshotId ?? null) !== run.snapshotId) return replace();

  const tail = run.tailOf();
  if (!tail) return { replaced: false, run };
  const access = input.tail;
  if (access === null || access.off) {
    if (!tail.stopped) tail.turnOff(access?.off?.reason ?? 'off', access?.off?.message ?? 'Live tail is off.');
    return { replaced: false, run };
  }
  // Switched off when the run started or since, on now: only a new run fetches from its snapshot again.
  if (tail.switchedOff) return replace();
  await run.refreshTail(access);
  return { replaced: false, run };
}

/** How long a run another replaced stays, unless it is read: an export of it may still be going. */
const REPLACED_RUN_GRACE_MS = 60_000;

function register(run: Run): Run {
  runs.set(run.id, run);
  void run.start();
  return run;
}

/** The table a request names, compared without regard to case; the first table when it names none. */
export function pickTable(tables: RunTableSource[], requested: string | null | undefined): RunTableSource {
  if (tables.length === 0) throw badRequest('this materialization has no tables yet', { field: 'table' });
  if (!requested) return tables[0] as RunTableSource;
  const wanted = requested.trim().toLowerCase();
  const table = tables.find((candidate) => candidate.name.toLowerCase() === wanted);
  if (!table) {
    throw badRequest(`there is no table ${requested}; this materialization's tables are ${listOf(tables.map((candidate) => candidate.name))}`, {
      field: 'table',
    });
  }
  return table;
}

/**
 * Refuse a snapshot holding delete files, or data files outside the table's location.
 *
 * The materializer only ever appends and compacts, but an engine with write access to the catalog
 * can commit row-level deletes. The console reads data files directly, so it would show deleted
 * rows; it says so instead. A data file outside the location is one the console never reads
 * (`iceberg/io.ts::isUnderLocation`), so a run without it would be missing rows.
 */
function assertReadable(catalog: Catalog): void {
  // A statement may read several tables: say which one cannot be read.
  const which = catalog.table ? `Table ${catalog.table}: this snapshot` : 'This snapshot';
  const deletes = catalog.snapshot?.deleteFiles ?? 0;
  if (deletes > 0) {
    throw badRequest(
      `${which} holds ${deletes.toLocaleString('en-US')} delete files committed by another engine, which the console ` +
        `cannot apply. Query the table with an engine that reads Iceberg deletes (Table › Connect).`,
      { deleteFiles: deletes },
    );
  }
  const outside = catalog.snapshot?.outsideFiles ?? 0;
  if (outside > 0) {
    throw badRequest(
      `${which} holds ${outside.toLocaleString('en-US')} data files outside the table's location, committed by another ` +
        `engine; the console reads only files under ${catalog.location ?? 'the table'}. Query the table with an engine ` +
        `(Table › Connect).`,
      { outsideFiles: outside },
    );
  }
}

/**
 * Bind a statement without running it, so the editor can mark an error while it is being typed.
 *
 * Binding needs the views' columns, not their rows, and every column's type is in its table's
 * schema, so the views of the tables the statement names are built over no files at all: typed and
 * empty. The sandbox may open nothing, so a statement naming a file is refused at bind time as it
 * would be at run time.
 */
export async function validateStatement(input: { sources: RunTableSource[]; sql: string; tableNames: string[] }): Promise<void> {
  const statement = assertReadOnlyStatement(input.sql);
  const views = await Promise.all(
    input.sources.map(async (table) => {
      const catalog = await loadCatalog(table.materializationId, table.location, { table: table.name });
      return {
        domain: table.domain,
        namespace: table.dataset,
        name: table.name,
        sources: [],
        schema: catalog.schema,
        columns: logicalColumns(catalog.schema, catalog.forkMap, catalog.protection),
      };
    }),
  );

  await withSandbox({ directories: [], paths: [] }, async (connection) => {
    for (const setup of statementViews(views, { from: null, to: null })) {
      await connection.run(setup);
    }
    try {
      // On its own line, so an error's line number is the statement's line plus one.
      await connection.run(`PREPARE console_bind_check AS\n${statement}`);
    } catch (cause) {
      throw statementError(cause, input.tableNames);
    }
  });
}

function validateRange(request: RunRequest): void {
  const { from, to } = request.range;
  if (from !== null && to !== null && to <= from) {
    throw badRequest('the time range ends before it starts', { field: 'range' });
  }
}

/**
 * A run, for the person who started it. Anyone else is told it does not exist: a run holds query
 * results, and its id is no secret once it is in a shared link. `ownerId` is who is asking - as the
 * run's domain knows them, when it is a function of that domain.
 */
export function getRun(runId: string, ownerId: string | ((domain: string) => string)): Run {
  const run = runs.get(runId);
  if (!run || run.ownerId !== (typeof ownerId === 'function' ? ownerId(run.domain) : ownerId)) {
    throw notFound(`run ${runId} has expired or never existed`, { resource: 'run', id: runId });
  }
  run.touch();
  return run;
}

/** Discard runs nobody has looked at for `runIdleRetentionMs`, with whatever they stored. */
export async function evictIdleRuns(now: number = Date.now()): Promise<number> {
  let evicted = 0;
  for (const [id, run] of runs) {
    if (now - run.lastAccess < config.runIdleRetentionMs) continue;
    runs.delete(id);
    await run.dispose();
    evicted += 1;
  }
  if (evicted > 0) logger.debug({ evicted }, 'idle runs discarded');
  return evicted;
}

/** Test seam. */
export async function resetRuns(): Promise<void> {
  for (const run of runs.values()) await run.dispose();
  runs.clear();
  waiting.length = 0;
  scanning = 0;
  scanningBy.clear();
}
