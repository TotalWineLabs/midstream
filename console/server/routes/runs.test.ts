/**
 * Runs not tied to a materialization (Explore): `POST /api/runs` browses a table named by reference
 * or runs a statement over any tables, with or without a table of its own, and `/api/data/validate`
 * and `/api/data/estimate` answer the editor and the time picker the same way - each table found in
 * its own domain, and checked there.
 *
 * Domain A holds the fixture's orders in `sales`; Domain B its payments in `finance`.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import Fastify, { type FastifyInstance } from 'fastify';

/** What the tail app was asked for, by path. */
const asked: string[] = [];

/** A tail app with nothing past any snapshot: runs read committed rows. */
const tail = createServer((request, response) => {
  asked.push(new URL(request.url ?? '/', 'http://stub').pathname);
  response
    .writeHead(200, {
      'x-tail-rows': '0',
      'x-tail-bytes': '0',
      'x-tail-through': '{}',
      'x-tail-end-offsets': '{}',
      'x-tail-status': 'empty',
      'x-tail-schema-id': '1',
      'x-tail-settling': '0',
      'x-tail-lag-ms': '0',
      'x-tail-state': 'live',
      'x-tail-member': 'tail-app-0',
    })
    .end();
});
await new Promise<void>((resolve) => tail.listen(0, '127.0.0.1', resolve));
const tailUrl = `http://127.0.0.1:${(tail.address() as AddressInfo).port}`;

const dataDir = await mkdtemp(join(tmpdir(), 'console-console-runs-'));
process.env.CONSOLE_DATA_DIR = dataDir;

const { installTestAuth, testPrincipal } = await import('../auth/testing.ts');
const { nobody } = await import('../auth/principal.ts');
const { installTestDomains } = await import('../domains/testing.ts');
const domains = await installTestDomains(['domain_a', 'domain_b'], {
  entries: { domain_a: { tailUrl }, domain_b: { tailUrl } },
});
const a = domains.require('domain_a');
const b = domains.require('domain_b');
const { ConsoleError } = await import('../errors.ts');
const { setObjectReader } = await import('../iceberg/io.ts');
const { setObjectPathResolver } = await import('../data/objects.ts');
const { resetTables } = await import('../iceberg/table.ts');
const { FIXTURE_LOCATION, PAYMENTS_LOCATION, fixturePath, fixtureReader } = await import('../iceberg/testing.ts');
const { resetRuns } = await import('../runs/store.ts');
const { registerDataRoutes, registerRunRoutes } = await import('./data.ts');

import type { CpDetail, CpPrincipal, CpSystemSettings, FleetSnapshot, MaterializationSummary, RunRefresh, RunSnapshot, ScopeEstimate } from '../../shared/types.ts';

const SALES = 'ds-000000000001';
const FINANCE = 'ds-000000000002';
const SHOP = 'mat-a1b2c3d4e5f6';
const BILLING = 'mat-b1b2c3d4e5f6';
/** The fixture's committed rows: orders, and payments. */
const ORDERS = 12;
const PAYMENTS = 6;

const ORDERS_REF = { domain: 'domain_a', dataset: 'sales', table: 'orders' };
const PAYMENTS_REF = { domain: 'domain_b', dataset: 'finance', table: 'payments' };

function detail(id: string, dataset: string, datasetId: string, table: string, location: string): CpDetail {
  return {
    materialization: {
      materialization_id: id,
      name: id,
      tables: [{ name: table, source_topic: table, dataset, dataset_id: datasetId }],
      retired_tables: [],
      source_topics: [table],
      destination_uri: 'gs://lake',
      runtime_mode: 'dedicated',
      namespace: 'midstream',
      datasets: [dataset],
      live_tail: true,
    },
    status: {
      desired_phase: 'running',
      observed_phase: 'running',
      phase_reason: 'runtime_ready',
      phase_message: null,
      last_transition_time: '2026-10-22T00:00:00Z',
      last_heartbeat: null,
      last_resource_observation_time: null,
      runtime_health: { level: 'healthy', reason: 'heartbeat_fresh', message: null },
    },
    runtime_binding: null,
    tables: [
      {
        dataset,
        dataset_id: datasetId,
        name: table,
        source_topic: table,
        identifier: `${dataset}.${table}`,
        location,
        partition_granularity: 'day',
        schema_id: 1,
        current_snapshot_id: null,
        last_commit_at: null,
        valid_through: null,
        totals: {},
        last_error: null,
        state: 'active',
      },
    ],
  } as unknown as CpDetail;
}

function fleet(id: string, tables: string[]): FleetSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    connected: true,
    controlPlaneError: null,
    totals: {} as FleetSnapshot['totals'],
    items: [{ materialization_id: id, name: id, desired_phase: 'running', observed_phase: 'running', tables, source_topics: [] } as unknown as MaterializationSummary],
    series: [],
  };
}

const originals = domains.all().map((domain) => ({
  domain,
  getDetail: domain.live.getDetail.bind(domain.live),
  fleetSnapshot: domain.live.fleetSnapshot.bind(domain.live),
  settings: domain.controlPlane.settings.bind(domain.controlPlane),
}));

before(() => {
  setObjectReader(fixtureReader());
  setObjectPathResolver((uri) => fixturePath(uri));
});

beforeEach(() => {
  asked.length = 0;
  a.live.getDetail = async () => detail(SHOP, 'sales', SALES, 'orders', FIXTURE_LOCATION);
  b.live.getDetail = async () => detail(BILLING, 'finance', FINANCE, 'payments', PAYMENTS_LOCATION);
  a.live.fleetSnapshot = () => fleet(SHOP, ['sales.orders']);
  b.live.fleetSnapshot = () => fleet(BILLING, ['finance.payments']);
  for (const domain of [a, b]) {
    domain.controlPlane.settings = async () => ({ live_tail_enabled: true }) as CpSystemSettings;
    domain.invalidateSystemSettings();
  }
  resetTables();
});

afterEach(async () => {
  for (const original of originals) {
    original.domain.live.getDetail = original.getDetail;
    original.domain.live.fleetSnapshot = original.fleetSnapshot;
    original.domain.controlPlane.settings = original.settings;
  }
  await resetRuns();
});

after(async () => {
  setObjectReader(null);
  setObjectPathResolver(null);
  tail.closeAllConnections();
  tail.close();
  await rm(dataDir, { recursive: true, force: true });
});

const SEE = ['materializations.view', 'materializations.view_details'];
function readerOf(datasetId: string, permissions: string[] = ['data.query', 'data.export']): CpPrincipal {
  return testPrincipal(SEE, { dataset_permissions: { [datasetId]: permissions } });
}

async function app(perDomain: Record<string, CpPrincipal> = { domain_a: readerOf(SALES), domain_b: readerOf(FINANCE) }): Promise<FastifyInstance> {
  const server = Fastify();
  server.setErrorHandler((error: InstanceType<typeof ConsoleError>, _request, reply) =>
    reply.code(error.statusCode ?? 500).send(error instanceof ConsoleError ? error.toBody() : { error: { code: 'internal_error', message: String(error) } }),
  );
  installTestAuth(server, readerOf(SALES), perDomain);
  await registerRunRoutes(server);
  await server.register(async (scope) => registerDataRoutes(scope), { prefix: '/api/d/:domain' });
  return server;
}

function start(server: FastifyInstance, payload: Record<string, unknown>) {
  return server.inject({ method: 'POST', url: '/api/runs', payload: { range: { from: null, to: null }, ...payload } });
}

async function settled(server: FastifyInstance, created: { statusCode: number; body: string; json: () => unknown }): Promise<RunSnapshot> {
  assert.equal(created.statusCode, 201, created.body);
  let run = created.json() as RunSnapshot;
  for (let attempt = 0; run.state === 'running' && attempt < 300; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    run = (await server.inject({ url: `/api/runs/${run.id}` })).json() as RunSnapshot;
  }
  return run;
}

async function rows(server: FastifyInstance, run: RunSnapshot): Promise<Record<string, unknown>[]> {
  return ((await server.inject({ url: `/api/runs/${run.id}/rows?offset=0&limit=100` })).json() as { rows: Record<string, unknown>[] }).rows;
}

const JOIN = 'SELECT o.order_id, o.status, p.amount FROM domain_a.sales.orders o JOIN domain_b.finance.payments p USING (order_id) ORDER BY o.order_id';

describe('a run by table reference', () => {
  it('browses a table wherever it is, and says where it read it, as SQL names it', async () => {
    const server = await app();
    const run = await settled(server, await start(server, { kind: 'browse', source: { domain: 'domain_b', dataset: 'Finance', table: 'PAYMENTS' }, liveTail: false }));
    assert.equal(run.state, 'succeeded', run.error?.message ?? '');
    assert.deepEqual([run.domain, run.materializationId, run.table, run.rows], ['domain_b', BILLING, 'payments', PAYMENTS]);
    assert.deepEqual(run.request.source, PAYMENTS_REF);
    assert.equal(run.request.table, 'payments');
    assert.equal((await rows(server, run)).length, PAYMENTS);
  });

  it('asks for the table’s live tail, unless told not to', async () => {
    const server = await app();
    const run = await settled(server, await start(server, { kind: 'browse', source: PAYMENTS_REF }));
    assert.equal(run.state, 'succeeded', run.error?.message ?? '');
    assert.deepEqual(asked, [`/tail/v1/materializations/${BILLING}/tables/payments`]);
    asked.length = 0;
    await settled(server, await start(server, { kind: 'browse', source: PAYMENTS_REF, liveTail: false }));
    assert.deepEqual(asked, []);
  });

  it('runs a statement with no table of its own, belonging to the first table it names', async () => {
    const server = await app();
    const run = await settled(server, await start(server, { kind: 'sql', sql: JOIN, liveTail: false }));
    assert.equal(run.state, 'succeeded', run.error?.message ?? '');
    assert.deepEqual([run.domain, run.materializationId, run.table, run.request.source ?? null], ['domain_a', SHOP, 'orders', null]);
    assert.deepEqual(
      run.tables.map((table) => `${table.domain}.${table.dataset}.${table.name}`),
      ['domain_a.sales.orders', 'domain_b.finance.payments'],
    );
    assert.equal((await rows(server, run)).length, 6);
  });

  it('runs a statement about a table it does not read, which stays the run’s table', async () => {
    const server = await app();
    const run = await settled(server, await start(server, { kind: 'sql', source: ORDERS_REF, sql: 'SELECT count(*) AS n FROM domain_b.finance.payments', liveTail: false }));
    assert.equal(run.state, 'succeeded', run.error?.message ?? '');
    assert.deepEqual(run.request.source, ORDERS_REF);
    assert.deepEqual(await rows(server, run), [{ n: PAYMENTS }]);
  });

  it('runs a statement that reads no table at all, in the settings home, for the person who asked', async () => {
    const server = await app();
    const run = await settled(server, await start(server, { kind: 'sql', sql: 'SELECT 42 AS answer' }));
    assert.equal(run.state, 'succeeded', run.error?.message ?? '');
    assert.deepEqual([run.domain, run.materializationId, run.table, run.tables], ['domain_a', null, null, []]);
    assert.deepEqual(await rows(server, run), [{ answer: 42 }]);
    const exported = await server.inject({ url: `/api/runs/${run.id}/export?format=csv` });
    assert.equal(exported.statusCode, 200, exported.body);
    assert.match(exported.body, /answer\s+42/);
    const someoneElse = await (await app({ domain_a: testPrincipal(SEE, { user_id: 'usr-other' }), domain_b: readerOf(FINANCE) })).inject({ url: `/api/runs/${run.id}` });
    assert.equal(someoneElse.statusCode, 404, 'a run is its starter’s');
  });

  it('says where to write a table named without its domain, in every domain holding it', async () => {
    b.live.fleetSnapshot = () => fleet(BILLING, ['finance.payments', 'sales.orders']);
    const server = await app();
    const answer = await start(server, { kind: 'sql', sql: 'SELECT * FROM sales.orders' });
    assert.equal(answer.statusCode, 400);
    assert.match(answer.json().error.message, /write domain_a\.sales\.orders or domain_b\.sales\.orders for sales\.orders\./);
    // From a table of Domain B, its own domain comes first.
    const fromB = await start(server, { kind: 'sql', source: PAYMENTS_REF, sql: 'SELECT * FROM iceberg.sales.orders' });
    assert.match(fromB.json().error.message, /write domain_b_iceberg\.sales\.orders or domain_a_iceberg\.sales\.orders for iceberg\.sales\.orders/);
  });

  it('refuses a source it cannot find, saying why', async () => {
    const server = await app();
    const unknown = await start(server, { kind: 'browse', source: { domain: 'domain_z', dataset: 'sales', table: 'orders' } });
    assert.deepEqual([unknown.statusCode, unknown.json().error.code], [404, 'unknown_domain']);
    const malformed = await start(server, { kind: 'browse', source: { domain: 'Domain-A', dataset: 'sales', table: 'orders' } });
    assert.equal(malformed.statusCode, 400);
    const missing = await start(server, { kind: 'browse', source: { domain: 'domain_a', dataset: 'sales', table: 'refunds' } });
    assert.equal(missing.statusCode, 400);
    assert.match(missing.json().error.message, /There is no table domain_a\.sales\.refunds; domain_a\.sales holds domain_a\.sales\.orders/);
    assert.equal(missing.json().error.details.field, 'source');
    const browseWithout = await start(server, { kind: 'browse' });
    assert.equal(browseWithout.statusCode, 400, 'a browse run names its table');
  });

  it('says a domain cannot be reached, rather than that its table is gone', async () => {
    b.live.getDetail = async () => {
      throw new ConsoleError('control_plane_unreachable', 'control plane at http://domain-b.test:6065 is unreachable', 503, { reason: 'unreachable' });
    };
    const server = await app();
    const answer = await start(server, { kind: 'browse', source: PAYMENTS_REF });
    assert.equal(answer.statusCode, 503, answer.body);
    assert.deepEqual([answer.json().error.details.reason, answer.json().error.details.domain], ['domain_unreachable', 'domain_b']);
  });

  it('needs Query data on the source’s dataset in its domain, even for a statement that does not read it', async () => {
    const server = await app({ domain_a: readerOf(SALES), domain_b: readerOf(FINANCE, ['dataset.view_schema']) });
    const browse = await start(server, { kind: 'browse', source: PAYMENTS_REF });
    assert.equal(browse.statusCode, 403, browse.body);
    assert.match(browse.json().error.message, /domain_b\.finance/);
    const about = await start(server, { kind: 'sql', source: PAYMENTS_REF, sql: 'SELECT 1' });
    assert.equal(about.statusCode, 403, about.body);
    const join = await start(server, { kind: 'sql', sql: JOIN });
    assert.equal(join.statusCode, 403, join.body);
  });

  it('asks a guest to sign in', async () => {
    const answer = await start(await app({ domain_a: nobody(), domain_b: nobody() }), { kind: 'browse', source: ORDERS_REF });
    assert.equal(answer.statusCode, 401);
  });

  it('pins only a source to an older snapshot', async () => {
    const answer = await start(await app(), { kind: 'sql', sql: 'SELECT 1', asOf: '123' });
    assert.equal(answer.statusCode, 400);
    assert.match(answer.json().error.message, /asOf/);
  });
});

describe('a materialization’s own run route', () => {
  it('says the run’s table by reference too, so it is refreshed and shared the same way', async () => {
    const server = await app();
    const run = await settled(
      server,
      await server.inject({ method: 'POST', url: `/api/d/domain_a/materializations/${SHOP}/runs`, payload: { kind: 'browse', range: { from: null, to: null }, liveTail: false } }),
    );
    assert.equal(run.state, 'succeeded', run.error?.message ?? '');
    assert.deepEqual(run.request.source, ORDERS_REF);
  });
});

describe('refreshing a run started by reference', () => {
  it('finds its table where it was, even while its domain’s fleet does not list it', async () => {
    const server = await app();
    const run = await settled(server, await start(server, { kind: 'browse', source: ORDERS_REF, liveTail: false }));
    a.live.fleetSnapshot = () => fleet(SHOP, []);
    const answer = await server.inject({ method: 'POST', url: `/api/runs/${run.id}/refresh`, payload: {} });
    assert.equal(answer.statusCode, 200, answer.body);
    assert.equal((answer.json() as RunRefresh).replaced, false);
  });

  it('replaces a statement, by reference as it was asked', async () => {
    const server = await app();
    const run = await settled(server, await start(server, { kind: 'sql', sql: JOIN, liveTail: false }));
    const answer = await server.inject({ method: 'POST', url: `/api/runs/${run.id}/refresh`, payload: {} });
    assert.equal(answer.statusCode, 200, answer.body);
    const refreshed = answer.json() as RunRefresh;
    assert.equal(refreshed.replaced, true);
    assert.notEqual(refreshed.run.id, run.id);
    assert.equal((await settled(server, { statusCode: 201, body: '', json: () => refreshed.run })).rows, 6);
  });

  it('is refused once the person may no longer query a table the statement reads', async () => {
    const run = await settled(await app(), await start(await app(), { kind: 'sql', sql: JOIN, liveTail: false }));
    const answer = await (await app({ domain_a: readerOf(SALES), domain_b: readerOf(FINANCE, ['dataset.view_schema']) })).inject({
      method: 'POST',
      url: `/api/runs/${run.id}/refresh`,
      payload: {},
    });
    assert.equal(answer.statusCode, 403);
  });
});

describe('the editor and the time picker, from Explore', () => {
  it('bind a statement across domains, and point at what is wrong', async () => {
    const server = await app();
    const ok = await server.inject({ method: 'POST', url: '/api/data/validate', payload: { sql: JOIN } });
    assert.equal(ok.statusCode, 200, ok.body);
    const wrong = await server.inject({ method: 'POST', url: '/api/data/validate', payload: { sql: 'SELECT nope FROM domain_b.finance.payments' } });
    assert.equal(wrong.statusCode, 400);
    assert.match(wrong.json().error.message, /nope/);
    const bare = await server.inject({ method: 'POST', url: '/api/data/validate', payload: { sql: 'SELECT * FROM finance.payments', source: ORDERS_REF } });
    assert.match(bare.json().error.message, /write domain_b\.finance\.payments for finance\.payments/);
  });

  it('estimate time ranges over several tables together', async () => {
    const server = await app();
    const answer = await server.inject({
      method: 'POST',
      url: '/api/data/estimate',
      payload: { tables: [ORDERS_REF, PAYMENTS_REF], ranges: [{ from: null, to: null }, { from: 32_000_000_000_000, to: null }] },
    });
    assert.equal(answer.statusCode, 200, answer.body);
    const [all, future] = (answer.json() as { estimates: ScopeEstimate[] }).estimates;
    assert.deepEqual([all?.rows, all?.rowsExact], [ORDERS + PAYMENTS, true]);
    assert.ok((all?.objects ?? 0) >= 2);
    assert.deepEqual([future?.rows, future?.objects], [0, 0]);
  });

  it('estimate only tables the person may query', async () => {
    const server = await app({ domain_a: readerOf(SALES), domain_b: readerOf(FINANCE, ['dataset.view_schema']) });
    const answer = await server.inject({ method: 'POST', url: '/api/data/estimate', payload: { tables: [ORDERS_REF, PAYMENTS_REF], ranges: [{ from: null, to: null }] } });
    assert.equal(answer.statusCode, 403);
  });
});
