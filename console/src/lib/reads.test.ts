import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readFailed } from './reads.ts';

/** An error as the API client throws one, with the answer's status. */
function answered(status: number): Error {
  return Object.assign(new Error(`answered ${status}`), { status });
}

const dataset = { name: 'sales', tables: [] };

describe('readFailed', () => {
  it('shows nothing when the read succeeded', () => {
    assert.equal(readFailed({ isError: false, data: dataset, error: null }), false);
    assert.equal(readFailed({ isError: false, data: undefined, error: null }), false);
  });

  it('shows the failure when there is no answer to keep', () => {
    assert.equal(readFailed({ isError: true, data: undefined, error: answered(502) }), true);
    assert.equal(readFailed({ isError: true, data: undefined, error: new TypeError('Failed to fetch') }), true);
  });

  it('keeps the last answer when a refresh fails along the way', () => {
    // A control plane restarting, a gateway timing out, the network dropping a request: the next read
    // tries again, and the page — the tabs it keeps among it — stays as it was.
    assert.equal(readFailed({ isError: true, data: dataset, error: answered(502) }), false);
    assert.equal(readFailed({ isError: true, data: dataset, error: answered(503) }), false);
    assert.equal(readFailed({ isError: true, data: dataset, error: answered(500) }), false);
    assert.equal(readFailed({ isError: true, data: dataset, error: new TypeError('Failed to fetch') }), false);
  });

  it('shows a final answer even over the last one', () => {
    assert.equal(readFailed({ isError: true, data: dataset, error: answered(404) }), true);
    assert.equal(readFailed({ isError: true, data: dataset, error: answered(403) }), true);
    assert.equal(readFailed({ isError: true, data: dataset, error: answered(401) }), true);
  });
});
