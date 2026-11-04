/**
 * Number columns in a result's grid: which are numbers, and which of those have their digits
 * grouped (docs/10-design-system.md §10.8).
 */

import type { QueryColumn } from '@shared/types';

const NUMERIC_TYPES = /^(TINY|SMALL|BIG|HUGE)?INT|^DECIMAL|^DOUBLE|^FLOAT|^REAL|^NUMERIC|^UINTEGER|^UBIGINT/i;

/** A list column holds many values per row, so it can be matched but not ordered. */
export function isListType(type: string): boolean {
  return /\[\]$/.test(type) || /^LIST/i.test(type);
}

export function isNumericType(type: string): boolean {
  return !isListType(type) && NUMERIC_TYPES.test(type);
}

/** A column of numbers, as a result's grid sets it: right-aligned, so its values read by magnitude. A masked one is text. */
export function isNumberColumn(column: QueryColumn): boolean {
  return column.protection === undefined && isNumericType(column.type);
}

const INTEGER_TYPES = /^U?(TINY|SMALL|BIG|HUGE)?INT/i;
/** A name that says its column identifies something, or is a year: `order_id`, `customer.id`, `year`, `_kafka_offset`. */
const IDENTIFIER_NAME = /(?:^|[._])(?:id|key|code|year|offset|partition|number|zip|postcode)$/;
const CAMEL_IDENTIFIER_NAME = /[a-z0-9](?:Id|ID|Key|Code|Year)$/;

/**
 * Whether a number column's digits are grouped (`45,291`): a measure's are; an identifier's or a
 * year's integers are not, since `2,026` and `order_id 1,204,551` read wrong and are typed back ungrouped.
 */
export function groupsDigits(column: QueryColumn): boolean {
  if (!isNumberColumn(column)) return false;
  return !(INTEGER_TYPES.test(column.type) && (IDENTIFIER_NAME.test(column.name.toLowerCase()) || CAMEL_IDENTIFIER_NAME.test(column.name)));
}
