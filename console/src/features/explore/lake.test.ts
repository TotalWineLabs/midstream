import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildLake, findTable, lakeTables, searchLake, type LakeInput } from './lake.ts';
import type { Fleet } from '../../lib/fleetMerge.ts';
import type { ConsoleDomain, CpDataset, DomainFleet } from '@shared/types';

function domain(id: string, name: string): ConsoleDomain {
  return { id, name, status: 'ok', connected: true } as ConsoleDomain;
}

function dataset(id: string, name: string, tables: string[], locked = false): CpDataset {
  return { dataset_id: id, name, description: `${name} tables`, tables, locked, permissions: [] } as unknown as CpDataset;
}

function fleetOf(entries: Array<{ domain: string; access?: DomainFleet['access']; items?: Array<{ id: string; tables: string[]; phase?: string }> }>): Fleet {
  const domains = entries.map((entry) => ({ domain: entry.domain, name: entry.domain, access: entry.access ?? 'ok', snapshot: null }) as DomainFleet);
  const items = entries.flatMap((entry) =>
    (entry.items ?? []).map((item) => ({
      domain: entry.domain,
      domainName: entry.domain,
      materialization_id: item.id,
      tables: item.tables,
      source_topics: item.tables.map((table) => `${table.split('.')[1]}-topic`),
      desired_phase: item.phase ?? 'running',
      observed_phase: item.phase ?? 'running',
      phase_reason: 'runtime_ready',
      runtimeHealth: 'healthy',
      lagState: 'caught-up',
      lastHeartbeat: '2026-11-02T12:00:00Z',
    })),
  );
  return { domains, items, hidden: [] } as unknown as Fleet;
}

const DOMAINS = [domain('domain_a', 'Domain A'), domain('domain_b', 'Domain B')];

/** Ana: may query sales in Domain A and see materializations there; nothing in Domain B. */
const can: LakeInput['can'] = (id, permission, datasetId) => {
  if (id !== 'domain_a') return false;
  if (permission === 'materializations.view_details') return true;
  return permission === 'data.query' && datasetId === 'ds-sales';
};

function lake(overrides: Partial<LakeInput> = {}) {
  return buildLake({
    domains: DOMAINS,
    fleet: fleetOf([
      { domain: 'domain_a', items: [{ id: 'mat-shop', tables: ['sales.orders', 'finance.payments'] }] },
      { domain: 'domain_b', access: 'sign_in_required' },
    ]),
    datasets: {
      domain_a: { data: [dataset('ds-sales', 'sales', ['orders', 'returns']), dataset('ds-finance', 'finance', ['payments'], true)], failed: null, loading: false },
      domain_b: { data: undefined, failed: 401, loading: false },
    },
    can,
    ...overrides,
  });
}

describe('the lake', () => {
  it('lists each domain’s datasets and tables by name, with the materialization writing each', () => {
    const [a, b] = lake();
    assert.deepEqual(a?.datasets.map((entry) => [entry.name, entry.tables.map((table) => table.ref.table)]), [
      ['finance', ['payments']],
      ['sales', ['orders', 'returns']],
    ]);
    const orders = findTable(lake(), { domain: 'domain_a', dataset: 'SALES', table: 'Orders' });
    assert.deepEqual([orders?.materializationId, orders?.topic, orders?.status?.kind], ['mat-shop', 'orders-topic', 'flowing']);
    assert.deepEqual([b?.access, b?.datasets], ['sign_in_required', []]);
  });

  it('says what the person may do with each table: query, browse, or only see its name', () => {
    const tables = new Map(lakeTables(lake()).map((table) => [table.key, table]));
    assert.deepEqual(
      [...tables.values()].map((table) => [table.key, table.queryable, table.browsable, table.locked]),
      [
        ['domain_a.finance.payments', false, false, true],
        ['domain_a.sales.orders', true, true, false],
        ['domain_a.sales.returns', true, true, false],
      ],
    );
    // A kept table is listed by its dataset, though the fleet lists only written ones.
    assert.equal(tables.get('domain_a.sales.returns')?.materializationId, null);
    const noDetails = lakeTables(lake({ can: (id, permission, datasetId) => permission !== 'materializations.view_details' && can(id, permission, datasetId) }));
    assert.equal(noDetails.find((table) => table.ref.table === 'orders')?.browsable, false, 'browsing reads the materialization');
  });

  it('falls back to the fleet where the person may not see the datasets', () => {
    const [a] = lake({ datasets: {} });
    assert.deepEqual(a?.datasets.map((entry) => [entry.name, entry.id, entry.tables.map((table) => table.ref.table)]), [
      ['finance', '', ['payments']],
      ['sales', '', ['orders']],
    ]);
  });

  it('leaves out a misconfigured domain, and a deleted materialization’s tables', () => {
    const lakeWithout = buildLake({
      domains: [...DOMAINS, { ...domain('domain_c', 'Domain C'), status: 'misconfigured' }],
      fleet: fleetOf([{ domain: 'domain_a', items: [{ id: 'mat-gone', tables: ['sales.orders'], phase: 'deleted' }] }]),
      datasets: {},
      can,
    });
    assert.deepEqual(lakeWithout.map((entry) => entry.id), ['domain_a', 'domain_b']);
    assert.deepEqual(lakeWithout[0]?.datasets, []);
  });

  it('is loading until its fleet or datasets answer', () => {
    const waiting = buildLake({ domains: DOMAINS, fleet: null, datasets: { domain_a: { data: undefined, failed: null, loading: true } }, can });
    assert.equal(waiting[0]?.loading, true);
  });
});

describe('searching the lake', () => {
  it('finds tables by their name as shown, best first, with what matched', () => {
    const found = searchLake(lake(), 'ord', { qualified: false });
    assert.deepEqual(found.map((match) => [match.shown, match.ranges]), [['sales.orders', [[6, 9]]]]);
    const qualified = searchLake(lake(), 'domain_a sales', { qualified: true });
    assert.deepEqual(qualified.map((match) => match.shown), ['domain_a.sales.orders', 'domain_a.sales.returns']);
    assert.equal(searchLake(lake(), '', { qualified: false, limit: 2 }).length, 2, 'blank: every table, up to the limit');
    assert.deepEqual(searchLake(lake(), 'zebra', { qualified: false }), []);
  });

  it('ranks an exact name and a name’s start ahead of a substring', () => {
    const found = searchLake(lake(), 'payments', { qualified: false });
    assert.deepEqual(found.map((match) => match.shown), ['finance.payments']);
    const starts = searchLake(lake(), 'r', { qualified: false }).map((match) => match.shown);
    assert.deepEqual(starts, ['sales.returns', 'sales.orders'], 'r starts returns, and is only inside orders');
  });
});
