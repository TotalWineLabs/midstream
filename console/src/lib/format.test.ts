import assert from 'node:assert/strict';
import { test } from 'node:test';

// Before any date is made: the zone is read when the first one is formatted.
process.env.TZ = 'America/Los_Angeles';

const { displayCell, formatInstant, formatMoment, isInstantType } = await import('./format.ts');

test('a moment says its day only when it is not today, and its year only when not this one', () => {
  const now = new Date('2026-11-01T22:00:00Z');
  assert.match(formatMoment('2026-11-01T22:41:04Z', now), /^2:41:04\sPM$/);
  assert.match(formatMoment('2026-10-31T21:41:04Z', now), /^Oct 31, 2:41:04\sPM$/);
  assert.match(formatMoment('2025-10-31T21:41:04Z', now), /^Oct 31, 2025, 2:41:04\sPM$/);
  assert.equal(formatMoment(null, now), '—');
});

test('instants render in local time with milliseconds', () => {
  assert.equal(formatInstant('2026-10-04T23:59:58.604Z'), '2026-10-04 16:59:58.604');
  // Standard time in January: the offset follows the instant, not today.
  assert.equal(formatInstant('2026-01-15T08:00:00.000Z'), '2026-01-15 00:00:00.000');
  assert.equal(formatInstant('not a time'), 'not a time');
});

test('only zoned timestamps are treated as instants', () => {
  assert.equal(isInstantType('TIMESTAMP WITH TIME ZONE'), true);
  assert.equal(isInstantType('TIMESTAMPTZ'), true);
  assert.equal(isInstantType('TIMESTAMP'), false);
  assert.equal(isInstantType('VARCHAR'), false);
  assert.equal(isInstantType(null), false);
  assert.equal(displayCell('2026-10-04T23:59:58.604Z', 'TIMESTAMP WITH TIME ZONE'), '2026-10-04 16:59:58.604');
  assert.equal(displayCell('2026-10-04T23:59:58.604Z', 'VARCHAR'), '2026-10-04T23:59:58.604Z');
  assert.equal(displayCell(42, 'BIGINT'), '42');
  assert.equal(displayCell({ a: 1 }, 'STRUCT(a INTEGER)'), '{"a":1}');
});
