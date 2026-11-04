import assert from 'node:assert/strict';
import { test } from 'node:test';

// Before any date is made: the zone is read when the first one is formatted.
process.env.TZ = 'America/Los_Angeles';

const { displayCell, formatInstant, formatMoment, formatNumberCell, isInstantType } = await import('./format.ts');

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

test('a number in a cell keeps every digit, grouped in the reader’s locale', () => {
  const parts = new Intl.NumberFormat().formatToParts(1234.5);
  const group = parts.find((part) => part.type === 'group')?.value ?? ',';
  const decimal = parts.find((part) => part.type === 'decimal')?.value ?? '.';
  assert.equal(formatNumberCell(45291), `45${group}291`);
  assert.equal(formatNumberCell(186), '186');
  assert.equal(formatNumberCell(-1234.5), `-1${group}234${decimal}5`);
  // A decimal arrives as text with its scale, and an integer past 2^53 as its digits: neither is rounded.
  assert.equal(formatNumberCell('184.60'), `184${decimal}60`);
  assert.equal(formatNumberCell('3729562493443214175'), ['3', '729', '562', '493', '443', '214', '175'].join(group));
  assert.equal(formatNumberCell(0.30000000000000004), `0${decimal}30000000000000004`);
  assert.equal(formatNumberCell(1e21), '1e+21');
  assert.equal(formatNumberCell(Number.NaN), 'NaN');
});
