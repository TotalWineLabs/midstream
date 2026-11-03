import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  HISTORY_LIMIT,
  changesWhatIsShown,
  describeQuestion,
  keptMessage,
  questionParts,
  emptyView,
  fromShareLink,
  fromView,
  migrate,
  newExploration,
  parseTableName,
  questionOf,
  recordQuestion,
  settleQuestion,
  shareLink,
  statementSummary,
  titleOf,
  toView,
  viewOfQuestion,
  type Exploration,
  type Question,
} from './explorations.ts';
import type { RunRequest, RunSnapshot } from '@shared/types';

const ORDERS = { domain: 'domain_a', dataset: 'sales', table: 'orders' };
const PAYMENTS = { domain: 'domain_b', dataset: 'finance', table: 'payments' };
const T0 = Date.parse('2026-11-02T12:00:00Z');

function run(id: string, state: RunSnapshot['state'] = 'succeeded', rows = 42): RunSnapshot {
  return { id, state, rows, rowsReady: rows, elapsedMs: 1_250, error: state === 'failed' ? { code: 'query_failed', message: "Conversion Error: Could not convert string 'alice@example.com' to INT32" } : null } as unknown as RunSnapshot;
}

function asked(exploration: Exploration, request: RunRequest, id: string, runId: string, now = T0): { exploration: Exploration; onScreen: string } {
  const view = { ...toView(exploration.view), range: toView({ ...exploration.view, range: request.rangeLabel === 'Last 7 days' ? 'last-7d' : 'all' }).range };
  return recordQuestion(exploration, questionOf(id, request, view, run(runId), now), now);
}

describe('an exploration', () => {
  it('is named after its last question, its table, or its statement, unless the person named it', () => {
    const fresh = newExploration('e1', {}, T0);
    assert.equal(titleOf(fresh), 'New exploration');
    assert.equal(titleOf(newExploration('e2', { source: ORDERS }, T0)), 'sales.orders');
    assert.equal(titleOf(newExploration('e3', { view: { sql: 'SELECT 1' } }, T0)), 'SELECT 1');
    const browsing = asked(newExploration('e4', { source: ORDERS }, T0), { kind: 'browse', source: ORDERS, range: { from: null, to: null }, rangeLabel: 'Last 7 days', filters: [{ column: 'status', operator: 'eq', value: 'x' }] }, 'q1', 'r1');
    assert.equal(titleOf(browsing.exploration), 'sales.orders · Last 7 days · 1 filter');
    assert.equal(titleOf({ ...browsing.exploration, title: '  Cancelled orders ' }), 'Cancelled orders');
  });

  it('keeps its questions newest first, the same one asked again in its place, at most a limit', () => {
    let exploration = newExploration('e1', { source: ORDERS }, T0);
    const browse: RunRequest = { kind: 'browse', source: ORDERS, range: { from: null, to: null }, rangeLabel: 'All time', filters: [] };
    exploration = asked(exploration, browse, 'q1', 'r1').exploration;
    const again = asked(exploration, browse, 'q2', 'r2');
    assert.equal(again.exploration.history.length, 1, 'Run pressed again asks it again');
    assert.deepEqual([again.onScreen, again.exploration.history[0]?.runId], ['q1', 'r2']);
    let many = again.exploration;
    for (let index = 0; index < HISTORY_LIMIT + 5; index += 1) {
      many = asked(many, { kind: 'sql', source: null, range: { from: null, to: null }, rangeLabel: 'All time', sql: `SELECT ${index}` }, `s${index}`, `rs${index}`).exploration;
    }
    assert.equal(many.history.length, HISTORY_LIMIT);
    assert.equal(many.history[0]?.sql, `SELECT ${HISTORY_LIMIT + 4}`);
  });

  it('settles a question by its run, or the one on screen when another run takes its place', () => {
    const started = asked(newExploration('e1', { source: ORDERS }, T0), { kind: 'browse', source: ORDERS, range: { from: null, to: null }, rangeLabel: 'All time' }, 'q1', 'r1');
    const pending = { ...started.exploration, history: [{ ...(started.exploration.history[0] as Question), outcome: null }] };
    const done = settleQuestion(pending, run('r1', 'succeeded', 7), started.onScreen);
    assert.deepEqual(done.history[0]?.outcome, { state: 'succeeded', rows: 7, elapsedMs: 1_250, message: null });
    // Streaming replaced the run at a commit: the question on screen follows it.
    const followed = settleQuestion(done, run('r9', 'succeeded', 9), started.onScreen);
    assert.deepEqual([followed.history[0]?.runId, followed.history[0]?.outcome?.rows], ['r9', 9]);
    assert.equal(settleQuestion(followed, run('r9', 'succeeded', 9), started.onScreen), followed, 'nothing new, the same document');
    const failed = settleQuestion(followed, run('r10', 'failed', 0), started.onScreen);
    assert.deepEqual([failed.history[0]?.outcome?.state, failed.history[0]?.outcome?.message], ['failed', 'Conversion Error'], 'no value the run read is kept');
    assert.equal(settleQuestion(failed, run('rx'), null), failed, 'a run of no question changes nothing');
  });

  it('puts a question back in the composer, its columns only for the same table', () => {
    const base = { ...emptyView(), visibleColumns: ['status'], pinnedColumn: 'status', pageSize: 250 };
    const question: Question = { id: 'q', askedAt: '', source: ORDERS, kind: 'browse', range: 'last-7d', filters: [], order: 'oldest', sql: null, runId: 'r1', outcome: null };
    assert.deepEqual(viewOfQuestion(question, base, true), { ...base, range: 'last-7d', order: 'oldest', runId: 'r1', page: 0 });
    assert.deepEqual([viewOfQuestion(question, base, false).visibleColumns, viewOfQuestion(question, base, false).pinnedColumn], [null, null]);
  });

  it('shows a change of table, of mode or of history around its workbench, and not a view’s edits', () => {
    const writing = newExploration('e1', { view: { sql: 'SELECT 1' } }, T0);
    const typed = { ...writing, view: { ...writing.view, sql: 'SELECT 12' }, updatedAt: 'later' };
    assert.equal(changesWhatIsShown(writing, typed), false, 'a keystroke renders the workbench alone');
    assert.equal(changesWhatIsShown(writing, { ...writing, view: { ...writing.view, page: 3, runId: 'r2' } }), false);
    assert.equal(changesWhatIsShown(writing, { ...writing, title: 'Named' }), false, 'its name shows on its tab, not in it');
    assert.equal(changesWhatIsShown(writing, { ...writing, view: { ...writing.view, sql: null } }), true);
    assert.equal(changesWhatIsShown(writing, { ...writing, source: ORDERS }), true);
    assert.equal(changesWhatIsShown(writing, asked(writing, { kind: 'sql', source: null, range: { from: null, to: null }, rangeLabel: 'All time', sql: 'SELECT 1' }, 'q1', 'r1').exploration), true);
  });

  it('keeps of a failure only what quotes no data', () => {
    assert.equal(keptMessage({ code: 'query_failed', message: 'Binder Error: Referenced column "x" not found\nLINE 1: SELECT x' }), 'Binder Error');
    assert.equal(keptMessage({ code: 'run_failed', message: "IO Error: could not read 'gs://lake/x.parquet'" }), 'IO Error');
    assert.equal(keptMessage({ code: 'query_failed', message: 'something else' }), null);
    assert.equal(keptMessage({ code: 'bad_request', message: 'There is no table domain_a.sales.x; domain_a.sales holds domain_a.sales.orders.' }), 'There is no table domain_a.sales.x; domain_a.sales holds domain_a.sales.orders.');
    assert.equal(keptMessage(null), null);
  });

  it('leads History with what was asked, the table after it', () => {
    const browse = { kind: 'browse' as const, source: ORDERS, range: 'last-7d', filters: [{ column: 'status', operator: 'eq' as const, value: 'x' }], sql: null };
    assert.deepEqual(questionParts(browse), { asked: 'Last 7 days · 1 filter', statement: false, about: 'sales.orders' });
    assert.equal(describeQuestion(browse), 'sales.orders · Last 7 days · 1 filter', 'a title still names its table first');
    assert.deepEqual(questionParts({ kind: 'sql', source: null, range: 'all', filters: [], sql: 'SELECT 1' }), { asked: 'SELECT 1', statement: true, about: null });
  });

  it('describes a statement in a few words, comments aside', () => {
    assert.equal(statementSummary('-- top statuses\nSELECT status,\n  count(*)\nFROM domain_a.sales.orders /* all */ GROUP BY 1'), 'SELECT status, count(*) FROM domain_a.sales.ord…');
    assert.equal(statementSummary('   '), 'Statement');
    assert.equal(describeQuestion({ kind: 'browse', source: null, range: 'all', filters: [], sql: null }), 'A table · All time');
  });
});

describe('a share link', () => {
  it('carries the table by its full name and the view as the Data tab does, nothing else', () => {
    const view = { ...emptyView(), range: 'last-7d', filters: [{ column: 'status', operator: 'eq' as const, value: 'cancelled' }], order: 'oldest' as const, runId: '0d9e0000-0000-4000-8000-000000000000', page: 3 };
    const link = shareLink(ORDERS, view);
    assert.match(link, /^\/explore\/new\?source=domain_a\.sales\.orders&/);
    const back = fromShareLink(new URL(link, 'http://console').searchParams);
    assert.deepEqual(back.source, ORDERS);
    assert.deepEqual([back.view.range, back.view.filters, back.view.order, back.view.runId, back.view.page], ['last-7d', view.filters, 'oldest', view.runId, 0]);
  });

  it('opens a statement over the lake as one, written or not', () => {
    const blank = fromShareLink(new URL(shareLink(null, emptyView()), 'http://console').searchParams);
    assert.deepEqual([blank.source, blank.view.sql], [null, '']);
    const written = fromShareLink(new URL(shareLink(PAYMENTS, { ...emptyView(), sql: 'SELECT 1' }), 'http://console').searchParams);
    assert.deepEqual([written.source, written.view.sql], [PAYMENTS, 'SELECT 1']);
  });

  it('names a table only as SQL does', () => {
    assert.deepEqual(parseTableName('domain_a.sales.orders'), ORDERS);
    for (const bad of ['sales.orders', 'Domain-A.sales.orders', 'domain_a.sales.orders.x', '', 'domain_a..orders']) assert.equal(parseTableName(bad), null, bad);
  });
});

describe('a stored exploration', () => {
  it('reads back as written', () => {
    const exploration = asked(newExploration('e1', { source: ORDERS }, T0), { kind: 'browse', source: ORDERS, range: { from: null, to: null }, rangeLabel: 'All time' }, 'q1', 'r1').exploration;
    assert.deepEqual(migrate(JSON.parse(JSON.stringify(exploration))), exploration);
  });

  it('is read defensively: another version, or something else, is no exploration', () => {
    assert.equal(migrate({ ...newExploration('e1'), version: 2 }), null);
    assert.equal(migrate('nope'), null);
    assert.equal(migrate({ id: '../x', version: 1 }), null);
    const repaired = migrate({ id: 'e1', version: 1, view: { range: 'junk', filters: [{ nope: 1 }], order: 'sideways', runId: 'not-a-run' }, history: [{ id: 'q', kind: 'x' }] });
    assert.deepEqual([repaired?.view.range, repaired?.view.filters, repaired?.view.order, repaired?.view.runId, repaired?.history], ['all', [], 'newest', null, []]);
  });

  it('keeps the view as the workbench holds it, the range as it was chosen', () => {
    const view = { ...emptyView(), range: 'last-15m', sql: 'SELECT 1' };
    assert.deepEqual(fromView(toView(view)), view);
  });
});
