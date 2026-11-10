import assert from 'node:assert/strict';
import { test } from 'node:test';

import { groupsDigits, isNumberColumn } from './numberColumns.ts';

test('a number column is right-aligned, a masked or text one is not', () => {
  assert.equal(isNumberColumn({ name: 'total', type: 'DOUBLE' }), true);
  assert.equal(isNumberColumn({ name: 'shipments', type: 'BIGINT' }), true);
  assert.equal(isNumberColumn({ name: 'price', type: 'DECIMAL(10,2)' }), true);
  assert.equal(isNumberColumn({ name: 'carrier', type: 'VARCHAR' }), false);
  assert.equal(isNumberColumn({ name: 'skus', type: 'BIGINT[]' }), false);
  assert.equal(isNumberColumn({ name: 'phone', type: 'BIGINT', protection: { kind: 'phone', mask: 'hash' } }), false);
});

test('a measure’s digits are grouped, an identifier’s and a year’s integers are not', () => {
  const measures: Array<[string, string]> = [['shipments', 'BIGINT'], ['total', 'DOUBLE'], ['amount', 'DECIMAL(18,2)'], ['order_id', 'DOUBLE'], ['rows', 'HUGEINT']];
  for (const [name, type] of measures) {
    assert.equal(groupsDigits({ name, type }), true, `${name} ${type}`);
  }
  const identifiers: Array<[string, string]> = [
    ['order_id', 'BIGINT'],
    ['customer.id', 'INTEGER'],
    ['customerId', 'BIGINT'],
    ['year', 'INTEGER'],
    ['_kafka_offset', 'BIGINT'],
    ['_kafka_partition', 'INTEGER'],
    ['line_number', 'UINTEGER'],
    ['ID', 'BIGINT'],
  ];
  for (const [name, type] of identifiers) {
    assert.equal(groupsDigits({ name, type }), false, `${name} ${type}`);
  }
});
