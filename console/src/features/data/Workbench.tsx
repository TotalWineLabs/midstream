import { useQuery } from '@tanstack/react-query';
import { Code2, Columns3, Play, RefreshCw, Square, Table2 } from 'lucide-react';
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';

import { ColumnRail } from './ColumnRail';
import { FilterChips } from './FilterChips';
import { HeadPeek } from './HeadPeek';
import { autoRerunDelay, liveHold, liveTailAvailable, peekDone, tableQueryable, tailNotice, type TailNotice } from './live';
import { Pager } from './Pager';
import type { EditorHandle } from './QueryEditor';
import { ResizeHandle } from './ResizeHandle';
import { RowProperties } from './RowProperties';
import { SqlPanel } from './SqlPanel';
import { MoreActions, type ExtraAction } from './MoreActions';
import { StatusBar } from './StatusBar';
import { TimeRangePicker } from './TimeRangePicker';
import {
  buildColumnLabels,
  defaultVisibleColumns,
  gridOrder,
  groupOf,
  isListType,
  labelFor,
  resolveColumnName,
  type ColumnGroupId,
} from './columns';
import { ALL_TIME, describeInstants, rangeLabel, resolveRange, sameRange, type TimeRangeSpec } from './timeRange';
import { runsByItself, waitsForRun } from './autoRun';
import { refOf, runBelongs, sourceKey, statementTables, type WorkbenchSource } from './scope';
import { useRun, useRunPage } from './useRun';
import type { WorkbenchView } from './viewState';
import { StatusGlyph } from '@/components/Status';
import { DataGrid } from '@/components/DataGrid';
import { useTabShown } from '@/components/TabPanel';
import { useToast } from '@/components/ui/Toast';
import { Button, EmptyState, Panel, Select, Skeleton } from '@/components/ui/primitives';
import { ApiError, api as consoleApi } from '@/lib/api';
import { useConsoleAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { formatMoment, formatTimestamp } from '@/lib/format';
import { useApi, useConsoleConfig, useDomains } from '@/lib/domains';
import { useMinWidth } from '@/lib/media';
import { rootQueryClient } from '@/lib/queryClient';
import { canonicalName } from '@shared/statementNames';
import type {
  BrowseFilter,
  CpTableSpec,
  DetailSnapshot,
  QueryColumn,
  RunOrder,
  RunRequest,
  RunSnapshot,
  StatementPosition,
  TableRef,
} from '@shared/types';
import { readableTables } from '@shared/types';

const SQL_MIN_HEIGHT = 120;
const SQL_MAX_HEIGHT = 640;
const SQL_HEIGHT_KEY = 'console.data.sqlHeight';
const RAIL_MIN_WIDTH = 264;
const RAIL_MAX_WIDTH = 720;
const RAIL_WIDTH_KEY = 'console.data.railWidth';
/** Whether the column list is open: closed until someone opens it, then as they last left it. */
const RAIL_OPEN_KEY = 'console.data.columnsOpen';
const RUN_HINT = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac') ? '⌘↵' : 'Ctrl+↵';

function stored(key: string, min: number, max: number, fallback: number): number {
  try {
    const raw = Number(localStorage.getItem(key));
    if (Number.isFinite(raw) && raw > 0) return Math.min(max, Math.max(min, raw));
  } catch {
    // A browser that blocks storage still gets working panes, just not remembered ones.
  }
  return fallback;
}

function storedOpen(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function remember(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(Math.round(value)));
  } catch {
    /* not remembering a pane size is not worth failing a render over */
  }
}

/**
 * The question the controls describe, keyed so it can be compared with the one on screen.
 *
 * The range is keyed by its label, not its instants: "Last 15 minutes" pressed twice is the same
 * question asked again, which is what Run means. The table is keyed as SQL names it, wherever it is.
 */
function viewKey(view: { table: string; sql: string | null; range: string; filters: BrowseFilter[]; order: RunOrder }): string {
  return view.sql !== null
    ? JSON.stringify({ kind: 'sql', table: view.table, range: view.range, sql: view.sql.trim() })
    : JSON.stringify({ kind: 'browse', table: view.table, range: view.range, filters: view.filters, order: view.order });
}

const NONE: ReadonlySet<string> = new Set();

/** A record's identity in its table, its Kafka partition and offset; null for a row without them. */
function recordKey(row: Record<string, unknown>): string | null {
  const partition = row._kafka_partition;
  const offset = row._kafka_offset;
  if (partition === null || partition === undefined || offset === null || offset === undefined) return null;
  return `${String(partition)}:${String(offset)}`;
}

function requestKey(request: RunRequest): string {
  return viewKey({
    table: sourceKey(request.source ?? null),
    sql: request.kind === 'sql' ? (request.sql ?? '') : null,
    range: request.rangeLabel ?? '',
    filters: request.filters ?? [],
    order: request.order ?? 'newest',
  });
}

/** What a workbench's host may do to it from outside: Explore's tables put their names into a statement. */
export interface WorkbenchHandle {
  /** Put `text` where the statement editor's cursor is. False when it is not writing SQL, or not yet ready. */
  insert: (text: string) => boolean;
}

/** A question as its host hears of it: asked, and what each run on screen came to. */
export type QuestionEvent =
  /** Someone asked it - Run, ⌘↵, a change that ran by itself, the opening view. */
  | { kind: 'asked'; request: RunRequest; view: WorkbenchView; run: RunSnapshot }
  /** The run on screen ended, or another took its place for the same question (Streaming, Auto re-run). */
  | { kind: 'settled'; run: RunSnapshot };

export interface WorkbenchProps {
  /**
   * The table it is about: the one it browses, the one a statement starts from. Null for a
   * statement over the lake with no table chosen (Explore), which leaves SQL the only way to ask.
   */
  source: WorkbenchSource | null;
  /** The source's materialization, live: its tables, schemas, lag and live tail. Null without a source. */
  snapshot: DetailSnapshot | null;
  /** The view it opens with: the address bar's, or an exploration's. */
  initialView: WorkbenchView;
  /**
   * On opening, the view's run is picked back up if it still exists; failing that, the view's
   * question is asked (`run`), or shown waiting for Run (`wait`): a question reopened from History.
   */
  opening?: 'run' | 'wait';
  /** Every change of the view while it is shown, and the view again when it is shown again. */
  onViewChange: (view: WorkbenchView) => void;
  /** Each question asked, and what each of its runs came to. */
  onQuestion?: (event: QuestionEvent) => void;
  /** At the toolbar's left: Explore's From. */
  leading?: ReactNode;
  /** What Share copies, and what its toast and tooltip say of it. */
  share: { link: () => string; title: string; note: string };
  /** Actions the host adds to More actions. */
  actions?: readonly ExtraAction[];
  /** The box it fills: the page gives it a height, so the grid scrolls rather than the page. */
  frameClassName?: string;
  /**
   * Out of sight, follow a running query by asking every few seconds rather than over its event
   * stream, holding no connection open: several explorations each keep one.
   */
  pollWhileHidden?: boolean;
  ref?: Ref<WorkbenchHandle>;
}

/**
 * Data exploration: one way to ask a question of a table, or of the lake.
 *
 * Set a time range, add filters or write SQL, and press Run. Opening it on a table runs the
 * table's preview — every row, newest first, with its exact count — which the table's manifests
 * answer without reading anything, so it is on screen at once at any size. Paging reads one data
 * file's rows directly and the next page is fetched ahead, so turning pages does not wait on a query.
 * Every run reports its progress while it works and its exact row count when it is done, and only
 * then can its result be exported. A statement can read any table the person may query, in any
 * domain, joining them by name. Every run reads each table as it is now: snapshots are not its
 * business.
 *
 * With live tail on (every materialization has it), every run also holds the records past its
 * snapshot, from the live tail, and the browse view's Streaming — on unless turned off — appends
 * what arrives every few seconds while it is seen; a commit replaces the run with one pinned to the
 * new snapshot. A statement gets its tail once, when it runs, and Auto re-run runs it again.
 * Browsing, the rows past the last commit are tinted, and the waterline sits where commits reach
 * (§10.8).
 *
 * Two hosts render it: a table's Data tab, which keeps the view in the address bar, and an
 * exploration on the Explore page, which keeps it in the exploration (docs/design/explore.md).
 */
export function Workbench({
  source,
  snapshot,
  initialView,
  opening = 'run',
  onViewChange,
  onQuestion,
  leading = null,
  share,
  actions = [],
  frameClassName,
  pollWhileHidden = false,
  ref,
}: WorkbenchProps): ReactNode {
  const api = useApi();
  const toast = useToast();
  const consoleAuth = useConsoleAuth();
  const domains = useDomains();
  // The view it opened with; from then on the view is its own, and its host hears of every change.
  const initial = useRef(initialView).current;
  const viewChanged = useRef(onViewChange);
  viewChanged.current = onViewChange;
  const questionHeard = useRef(onQuestion);
  questionHeard.current = onQuestion;

  const materializationId = source?.materializationId ?? null;
  const ref0 = useMemo(() => (source ? refOf(source) : null), [source]);
  const sourceName = sourceKey(ref0);
  // Without a table of its own, a statement is the only way to ask.
  const sqlOnly = source === null;

  // Kept tables too: their topics were removed, but they stay readable in their datasets.
  const materialization = snapshot?.detail?.materialization;
  const tables = useMemo(() => (materialization ? readableTables(materialization) : []), [materialization]);
  // Only the tables whose datasets the person may query can be browsed or named in a statement. Who
  // they are in the source's domain, made once for each session rather than on every frame.
  const sourceDomain = source?.domain ?? null;
  const auth = useMemo(() => (sourceDomain ? consoleAuth.forDomain(sourceDomain) : consoleAuth.overall), [consoleAuth, sourceDomain]);
  const can = auth.can;
  const mayQuery = useCallback((table: CpTableSpec) => can('data.query', table.dataset_id), [can]);
  const queryable = useMemo(() => tables.filter(mayQuery), [tables, mayQuery]);
  // Every other table a statement could name, in this domain and the others (handbook 20): offered
  // by name as the editor completes; each domain decides at run time whether the person may query it.
  const fleetQuery = useQuery({ queryKey: ['fleet-tables'], queryFn: () => consoleApi.fleet(), staleTime: 60_000 }, rootQueryClient);
  const lake = useMemo(
    () =>
      (fleetQuery.data?.domains ?? []).flatMap((entry) =>
        (entry.snapshot?.items ?? [])
          .filter((item) => item.desired_phase !== 'deleted')
          .flatMap((item) =>
            item.tables.map((qualified) => {
              const dot = qualified.indexOf('.');
              return { domain: entry.domain, dataset: qualified.slice(0, dot), name: qualified.slice(dot + 1), materializationId: item.materialization_id };
            }),
          ),
      ),
    [fleetQuery.data],
  );
  const otherTables = useMemo(
    () => lake.filter((table) => !(source && table.domain === source.domain && table.materializationId === materializationId)),
    [lake, source, materializationId],
  );
  const tableName = source?.table ?? '';
  const [range, setRange] = useState<TimeRangeSpec>(initial.range);
  const [filters, setFilters] = useState<BrowseFilter[]>(initial.filters);
  const [order, setOrder] = useState<RunOrder>(initial.order);
  const [sqlMode, setSqlMode] = useState(initial.sql !== null || sqlOnly);
  const [sqlDraft, setSqlDraft] = useState(initial.sql ?? '');
  const [page, setPage] = useState(initial.page);
  const [pageSize, setPageSize] = useState(initial.pageSize);
  const [visibleOverride, setVisibleOverride] = useState<string[] | null>(initial.visibleColumns);
  const [pinnedColumn, setPinnedColumn] = useState<string | null>(initial.pinnedColumn);
  // The rows get the room: the column list opens on request, and stays as it was last left.
  const [railOpen, setRailOpen] = useState(() => storedOpen(RAIL_OPEN_KEY));
  const [railWidth, setRailWidth] = useState(() => stored(RAIL_WIDTH_KEY, RAIL_MIN_WIDTH, RAIL_MAX_WIDTH, RAIL_MIN_WIDTH));
  const [sqlHeight, setSqlHeight] = useState(() => stored(SQL_HEIGHT_KEY, SQL_MIN_HEIGHT, SQL_MAX_HEIGHT, 220));
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  // A row opens in a properties column beside the grid, or over it where the screen is too narrow.
  const wide = useMinWidth(768);
  const [validation, setValidation] = useState<{ sql: string; message: string; position: StatementPosition | null } | null>(null);
  const [live, setLive] = useState(initial.live);
  const [autoRerun, setAutoRerun] = useState(false);
  // A refresh refused for the person's session: Live stops until a new run, or a new sign-in.
  const [liveRefused, setLiveRefused] = useState(false);
  // Bumped after every Live look, success or not, so the next one is scheduled.
  const [liveTick, setLiveTick] = useState(0);
  const [peekOpen, setPeekOpen] = useState(false);
  const pageVisible = useDocumentVisible();
  // A page that keeps its tabs - a table's, Explore's explorations - keeps this one while another is
  // shown (components/TabPanel.tsx): everything here stays as it was, and what it does on its own
  // waits until it is shown again.
  const tabShown = useTabShown();
  const seen = pageVisible && tabShown;
  // The range of the run on screen as chosen, so a run that replaces it slides with "Last 15 minutes".
  const runRange = useRef<TimeRangeSpec>(initial.range);
  const editor = useRef<EditorHandle | null>(null);

  const belongs = useCallback((candidate: RunSnapshot) => runBelongs(candidate, ref0), [ref0]);
  const controller = useRun({ belongs, stream: tabShown || !pollWhileHidden });
  const { run, carried, start, cancel, attach, starting, startError, refresh } = controller;
  // A run Live started to follow a commit works out of sight: the run it replaced stands in for it,
  // so neither the ring nor Stop appears for it — only for a question someone asked.
  const running = starting || (run?.state === 'running' && carried === null);

  const summaryQuery = useQuery({
    queryKey: ['data-summary', materializationId, tableName],
    queryFn: () => api.dataSummary(materializationId as string, tableName),
    // Hidden, it reads nothing; shown again, it reads the summary at once if it has aged.
    enabled: materializationId !== null && tableName !== '' && tabShown,
    refetchInterval: (query) => (query.state.error ? false : 30_000),
    retry: 0,
  });
  // A run Live started when a commit landed reads the table's newest snapshot: the summary, read
  // every 30 s, catches up with it.
  const runSnapshotId =
    run?.tables.find((table) => source !== null && table.domain === source.domain && table.materializationId === materializationId && table.name === tableName)
      ?.snapshotId ?? null;
  useEffect(() => {
    if (runSnapshotId === null || !summaryQuery.data) return;
    if (summaryQuery.data.snapshotId !== runSnapshotId) void summaryQuery.refetch();
    // Once for each snapshot a run reads, not for every answer of the summary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runSnapshotId]);
  // The console config is read again each minute: live tail can be switched off, and on, for every
  // materialization of a domain. The source's domain's part of it says how its tail is.
  const configQuery = useConsoleConfig();
  const domainTail = domains.find((domain) => domain.id === source?.domain)?.liveTail ?? null;
  const summary = summaryQuery.data ?? null;
  const liveTail = domainTail !== null && liveTailAvailable(domainTail.enabled, materialization);
  // A statement over the lake reads each table's tail from its own domain: Auto re-run follows them.
  const tailsAnywhere = domains.some((domain) => domain.liveTail.enabled);
  const autoRerunOffered = source ? liveTail : tailsAnywhere;
  // A table created but with nothing committed yet is queryable through its tail.
  const created = snapshot?.detail?.tables.some((table) => table.name === tableName && table.state === 'active') ?? false;
  const queryableNow = sqlOnly || tableQueryable({ available: summary?.available, liveTail, created });

  const schemaFields = snapshot?.schemas[tableName]?.fields;
  const schemaOrder = useMemo(
    () => [...new Set((schemaFields ?? []).filter((field) => field.kind !== 'metadata').map((field) => field.name))],
    [schemaFields],
  );
  // Every table's columns as the Schema tab names them, for the editor to complete.
  const tableColumns = useMemo(
    () =>
      Object.fromEntries(
        queryable.map((table) => [table.name, (snapshot?.schemas[table.name]?.fields ?? []).filter((field) => field.kind !== 'container').map((field) => field.name)]),
      ),
    [queryable, snapshot?.schemas],
  );
  // The tables a statement names that the lake holds: what its time range bounds.
  const domainIds = useMemo(() => domains.map((domain) => domain.id), [domains]);
  const lakeRefs = useMemo(() => lake.map((table) => ({ domain: table.domain, dataset: table.dataset, table: table.name })), [lake]);
  const named = useMemo(() => (sqlMode ? statementTables(sqlDraft, domainIds, lakeRefs) : []), [sqlMode, sqlDraft, domainIds, lakeRefs]);
  // The time picker counts what the question reads: a statement's tables, or the table on screen.
  const estimated = useMemo<TableRef[]>(() => (named.length > 0 ? named : ref0 ? [ref0] : []), [named, ref0]);

  const draftKey = viewKey({ table: sourceName, sql: sqlMode ? sqlDraft : null, range: rangeLabel(range), filters, order });
  const dirty = run !== null && !starting && draftKey !== requestKey(run.request);
  // The parts of the view a question does not ask, as they are now: its host keeps them with it.
  const presentation = useRef({ pageSize, visibleColumns: visibleOverride, pinnedColumn, live });
  presentation.current = { pageSize, visibleColumns: visibleOverride, pinnedColumn, live };

  const execute = useCallback(
    (overrides: { filters?: BrowseFilter[] } = {}) => {
      // Nothing to ask yet: no table, and no statement.
      if (sqlMode ? sqlDraft.trim() === '' : ref0 === null) return;
      const resolved = resolveRange(range);
      const request: RunRequest = sqlMode
        ? { kind: 'sql', source: ref0, table: tableName || null, range: resolved, rangeLabel: rangeLabel(range), sql: sqlDraft }
        : {
            kind: 'browse',
            source: ref0,
            table: tableName,
            range: resolved,
            rangeLabel: rangeLabel(range),
            filters: overrides.filters ?? filters,
            order,
          };
      setPage(0);
      setDetailIndex(null);
      setLiveRefused(false);
      setPeekOpen(false);
      runRange.current = range;
      const view: WorkbenchView = {
        ...presentation.current,
        range,
        filters: request.filters ?? filters,
        order,
        sql: sqlMode ? sqlDraft : null,
        page: 0,
        runId: null,
      };
      void start(request).then((started) => {
        if (started) questionHeard.current?.({ kind: 'asked', request, view: { ...view, runId: started.id }, run: started });
      });
    },
    [sqlMode, range, sqlDraft, filters, order, tableName, ref0, start],
  );

  // The run on screen ended, or another took its place for the same question: its host hears, once
  // for each - not for every refresh Streaming appends to it.
  const settledKey = run && run.state !== 'running' ? `${run.id}:${run.state}` : null;
  useEffect(() => {
    if (run && settledKey !== null) questionHeard.current?.({ kind: 'settled', run });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledKey]);

  // A changed view runs by itself when it reads little (Settings › Data explorer); a big one says how
  // much it would read and waits for Run. A statement always waits: it is run deliberately.
  const autoRunMaxBytes = configQuery.data?.autoRunMaxBytes ?? 0;
  const browseChanged = dirty && !sqlMode;
  const scopeQuery = useQuery({
    queryKey: ['scope-estimate', sourceName, rangeLabel(range), summary?.asOf ?? null],
    queryFn: () => consoleApi.estimate([ref0 as TableRef], [resolveRange(range)]),
    enabled: browseChanged && autoRunMaxBytes > 0 && ref0 !== null,
    staleTime: 30_000,
    retry: 0,
  });
  const scope = browseChanged ? (scopeQuery.data?.estimates[0] ?? null) : null;
  const autoRun = browseChanged && runsByItself(scope, autoRunMaxBytes);
  // While the size is being asked, the view is neither waiting nor running: say nothing yet.
  const deciding = browseChanged && autoRunMaxBytes > 0 && scope === null && scopeQuery.isFetching;
  useEffect(() => {
    if (!autoRun) return;
    // A moment's pause, so a burst of changes runs once.
    const timer = window.setTimeout(() => execute(), 400);
    return () => window.clearTimeout(timer);
  }, [autoRun, draftKey, execute]);

  // Opening: pick the run of the view back up, or ask the view's question - or, reopened from
  // History, show it waiting for Run.
  const opened = useRef(false);
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (opened.current || !queryableNow) return;
    opened.current = true;
    void (async () => {
      if (initial.runId && (await attach(initial.runId))) return;
      if (opening === 'run' && (sqlMode ? sqlDraft.trim() !== '' : ref0 !== null)) execute();
      else setIdle(true);
    })();
    // Once, when it can first be asked anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryableNow, initial.runId, attach, execute]);
  useEffect(() => {
    if (run !== null || starting) setIdle(false);
  }, [run, starting]);

  // ⌘↵ runs from anywhere in it, and only while it is shown; the editor handles its own and marks
  // the event.
  useEffect(() => {
    if (!tabShown) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter' || event.defaultPrevented) return;
      event.preventDefault();
      execute();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [execute, tabShown]);

  useEffect(() => remember(RAIL_WIDTH_KEY, railWidth), [railWidth]);
  useEffect(() => remember(SQL_HEIGHT_KEY, sqlHeight), [sqlHeight]);
  useEffect(() => {
    try {
      localStorage.setItem(RAIL_OPEN_KEY, railOpen ? '1' : '0');
    } catch {
      /* not remembering it is not worth failing a render over */
    }
  }, [railOpen]);

  // Tell the host the view: every change, and again when shown again. Only while shown: the address
  // bar is the tab on screen's, and this view comes back with this tab.
  useEffect(() => {
    if (!tabShown) return;
    viewChanged.current({
      range,
      filters,
      order,
      sql: sqlMode ? sqlDraft : null,
      page,
      pageSize,
      visibleColumns: visibleOverride,
      pinnedColumn,
      runId: run?.id ?? initial.runId,
      live,
    });
  }, [tabShown, range, filters, order, sqlMode, sqlDraft, page, pageSize, visibleOverride, pinnedColumn, run?.id, initial.runId, live]);

  // Check a statement as it is typed: bound against the views, never run.
  useEffect(() => {
    if (!sqlMode || sqlDraft.trim() === '') {
      setValidation(null);
      return;
    }
    const statement = sqlDraft;
    const timer = setTimeout(() => {
      consoleApi
        .validateSql(statement, ref0)
        .then(() => setValidation(null))
        .catch((error: unknown) => {
          if (error instanceof ApiError && (error.code === 'query_failed' || error.code === 'invalid_request')) {
            setValidation({
              sql: statement,
              message: error.message,
              position: (error.details.position as StatementPosition | undefined) ?? null,
            });
          }
        });
    }, 600);
    return () => clearTimeout(timer);
  }, [sqlMode, sqlDraft, ref0]);

  useImperativeHandle(
    ref,
    () => ({
      insert: (text: string) => {
        if (!sqlMode || !editor.current) return false;
        editor.current.insert(text);
        return true;
      },
    }),
    [sqlMode],
  );

  // While Live's new run counts, the run it replaced holds the same columns.
  const columns = useMemo<QueryColumn[]>(() => run?.columns ?? carried?.columns ?? [], [run?.columns, carried?.columns]);
  // The table on screen completes with the columns its last browse returned, which name forks as
  // the grid does; before one, with its schema's fields.
  const browsedTable = run?.request.kind === 'browse' ? run.table : null;
  const editorColumns = useMemo(
    () => (browsedTable === tableName && columns.length > 0 ? columns.map((column) => column.name) : (tableColumns[tableName] ?? [])),
    [browsedTable, tableName, columns, tableColumns],
  );
  const statementResult = run?.request.kind === 'sql';
  const labels = useMemo(() => buildColumnLabels(columns), [columns]);
  const ordered = useMemo(
    () => (statementResult ? columns : gridOrder(columns, schemaOrder)),
    [statementResult, columns, schemaOrder],
  );

  // A link made before columns dropped the `payload.` root names `payload.status`; once the run's
  // columns are known, every name the view holds is rewritten to the column it means, so the
  // address bar and everything after it use one spelling.
  useEffect(() => {
    if (columns.length === 0) return;
    const resolve = (name: string): string => resolveColumnName(name, columns) ?? name;
    setVisibleOverride((current) => {
      if (current === null) return current;
      const next = current.map(resolve);
      return next.some((name, index) => name !== current[index]) ? next : current;
    });
    setPinnedColumn((current) => (current === null ? current : resolve(current)));
    if (run?.request.kind === 'browse') {
      setFilters((current) => {
        const next = current.map((filter) => ({ ...filter, column: resolve(filter.column) }));
        return next.some((filter, index) => filter.column !== current[index]?.column) ? next : current;
      });
    }
  }, [columns, run?.request.kind]);

  const visible = useMemo(
    () => new Set(statementResult ? columns.map((column) => column.name) : (visibleOverride ?? defaultVisibleColumns(columns))),
    [statementResult, columns, visibleOverride],
  );
  // Browsing: the table's columns the grid leaves out, which the Columns button counts.
  const hiddenColumns = statementResult ? 0 : columns.filter((column) => !visible.has(column.name)).length;
  const gridColumns = useMemo(() => {
    const shown = ordered.filter((column) => visible.has(column.name));
    const pinnedIndex = shown.findIndex((column) => column.name === pinnedColumn);
    if (pinnedIndex <= 0) return shown;
    // Freezing only works against the left edge, so the pinned column moves to the front.
    const pinned = shown[pinnedIndex] as QueryColumn;
    return [pinned, ...shown.slice(0, pinnedIndex), ...shown.slice(pinnedIndex + 1)];
  }, [ordered, visible, pinnedColumn]);

  const pageQuery = useRunPage(run, page * pageSize, pageSize, carried?.id ?? null);
  const rows = useMemo(() => pageQuery.data?.rows ?? [], [pageQuery.data]);
  const closeRow = useCallback(() => setDetailIndex(null), []);
  const stepRow = useCallback(
    (delta: number) =>
      setDetailIndex((current) => {
        if (current === null) return current;
        const next = current + delta;
        return next < 0 || next >= rows.length ? current : next;
      }),
    [rows.length],
  );
  // Rows on screen may still be the previous page's while the next one lands; they keep their own
  // numbering and are shown muted, so a row is never labelled with a position it does not hold.
  const shownOffset = pageQuery.data?.offset ?? page * pageSize;
  // Rows standing in while the same page is read again — the live tail grew, or a commit moved the
  // question to a newer snapshot — are the rows of this page, current to a second ago: they stay as
  // they are, live tint and waterline too, until the new ones replace them. Dimming them on every
  // refresh made the grid flicker. Only another page's rows, or another question's, are dimmed.
  const continuing = pageQuery.data !== undefined && (pageQuery.data.runId === run?.id || pageQuery.data.runId === carried?.id);
  const stale = shownOffset !== page * pageSize || (pageQuery.isPlaceholderData && !continuing);
  // The rows that just arrived on this page of this question: keyed by their records, so the grid
  // can let them settle in and hold the rows someone is reading where they are.
  const shownKeys = useRef<{ question: string; keys: Set<string> } | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(NONE);
  useEffect(() => {
    const data = pageQuery.data;
    if (!data || stale || !run || run.request.kind !== 'browse') return;
    const question = `${requestKey(run.request)}@${data.offset}`;
    const keys = data.rows.map(recordKey).filter((key): key is string => key !== null);
    const before = shownKeys.current;
    shownKeys.current = { question, keys: new Set(keys) };
    if (!before || before.question !== question) return;
    const arrived = keys.filter((key) => !before.keys.has(key));
    // A page that is new from top to bottom is a new page, not an arrival.
    if (arrived.length > 0 && arrived.length < keys.length) setFresh(new Set(arrived));
  }, [pageQuery.data, stale, run]);
  useEffect(() => {
    if (fresh.size === 0) return;
    const timer = window.setTimeout(() => setFresh(NONE), 1_400);
    return () => window.clearTimeout(timer);
  }, [fresh]);

  // What the status line, the grid's states and the pager describe: the run Live replaced, while
  // its continuation counts, so none of them blinks to "Scanning" and back on every commit.
  const shownRun = run?.state === 'running' && carried ? carried : run;
  // Browsing: the rows past the last commit, and where commits reach (§10.8). A page being replaced
  // shows neither: its rows may already have moved.
  const liveRows = useMemo(() => {
    const set = new Set<number>();
    if (stale) return set;
    for (const [from, to] of pageQuery.data?.live ?? []) for (let index = from; index < to; index += 1) set.add(index);
    return set;
  }, [pageQuery.data, stale]);
  // Said by the commit itself, which every row below the line is in: during a backfill the table's
  // "complete through" can trail its newest committed rows by months.
  const committedAt = run?.tables.find((entry) => entry.name === run.table)?.snapshotAt ?? null;
  const waterlineAt = stale ? null : (pageQuery.data?.waterline ?? null);
  const waterline =
    waterlineAt === null
      ? null
      : {
          at: waterlineAt,
          label: committedAt ? `Committed ${formatMoment(committedAt)}` : 'Nothing committed yet',
          title: committedAt
            ? `Rows past the line arrived after the last commit, at ${formatMoment(committedAt)}: they show here first. Every engine reads the rest.`
            : 'Every row here arrived before the table’s first commit: they show here first.',
        };

  const setVisible = useCallback(
    (next: (current: string[]) => string[]) => setVisibleOverride((current) => next(current ?? defaultVisibleColumns(columns))),
    [columns],
  );
  const addFilter = useCallback((filter: BrowseFilter) => setFilters((current) => [...current, filter]), []);

  const enterSql = useCallback(() => {
    setSqlDraft(starterStatement(source ? canonicalName(source.domain, source.dataset, source.table) : tableName, filters, columns));
    setSqlMode(true);
  }, [source, tableName, filters, columns]);

  const editorError = useMemo(() => {
    if (validation && validation.sql === sqlDraft) return validation;
    if (run?.state === 'failed' && run.request.kind === 'sql' && run.request.sql === sqlDraft && run.error) {
      return { message: run.error.message, position: run.error.position ?? null };
    }
    return null;
  }, [validation, sqlDraft, run]);

  // Export needs `data.export` on every table the run reads, each on its dataset, in its domain; a
  // statement that reads none, on its own table, or - with none - somewhere.
  const exportable =
    run !== null &&
    (run.tables.length > 0
      ? run.tables.every((table) => consoleAuth.forDomain(table.domain).can('data.export', table.datasetId))
      : source !== null
        ? consoleAuth.forDomain(source.domain).can('data.export', source.datasetId)
        : consoleAuth.overall.canAnywhere('data.export'));

  const shareView = useCallback((): void => {
    void navigator.clipboard.writeText(share.link());
    toast.success('Link copied', share.note);
  }, [toast, share]);

  // Live: the browse view asks for the tail's newest records every few seconds, while it is seen.
  const liveRefreshMs = domainTail?.refreshMs ?? 1_500;
  const hold = liveHold({
    enabled: liveTail && live && !sqlMode,
    // Out of sight is hidden: streaming catches up when it is back.
    visible: seen,
    run,
    authRefused: liveRefused,
    inspecting: detailIndex !== null,
    page,
  });
  useEffect(() => {
    if (hold !== null || run === null) return;
    const timer = window.setTimeout(() => {
      void refresh(resolveRange(runRange.current))
        .catch((error: unknown) => {
          if (!(error instanceof ApiError)) return;
          if (error.status === 401 || error.status === 403) setLiveRefused(true);
          // The run expired while nobody looked: start the view again.
          else if (error.status === 404 && error.details.resource === 'run') execute();
        })
        .finally(() => setLiveTick((tick) => tick + 1));
    }, liveRefreshMs);
    return () => window.clearTimeout(timer);
    // One look per tick: the run changes with every answer, and must not start a second timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hold, run?.id, liveTick, liveRefreshMs]);

  // A statement's Auto re-run: a new run a few seconds after the last one finished.
  useEffect(() => {
    const delay = autoRerunDelay({ enabled: autoRerunOffered && sqlMode && autoRerun, visible: seen, run, dirty });
    if (delay === null) return;
    const timer = window.setTimeout(() => {
      void refresh(resolveRange(runRange.current)).catch((error: unknown) => {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) setAutoRerun(false);
      });
    }, delay);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRerunOffered, sqlMode, autoRerun, seen, run?.id, run?.state, dirty]);

  // What it says of Live, on the status line: a muted word, or a warning in amber at its right.
  // The warning describes the table, not one run, so it stays while a run that Live started at a
  // commit works, rather than leaving and coming back.
  // How far the table's topic is ahead of the table, as the Overview measures it: the backlog's
  // count follows it at the Overview's pace, whether or not Live refreshes the run.
  const tableTopic = tables.find((table) => table.name === tableName)?.source_topic;
  const topicLag = tableTopic ? (snapshot?.detail?.status.consumer_lag?.topics?.[tableTopic]?.total_lag ?? null) : null;
  const notice = liveTail
    ? tailNotice(run?.tail, { live: live && !sqlMode, hold, maxRows: domainTail?.maxRows ?? null, lag: topicLag })
    : null;
  const [liveWarning, setLiveWarning] = useState<TailNotice | null>(null);
  const runFinished = run !== null && run.state !== 'running';
  const warningKey = notice?.tone === 'warning' ? JSON.stringify(notice) : null;
  useEffect(() => {
    if (!liveTail) setLiveWarning(null);
    else if (runFinished) setLiveWarning(warningKey === null ? null : (JSON.parse(warningKey) as TailNotice));
  }, [liveTail, runFinished, warningKey]);

  // The peek is about a backlogged table: closed once a finished run has caught up with the head.
  const peekNoLongerNeeded = peekDone(run);
  useEffect(() => {
    if (peekNoLongerNeeded) setPeekOpen(false);
  }, [peekNoLongerNeeded]);
  const closePeek = useCallback(() => setPeekOpen(false), []);

  if (!sqlOnly && summaryQuery.isPending) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10" />
        <Skeleton className="h-[560px]" />
      </div>
    );
  }

  if (!queryableNow) {
    const failure = summaryQuery.error;
    const reason = failure instanceof ApiError ? failure.details.reason : undefined;
    return (
      <Panel>
        <EmptyState
          icon={<Table2 className="size-6" />}
          title={failure ? `${tableName || 'The table'} is not readable` : 'No data to query yet'}
          description={
            failure
              ? failure instanceof ApiError
                ? `${failure.message}${typeof reason === 'string' ? `: ${reason}` : ''}`
                : 'The console could not read this table.'
              : 'Rows appear here once the first records are saved.'
          }
          action={
            <Button onClick={() => void summaryQuery.refetch()}>
              <RefreshCw className="size-4" />
              {failure ? 'Retry' : 'Check again'}
            </Button>
          }
        />
      </Panel>
    );
  }

  const rowsOnPage = rows.length;
  const browseRun = run?.request.kind === 'browse';
  const openRow = detailIndex !== null ? rows[detailIndex] : undefined;
  const rowProperties = openRow ? (
    <RowProperties
      row={openRow}
      columns={ordered}
      schemaOrder={schemaOrder}
      index={page * pageSize + (detailIndex ?? 0)}
      total={run?.rows ?? rows.length}
      live={detailIndex !== null && liveRows.has(detailIndex)}
      sheet={!wide}
      onClose={closeRow}
      onStep={stepRow}
      onFilter={
        sqlMode
          ? undefined
          : (filter) => {
              addFilter(filter);
              setDetailIndex(null);
            }
      }
    />
  ) : null;

  return (
    <>
      <div className={cn('flex flex-col gap-2', frameClassName)}>
        {sqlMode ? (
          <>
            <Panel className="flex shrink-0 flex-col overflow-hidden" style={{ height: sqlHeight }}>
              <SqlPanel
                sql={sqlDraft}
                tableName={tableName}
                domain={source?.domain ?? ''}
                tables={queryable}
                otherTables={otherTables}
                tableColumns={tableColumns}
                rangeLabel={rangeLabel(range)}
                columns={editorColumns}
                error={editorError}
                onChange={setSqlDraft}
                onRun={() => execute()}
                onExit={sqlOnly ? null : () => setSqlMode(false)}
                autoRerun={autoRerunOffered ? { on: autoRerun, onChange: setAutoRerun } : null}
                named={named}
                editorRef={editor}
              />
            </Panel>
            <ResizeHandle
              label="Resize the query editor"
              value={sqlHeight}
              min={SQL_MIN_HEIGHT}
              max={SQL_MAX_HEIGHT}
              onResize={(delta) => setSqlHeight((current) => Math.min(SQL_MAX_HEIGHT, Math.max(SQL_MIN_HEIGHT, current + delta)))}
            />
          </>
        ) : null}

        <Panel className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {running ? <span className="run-ring" aria-hidden /> : null}

          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-3 py-2">
            {leading}
            {/* Named, with what it hides: a list nobody has to keep closing, and easy to find. */}
            <Button
              size="sm"
              variant="ghost"
              className={cn('h-8 shrink-0 gap-1.5 px-2 text-[12px]', railOpen && 'bg-[var(--color-raised)] text-[var(--color-ink)]')}
              onClick={() => setRailOpen((value) => !value)}
              aria-pressed={railOpen}
              title={railOpen ? 'Close the column list' : 'Choose columns, and see what each holds'}
            >
              <Columns3 className="size-3.5" />
              Columns
              {hiddenColumns > 0 ? <span className="numeric font-normal text-[var(--color-ink-faint)]">{hiddenColumns} hidden</span> : null}
            </Button>

            <TimeRangePicker tables={estimated} value={range} onChange={setRange} summary={summary} />

            {sqlMode ? (
              sqlOnly ? null : <span className="text-[12px] text-[var(--color-ink-muted)]">Writing SQL — filters are part of the statement.</span>
            ) : (
              <>
                <Select
                  value={order}
                  onChange={(event) => setOrder(event.target.value as RunOrder)}
                  aria-label="Row order"
                  className="h-8 w-[136px] shrink-0 text-[12px]"
                >
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                </Select>
                <FilterChips
                  columns={ordered}
                  labels={labels}
                  filters={filters}
                  onChange={setFilters}
                  runId={browseRun ? (run?.id ?? null) : null}
                />
              </>
            )}

            <span className="ml-auto flex shrink-0 items-center gap-2">
              {liveTail && !sqlMode ? (
                // The rows stream in: the flowing wave drifts while they do, rests while they wait.
                <button
                  type="button"
                  aria-pressed={live}
                  onClick={() => setLive((value) => !value)}
                  title={
                    live
                      ? hold === null
                        ? 'Streaming: new records appear as they arrive. Click to stop.'
                        : 'Streaming waits — the line below says why. Click to stop.'
                      : 'Stream new records in as they arrive'
                  }
                  className={cn(
                    'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-2 text-[12px] transition-colors',
                    live ? 'font-medium text-[var(--color-current-ink)]' : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-raised)]',
                  )}
                  data-role="live-toggle"
                >
                  <StatusGlyph
                    status={{ kind: 'flowing', moving: false }}
                    animate={live && hold === null}
                    color={live ? undefined : 'var(--color-ink-faint)'}
                  />
                  Streaming
                </button>
              ) : null}
              {sqlMode ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 px-2 text-[12px]"
                  onClick={enterSql}
                  title={tables.length > 1 ? 'Write SQL against this table, or join it with the others' : 'Write SQL against this data'}
                >
                  <Code2 className="size-3.5" />
                  SQL
                </Button>
              )}
              <button
                type="button"
                onClick={running ? cancel : () => execute()}
                disabled={starting}
                title={running ? 'Stop the running query' : `Run (${RUN_HINT})`}
                data-role="run"
                className={cn(
                  'relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-3.5 text-[12px] font-medium text-[var(--color-on-primary)] transition-opacity',
                  'bg-[var(--color-primary)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ink)]',
                  (dirty || idle) && !running && !autoRun && 'ring-2 ring-[var(--color-line-strong)] ring-offset-1 ring-offset-[var(--color-surface)]',
                )}
              >
                {running ? <Square className="size-3 fill-current" /> : <Play className="size-3.5 fill-current" />}
                {running ? 'Stop' : 'Run'}
              </button>
              <MoreActions
                run={run}
                config={configQuery.data ?? null}
                exportable={exportable}
                onShare={shareView}
                shareTitle={share.title}
                onPeek={liveWarning?.peek && run?.request.kind === 'browse' ? () => setPeekOpen(true) : null}
                extra={actions}
              />
            </span>
          </div>

          <StatusBar
            run={shownRun}
            starting={starting}
            idle={idle}
            summary={summary}
            dirty={dirty && !autoRun && !deciding}
            waiting={waitsForRun(scope, autoRunMaxBytes)}
            onRerun={() => execute()}
            tailNotice={notice?.tone === 'muted' ? notice : null}
            warning={liveWarning}
          />

          <div className="flex min-h-0 flex-1">
            {railOpen ? (
              <>
                <ColumnRail
                  columns={ordered}
                  labels={labels}
                  schemaOrder={schemaOrder}
                  visible={visible}
                  onToggle={(column) =>
                    setVisible((current) => (current.includes(column) ? current.filter((name) => name !== column) : [...current, column]))
                  }
                  onShowOnly={(column) => setVisibleOverride([column])}
                  pinnedColumn={pinnedColumn}
                  onPin={(column) => {
                    setPinnedColumn(column);
                    // Freezing a hidden column would do nothing, so pinning also reveals it.
                    if (column !== null && !visible.has(column)) setVisible((current) => [...current, column]);
                  }}
                  onSetGroup={(group: ColumnGroupId, show) =>
                    setVisible((current) => {
                      const inGroup = columns.filter((column) => groupOf(column.name) === group).map((column) => column.name);
                      return show ? [...new Set([...current, ...inGroup])] : current.filter((name) => !inGroup.includes(name));
                    })
                  }
                  runId={run && run.state !== 'failed' ? run.id : null}
                  onFilter={sqlMode ? undefined : addFilter}
                  width={railWidth}
                />
                <ResizeHandle
                  orientation="vertical"
                  label="Resize the column list"
                  value={railWidth}
                  min={RAIL_MIN_WIDTH}
                  max={RAIL_MAX_WIDTH}
                  onResize={(delta) => setRailWidth((current) => Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, current + delta)))}
                />
              </>
            ) : null}

            <div className="flex min-w-0 flex-1 flex-col">
              <div className="relative flex min-h-0 flex-1 flex-col">
                {peekOpen && run && materializationId !== null ? (
                  <HeadPeek
                    materializationId={materializationId}
                    table={run.table ?? tableName}
                    refreshMs={liveRefreshMs}
                    visible={seen}
                    schemaOrder={schemaOrder}
                    onClose={closePeek}
                  />
                ) : null}
                <GridArea
                  run={shownRun}
                  idle={idle}
                  startError={startError}
                  loading={pageQuery.isLoading || (shownRun?.state === 'running' && rowsOnPage === 0)}
                  pageError={pageQuery.error}
                  columns={gridColumns}
                  rows={rows}
                  rowOffset={shownOffset}
                  stale={stale}
                  labels={labels}
                  pinnedColumn={statementResult ? null : pinnedColumn}
                  live={liveRows}
                  waterline={waterline}
                  rowKey={statementResult ? undefined : recordKey}
                  fresh={fresh}
                  range={range}
                  hasFilters={!sqlMode && filters.length > 0}
                  summarySpan={
                    summary?.timeMin && summary.timeMax
                      ? `${formatTimestamp(summary.timeMin)} to ${formatTimestamp(summary.timeMax)}`
                      : null
                  }
                  onExpand={setDetailIndex}
                  selectedIndex={detailIndex}
                  onCopy={(column, value) => {
                    void navigator.clipboard.writeText(value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));
                    toast.success('Copied', labelFor(labels, column).display);
                  }}
                  onSearchAllTime={() => setRange(ALL_TIME)}
                />
              </div>
              <Pager
                run={shownRun}
                page={page}
                pageSize={pageSize}
                onPage={(next) => {
                  setPage(next);
                  setDetailIndex(null);
                }}
                onPageSize={(size) => {
                  setPageSize(size);
                  setPage(0);
                }}
              />
            </div>
            {rowProperties && wide ? rowProperties : null}
          </div>
        </Panel>
      </div>

      {/* A sheet covers the page from outside the tab: a hidden tab keeps its row open without it. */}
      {rowProperties && !wide && tabShown ? rowProperties : null}
    </>
  );
}

/**
 * The grid, or what to say instead of it.
 *
 * "No rows" is never left unexplained: an empty range says where the data actually is, and offers
 * the range that has it.
 */
function GridArea({
  run,
  idle,
  startError,
  loading,
  pageError,
  columns,
  rows,
  rowOffset,
  stale,
  labels,
  pinnedColumn,
  live,
  waterline,
  rowKey,
  fresh,
  range,
  hasFilters,
  summarySpan,
  onExpand,
  selectedIndex,
  onCopy,
  onSearchAllTime,
}: {
  run: ReturnType<typeof useRun>['run'];
  /** Nothing asked yet: a question waiting for Run. */
  idle: boolean;
  startError: ApiError | null;
  loading: boolean;
  pageError: unknown;
  columns: QueryColumn[];
  rows: Record<string, unknown>[];
  rowOffset: number;
  stale: boolean;
  labels: ReturnType<typeof buildColumnLabels>;
  pinnedColumn: string | null;
  live: ReadonlySet<number>;
  waterline: { at: number; label: string; title: string } | null;
  rowKey: ((row: Record<string, unknown>) => string | null) | undefined;
  fresh: ReadonlySet<string>;
  range: TimeRangeSpec;
  hasFilters: boolean;
  summarySpan: string | null;
  onExpand: (index: number) => void;
  /** The row open beside the grid, if any. */
  selectedIndex: number | null;
  onCopy: (column: string, value: unknown) => void;
  onSearchAllTime: () => void;
}): ReactNode {
  if (startError) {
    return <Failure title="The query could not start" description={startError.message} />;
  }
  if (idle && !run) {
    return (
      <EmptyState
        icon={<Play className="size-6" />}
        title="Not run yet"
        description={`Press Run, or ${RUN_HINT}, to see its rows.`}
        className="py-20"
      />
    );
  }
  if (run?.state === 'failed') {
    return (
      <Failure
        title={run.request.kind === 'sql' ? 'The statement failed' : 'The query failed'}
        description={run.error?.message ?? 'Unknown error'}
      />
    );
  }
  if (pageError) {
    return <Failure title="This page could not be read" description={pageError instanceof Error ? pageError.message : String(pageError)} />;
  }
  if (run && run.state !== 'running' && run.rows === 0) {
    const scoped = !sameRange(range, ALL_TIME);
    return (
      <EmptyState
        icon={<Table2 className="size-6" />}
        title={run.state === 'cancelled' ? 'Cancelled before any rows were found' : 'No rows match'}
        description={
          run.request.kind === 'sql'
            ? 'The statement returned no rows.'
            : scoped
              ? `Nothing has a Kafka timestamp in ${describeInstants(run.request.range)}${hasFilters ? ' that passes these filters' : ''}.${summarySpan ? ` Records span ${summarySpan}.` : ''}`
              : 'No row passes these filters. Remove one, or widen the time range.'
        }
        action={
          scoped && run.request.kind === 'browse' ? (
            <Button size="sm" variant="secondary" onClick={onSearchAllTime}>
              Use All time
            </Button>
          ) : undefined
        }
        className="py-20"
      />
    );
  }
  if (columns.length === 0 && run && run.columns && run.columns.length > 0) {
    return (
      <EmptyState
        icon={<Table2 className="size-6" />}
        title="No columns selected"
        description="Pick columns in the list on the left to see rows."
        className="py-20"
      />
    );
  }
  // A placeholder grid would promise rows that may never come; say what the scan has found so far.
  if (run?.state === 'running' && run.request.kind === 'browse' && run.rows === 0 && run.progress.objectsDone > 0) {
    return (
      <EmptyState
        icon={<Table2 className="size-6" />}
        title="No matching rows yet"
        description="Still scanning. Rows appear here as soon as one matches."
        className="py-20"
      />
    );
  }
  if (rows.length === 0 && (loading || !run || run.state === 'running')) {
    return <LoadingRows />;
  }
  return (
    <DataGrid
      columns={columns}
      rows={rows}
      onRowExpand={onExpand}
      selectedIndex={selectedIndex}
      rowNumberOffset={rowOffset}
      dimmed={stale}
      labels={labels}
      pinnedColumn={pinnedColumn}
      onCellClick={onCopy}
      live={live}
      waterline={waterline}
      rowKey={rowKey}
      fresh={fresh}
      emptyMessage="No rows on this page"
    />
  );
}

/** Whether the page is being seen: a hidden tab follows nothing. */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const onChange = (): void => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

function LoadingRows(): ReactNode {
  return (
    <div className="space-y-2 p-3" aria-label="Loading rows">
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton key={index} className="h-6" />
      ))}
    </div>
  );
}

/** Why the grid has no rows to show: a run that failed to start, or a page that could not be read. */
function Failure({ title, description }: { title: string; description: string }): ReactNode {
  return (
    <div role="alert" className="m-3 rounded-[var(--radius-control)] bg-[var(--color-flare-wash)] px-3 py-2.5">
      <p className="text-[12px] font-medium text-[var(--color-flare-ink)]">{title}</p>
      <p className="numeric mt-1 text-[12px] whitespace-pre-wrap text-[var(--color-ink)]">{description}</p>
    </div>
  );
}

/**
 * A statement to start from: the filters already chosen, written out, over the table on screen by
 * its full name, `domain_a.shop.orders` (handbook 20).
 *
 * The time range is not written in, because it already bounds the table itself.
 */
function starterStatement(tableName: string, filters: BrowseFilter[], columns: QueryColumn[]): string {
  const conditions = filters.map((filter) => filterSql(filter, columns.find((column) => column.name === filter.column)?.type ?? ''));
  const where = conditions.length > 0 ? `\nWHERE ${conditions.join('\n  AND ')}` : '';
  return `SELECT *\nFROM ${tableName}${where}\nLIMIT 1000`;
}

function filterSql(filter: BrowseFilter, type: string): string {
  const column = `"${filter.column.replace(/"/g, '""')}"`;
  const literal = `'${(filter.value ?? '').replace(/'/g, "''")}'`;
  const like = (pattern: string): string => `CAST(${column} AS VARCHAR) ILIKE '${pattern.replace(/'/g, "''")}'`;
  const escaped = (filter.value ?? '').replace(/[\\%_]/g, (match) => `\\${match}`);
  switch (filter.operator) {
    case 'is_null':
      return `${column} IS NULL`;
    case 'is_not_null':
      return `${column} IS NOT NULL`;
    case 'contains':
      return like(`%${escaped}%`);
    case 'starts_with':
      return like(`${escaped}%`);
    case 'eq':
      return isListType(type) ? `list_contains(${column}, ${literal})` : `${column} = ${literal}`;
    case 'neq':
      return isListType(type) ? `NOT list_contains(${column}, ${literal})` : `${column} <> ${literal}`;
    case 'gt':
      return `${column} > ${literal}`;
    case 'gte':
      return `${column} >= ${literal}`;
    case 'lt':
      return `${column} < ${literal}`;
    case 'lte':
      return `${column} <= ${literal}`;
  }
}
