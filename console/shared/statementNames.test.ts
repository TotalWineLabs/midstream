import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalName, namedTables, nativeCatalog, stripStringsAndComments, unqualifiedReferences } from './statementNames.ts';

describe('the tables a statement names', () => {
  const domains = ['domain_a', 'domain_b'];
  const names = (sql: string): string[] =>
    namedTables(sql, domains).map((reference) => `${reference.native ? 'native:' : ''}${reference.domain}.${reference.dataset}.${reference.table}`);

  it('are named with their domain, logical or native, in any case or quoting, each once', () => {
    assert.deepEqual(names('SELECT * FROM domain_a.shop.payments p JOIN DOMAIN_B.SHOP.ORDERS o ON o.id = p.order_id'), [
      'domain_a.shop.payments',
      'domain_b.shop.orders',
    ]);
    assert.deepEqual(names('SELECT * FROM domain_a_iceberg.shop."Payments" JOIN domain_a . shop . orders USING (id)'), [
      'native:domain_a.shop.payments',
      'domain_a.shop.orders',
    ]);
    assert.deepEqual(names('SELECT domain_a.shop.orders.id FROM domain_a.shop.orders'), ['domain_a.shop.orders'], 'a column after a table is the table’s');
    assert.deepEqual(names('SELECT 42'), []);
  });

  it('are not named in strings or comments, nor by a catalog that is no domain', () => {
    assert.deepEqual(names("SELECT 'domain_b.x.y' AS t FROM domain_a.shop.orders -- domain_b.shop.orders\n/* domain_b.a.b */"), ['domain_a.shop.orders']);
    assert.deepEqual(names('SELECT payload.customer.email FROM elsewhere.shop.orders'), []);
  });

  it('must name their domain: a table named without it is found, to say how to write it', () => {
    const tables = [
      { dataset: 'shop', table: 'orders' },
      { dataset: 'finance', table: 'payments' },
    ];
    assert.deepEqual(unqualifiedReferences('SELECT * FROM shop.orders o JOIN FINANCE.PAYMENTS p USING (id)', tables), ['shop.orders', 'finance.payments']);
    assert.deepEqual(unqualifiedReferences('SELECT * FROM iceberg.shop.orders', tables), ['iceberg.shop.orders']);
    assert.deepEqual(unqualifiedReferences('SELECT o.id, shop.customers FROM domain_a.shop.orders o', tables), [], 'full names and other two-part names pass');
  });

  it('are written as SQL reads them', () => {
    assert.equal(canonicalName('domain_a', 'shop', 'orders'), 'domain_a.shop.orders');
    assert.equal(nativeCatalog('domain_a'), 'domain_a_iceberg');
  });
});

describe('blanking strings and comments', () => {
  it('keeps every position when asked, so a match points into the statement as written', () => {
    const sql = "SELECT 'a.b.c' AS x, \"Q\".y -- note\nFROM d.e.f /* g.h.i */";
    const kept = stripStringsAndComments(sql, { keepLength: true });
    assert.equal(kept.length, sql.length);
    assert.equal(kept.indexOf('d.e.f'), sql.indexOf('d.e.f'));
    assert.ok(!kept.includes('a.b.c') && !kept.includes('g.h.i') && !kept.includes('note'));
    assert.ok(kept.includes('"Q"'), 'quoted identifiers stay');
  });

  it('shrinks otherwise, blanking quoted identifiers too, without joining what they separated', () => {
    assert.equal(stripStringsAndComments('SELECT "a"."b" FROM t'), 'SELECT  x . x  FROM t');
  });
});
