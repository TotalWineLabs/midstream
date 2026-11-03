import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runBelongs, sameTable, sourceKey, statementTables } from './scope.ts';
import type { RunSnapshot } from '@shared/types';

const ORDERS = { domain: 'domain_a', dataset: 'sales', table: 'orders' };
const run = (request: Partial<RunSnapshot['request']>): RunSnapshot => ({ request: { kind: 'browse', range: { from: null, to: null }, ...request } }) as RunSnapshot;

describe('what a workbench is about', () => {
  it('names a table as SQL compares names', () => {
    assert.equal(sourceKey(ORDERS), 'domain_a.sales.orders');
    assert.equal(sourceKey(null), '');
    assert.ok(sameTable(ORDERS, { domain: 'domain_a', dataset: 'Sales', table: 'ORDERS' }));
    assert.ok(!sameTable(ORDERS, { domain: 'domain_b', dataset: 'sales', table: 'orders' }));
  });

  it('picks back up only a run about its table - or, with none, a statement with none', () => {
    assert.ok(runBelongs(run({ source: ORDERS }), ORDERS));
    assert.ok(!runBelongs(run({ source: { ...ORDERS, table: 'returns' } }), ORDERS), 'another table of the same materialization');
    assert.ok(!runBelongs(run({ source: null }), ORDERS));
    assert.ok(runBelongs(run({ kind: 'sql', source: null }), null));
    assert.ok(!runBelongs(run({ kind: 'browse', source: null }), null));
    assert.ok(!runBelongs(run({ kind: 'sql', source: ORDERS }), null));
  });

  it('reads the tables a statement names that the lake holds, each once', () => {
    const lake = [ORDERS, { domain: 'domain_b', dataset: 'finance', table: 'payments' }];
    const sql = 'SELECT * FROM domain_a.sales.orders o JOIN domain_b.finance.payments p USING (id) JOIN domain_a.sales.ORDERS x USING (id) JOIN domain_a.sales.nope n USING (id)';
    assert.deepEqual(statementTables(sql, ['domain_a', 'domain_b'], lake), lake);
    assert.deepEqual(statementTables('SELECT 1', ['domain_a'], lake), []);
  });
});
