/**
 * An exploration (docs/design/explore.md §5): a worksheet - the table it is about, the view its
 * workbench holds - and the questions it has asked. The document a store keeps, and a later release
 * saves to the person's account; it holds names, ranges, filters and statements, never rows.
 *
 * No React: the rules are tested as plain functions.
 */

// With their extensions, so `node --test` loads them without the bundler.
import { decodeRange, encodeRange, rangeLabel } from '../data/timeRange.ts';
import { DEFAULT_PAGE_SIZE, readViewState, writeViewState, type WorkbenchView } from '../data/viewState.ts';
import type { BrowseFilter, RunOrder, RunRequest, RunSnapshot, TableRef } from '@shared/types';

/** The document's format: a store keeps it, and a later one migrates it by this. */
export const EXPLORATION_VERSION = 1;
/** Questions an exploration keeps, newest first; the oldest go first. */
export const HISTORY_LIMIT = 50;
/** Explorations open at once: each keeps its workbench mounted. */
export const OPEN_LIMIT = 8;
/** Explorations a browser keeps. */
export const STORED_LIMIT = 100;

/** The view an exploration keeps: its workbench's, the range as it was chosen (`encodeRange`). */
export interface StoredView {
  range: string;
  filters: BrowseFilter[];
  order: RunOrder;
  /** The statement, when the view is one. */
  sql: string | null;
  page: number;
  pageSize: number;
  visibleColumns: string[] | null;
  pinnedColumn: string | null;
  live: boolean;
  /** The run on screen, picked back up after a reload while it lasts. */
  runId: string | null;
}

export interface QuestionOutcome {
  state: 'succeeded' | 'failed' | 'cancelled';
  rows: number | null;
  elapsedMs: number | null;
  /** Why it failed. */
  message: string | null;
}

/** One question an exploration asked: what Run asked, and what it came to. */
export interface Question {
  id: string;
  askedAt: string;
  /** The table it was about; null for a statement over the lake with none. */
  source: TableRef | null;
  kind: 'browse' | 'sql';
  /** The range as it was chosen, `last-7d`: asked again, it means the last seven days then. */
  range: string;
  filters: BrowseFilter[];
  order: RunOrder;
  sql: string | null;
  /** The run that answered it, last: Streaming and Auto re-run put a new one in its place. */
  runId: string | null;
  outcome: QuestionOutcome | null;
}

export interface Exploration {
  id: string;
  version: typeof EXPLORATION_VERSION;
  /** Its name, chosen by the person; null takes one from its last question (`titleOf`). */
  title: string | null;
  createdAt: string;
  updatedAt: string;
  /** The table it is about; null for a statement over the lake, or before one is chosen. */
  source: TableRef | null;
  view: StoredView;
  history: Question[];
}

/** What a list of explorations shows of each, without its whole document. */
export interface ExplorationSummary {
  id: string;
  label: string;
  /** Named by the person, rather than after its last question. */
  named: boolean;
  updatedAt: string;
  source: TableRef | null;
}

export function emptyView(): StoredView {
  return {
    range: 'all',
    filters: [],
    order: 'newest',
    sql: null,
    page: 0,
    pageSize: DEFAULT_PAGE_SIZE,
    visibleColumns: null,
    pinnedColumn: null,
    live: true,
    runId: null,
  };
}

/** The workbench's view of a stored one. */
export function toView(stored: StoredView): WorkbenchView {
  return { ...stored, range: decodeRange(stored.range) };
}

/** A workbench's view, to keep. */
export function fromView(view: WorkbenchView): StoredView {
  return {
    range: encodeRange(view.range),
    filters: view.filters,
    order: view.order,
    sql: view.sql,
    page: view.page,
    pageSize: view.pageSize,
    visibleColumns: view.visibleColumns,
    pinnedColumn: view.pinnedColumn,
    live: view.live,
    runId: view.runId,
  };
}

export function newExploration(
  id: string,
  init: { source?: TableRef | null; view?: Partial<StoredView>; title?: string | null } = {},
  now: number = Date.now(),
): Exploration {
  const at = new Date(now).toISOString();
  return {
    id,
    version: EXPLORATION_VERSION,
    title: init.title ?? null,
    createdAt: at,
    updatedAt: at,
    source: init.source ?? null,
    view: { ...emptyView(), ...init.view },
    history: [],
  };
}

/** A table as an exploration names it: `sales.orders`, its domain left to the tooltip. */
export function shortName(table: TableRef): string {
  return `${table.dataset}.${table.table}`;
}

/** A table's full name, as SQL reads it. */
export function fullName(table: TableRef): string {
  return `${table.domain}.${table.dataset}.${table.table}`;
}

/**
 * A statement in a few words: its SQL from the start, comments and spacing aside. A title, not a
 * parse: a `--` inside a string literal ends it early, which a title can bear.
 */
export function statementSummary(sql: string, length = 48): string {
  const words = sql
    .replace(/\/\*[\s\S]*?(\*\/|$)/g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (words === '') return 'Statement';
  return words.length > length ? `${words.slice(0, length - 1).trimEnd()}…` : words;
}

/** What a question asked, in a few words: `sales.orders · Last 7 days · 2 filters`, or its statement. */
export function describeQuestion(question: Pick<Question, 'kind' | 'source' | 'range' | 'filters' | 'sql'>): string {
  if (question.kind === 'sql') return statementSummary(question.sql ?? '');
  const parts = [question.source ? shortName(question.source) : 'A table', rangeLabel(decodeRange(question.range))];
  if (question.filters.length > 0) parts.push(question.filters.length === 1 ? '1 filter' : `${question.filters.length} filters`);
  return parts.join(' · ');
}

/** An exploration's name: the person's, else its last question's, else its table's. */
export function titleOf(exploration: Pick<Exploration, 'title' | 'history' | 'source' | 'view'>): string {
  if (exploration.title && exploration.title.trim()) return exploration.title.trim();
  const last = exploration.history[0];
  if (last) return describeQuestion(last);
  if (exploration.source) return shortName(exploration.source);
  if (exploration.view.sql !== null && exploration.view.sql.trim() !== '') return statementSummary(exploration.view.sql);
  return 'New exploration';
}

/**
 * Whether a change shows on the exploration around its workbench: the table it is about, whether it
 * writes SQL, its history. A view's edits do not - its statement, filters, page or run are the
 * workbench's to show - so a keystroke renders the workbench and nothing around it.
 */
export function changesWhatIsShown(before: Exploration, next: Exploration): boolean {
  return next.source !== before.source || next.history !== before.history || (next.view.sql === null) !== (before.view.sql === null);
}

export function summaryOf(exploration: Exploration): ExplorationSummary {
  return {
    id: exploration.id,
    label: titleOf(exploration),
    named: Boolean(exploration.title && exploration.title.trim()),
    updatedAt: exploration.updatedAt,
    source: exploration.source,
  };
}

/** Two questions that ask the same thing: Run pressed again asks it again, it does not add one. */
function sameQuestion(left: Question, right: Question): boolean {
  return (
    left.kind === right.kind &&
    left.range === right.range &&
    JSON.stringify(left.source) === JSON.stringify(right.source) &&
    (left.kind === 'sql' ? (left.sql ?? '').trim() === (right.sql ?? '').trim() : JSON.stringify(left.filters) === JSON.stringify(right.filters) && left.order === right.order)
  );
}

/** A question as a run asked it, the range as it was chosen. */
export function questionOf(id: string, request: RunRequest, view: WorkbenchView, run: RunSnapshot, now: number = Date.now()): Question {
  return {
    id,
    askedAt: new Date(now).toISOString(),
    source: request.source ?? null,
    kind: request.kind,
    range: encodeRange(view.range),
    filters: request.kind === 'browse' ? (request.filters ?? []) : [],
    order: request.order ?? 'newest',
    sql: request.kind === 'sql' ? (request.sql ?? '') : null,
    runId: run.id,
    outcome: outcomeOf(run),
  };
}

/** What a run came to, once it has: nothing while it works. */
export function outcomeOf(run: RunSnapshot): QuestionOutcome | null {
  if (run.state === 'running') return null;
  return {
    state: run.state,
    rows: run.state === 'succeeded' || run.rowsReady > 0 ? run.rows : null,
    elapsedMs: run.elapsedMs,
    message: run.error?.message ?? null,
  };
}

/**
 * The exploration with a question asked: first in its history, the oldest let go past the limit. A
 * question the newest one already asked takes its place instead, so pressing Run again adds nothing.
 * Returns the question that is now first, which is the one on screen.
 */
export function recordQuestion(exploration: Exploration, question: Question, now: number = Date.now()): { exploration: Exploration; onScreen: string } {
  const newest = exploration.history[0];
  const history =
    newest && sameQuestion(newest, question)
      ? [{ ...question, id: newest.id }, ...exploration.history.slice(1)]
      : [question, ...exploration.history].slice(0, HISTORY_LIMIT);
  return {
    exploration: { ...exploration, history, updatedAt: new Date(now).toISOString() },
    onScreen: (history[0] as Question).id,
  };
}

/**
 * The exploration with what a run came to: the question it answered, by its run - or, for a run that
 * took the place of another for the same question (Streaming at a commit, Auto re-run), the question
 * on screen. Unchanged when the run answers none of them.
 */
export function settleQuestion(exploration: Exploration, run: RunSnapshot, onScreen: string | null, now: number = Date.now()): Exploration {
  const index = exploration.history.findIndex((question) => question.runId === run.id);
  const at = index >= 0 ? index : exploration.history.findIndex((question) => question.id === onScreen);
  if (at < 0) return exploration;
  const question = exploration.history[at] as Question;
  const outcome = outcomeOf(run);
  if (question.runId === run.id && JSON.stringify(question.outcome) === JSON.stringify(outcome)) return exploration;
  const history = [...exploration.history];
  history[at] = { ...question, runId: run.id, outcome };
  return { ...exploration, history, updatedAt: new Date(now).toISOString() };
}

/** A question back in the composer: its table, range, filters or statement, and the run that answered it. */
export function viewOfQuestion(question: Question, base: StoredView, sameSource: boolean): StoredView {
  return {
    ...base,
    range: question.range,
    filters: question.filters,
    order: question.order,
    sql: question.sql,
    page: 0,
    runId: question.runId,
    // Columns chosen for another table mean nothing for this one.
    visibleColumns: sameSource ? base.visibleColumns : null,
    pinnedColumn: sameSource ? base.pinnedColumn : null,
  };
}

/* ------------------------------------------------------------------------------- share links */

const PART = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const DOMAIN = /^[a-z][a-z0-9_]{0,31}$/;

/** `domain_a.sales.orders` as a reference, or null for anything else. */
export function parseTableName(text: string | null | undefined): TableRef | null {
  const parts = (text ?? '').trim().split('.');
  if (parts.length !== 3) return null;
  const [domain, dataset, table] = parts as [string, string, string];
  if (!DOMAIN.test(domain) || !PART.test(dataset) || !PART.test(table)) return null;
  return { domain, dataset, table };
}

/**
 * A link that reopens a question for whoever may read its tables, with nothing kept on a server:
 * its table by its full name and the view as the Data tab's address carries it. The run is a hint
 * only its starter can follow; anyone else asks the question anew.
 */
export function shareLink(source: TableRef | null, view: StoredView): string {
  const params = writeViewState({ ...toView(view), page: 0, table: null });
  const query = new URLSearchParams();
  if (source) query.set('source', fullName(source));
  for (const [key, value] of params) query.set(key, value);
  // A statement over the lake opens as one, even before anything is typed.
  if (!source && view.sql === null) query.set('sql', '');
  const text = query.toString();
  return `/explore/new${text ? `?${text}` : ''}`;
}

/** What a share link asks for: its table and view. */
export function fromShareLink(params: URLSearchParams): { source: TableRef | null; view: StoredView } {
  const view = readViewState(params);
  const source = parseTableName(params.get('source'));
  return {
    source,
    view: fromView({
      range: view.range,
      filters: source ? view.filters : [],
      order: view.order,
      // A link with no table asks a statement, written or not.
      sql: view.sql ?? (source ? null : ''),
      page: 0,
      pageSize: view.pageSize,
      visibleColumns: source ? view.visibleColumns : null,
      pinnedColumn: source ? view.pinnedColumn : null,
      live: view.live,
      runId: view.runId,
    }),
  };
}

/* -------------------------------------------------------------------------------- documents */

function isRef(value: unknown): value is TableRef {
  if (!value || typeof value !== 'object') return false;
  const ref = value as Record<string, unknown>;
  return typeof ref.domain === 'string' && typeof ref.dataset === 'string' && typeof ref.table === 'string';
}

function isFilter(value: unknown): value is BrowseFilter {
  return Boolean(value) && typeof value === 'object' && typeof (value as BrowseFilter).column === 'string' && typeof (value as BrowseFilter).operator === 'string';
}

function storedView(value: unknown): StoredView {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<StoredView>;
  const base = emptyView();
  return {
    range: typeof raw.range === 'string' ? encodeRange(decodeRange(raw.range)) : base.range,
    filters: Array.isArray(raw.filters) ? raw.filters.filter(isFilter) : base.filters,
    order: raw.order === 'oldest' ? 'oldest' : 'newest',
    sql: typeof raw.sql === 'string' ? raw.sql : null,
    page: Number.isInteger(raw.page) && (raw.page as number) >= 0 ? (raw.page as number) : 0,
    pageSize: Number.isInteger(raw.pageSize) && (raw.pageSize as number) > 0 ? (raw.pageSize as number) : base.pageSize,
    visibleColumns: Array.isArray(raw.visibleColumns) ? raw.visibleColumns.filter((name): name is string => typeof name === 'string') : null,
    pinnedColumn: typeof raw.pinnedColumn === 'string' ? raw.pinnedColumn : null,
    live: raw.live !== false,
    runId: typeof raw.runId === 'string' && /^[0-9a-f-]{36}$/i.test(raw.runId) ? raw.runId : null,
  };
}

function question(value: unknown): Question | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<Question>;
  if (typeof raw.id !== 'string' || (raw.kind !== 'browse' && raw.kind !== 'sql')) return null;
  return {
    id: raw.id,
    askedAt: typeof raw.askedAt === 'string' ? raw.askedAt : new Date(0).toISOString(),
    source: isRef(raw.source) ? { domain: raw.source.domain, dataset: raw.source.dataset, table: raw.source.table } : null,
    kind: raw.kind,
    range: typeof raw.range === 'string' ? raw.range : 'all',
    filters: Array.isArray(raw.filters) ? raw.filters.filter(isFilter) : [],
    order: raw.order === 'oldest' ? 'oldest' : 'newest',
    sql: typeof raw.sql === 'string' ? raw.sql : null,
    runId: typeof raw.runId === 'string' ? raw.runId : null,
    outcome: raw.outcome && typeof raw.outcome === 'object' ? (raw.outcome as QuestionOutcome) : null,
  };
}

/**
 * A stored document as this release reads it, whatever release wrote it; null for what is not one.
 * Read defensively: it comes from the browser's storage, which anything on the page could write.
 */
export function migrate(raw: unknown): Exploration | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<Exploration> & { version?: unknown };
  if (value.version !== EXPLORATION_VERSION || typeof value.id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(value.id)) return null;
  return {
    id: value.id,
    version: EXPLORATION_VERSION,
    title: typeof value.title === 'string' ? value.title : null,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString(),
    source: isRef(value.source) ? { domain: value.source.domain, dataset: value.source.dataset, table: value.source.table } : null,
    view: storedView(value.view),
    history: (Array.isArray(value.history) ? value.history : []).map(question).filter((entry): entry is Question => entry !== null).slice(0, HISTORY_LIMIT),
  };
}
