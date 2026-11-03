import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { statusLineState } from './statusLine.ts';

const RUN = { id: 'r1' };

describe('the status line', () => {
  it('leads with the run on screen, once it has one', () => {
    assert.equal(statusLineState({ run: RUN, starting: false, idle: false, refused: false }), 'run');
    assert.equal(statusLineState({ run: RUN, starting: false, idle: true, refused: true }), 'run', 'a refused rerun leaves the run before on screen');
  });

  it('says a run is starting while one is', () => {
    assert.equal(statusLineState({ run: null, starting: true, idle: false, refused: false }), 'starting');
    assert.equal(statusLineState({ run: RUN, starting: true, idle: false, refused: false }), 'starting');
    assert.equal(statusLineState({ run: null, starting: true, idle: false, refused: true }), 'starting', 'Run pressed again after a refusal');
  });

  it('says a refused start could not start, rather than that it is starting', () => {
    assert.equal(statusLineState({ run: null, starting: false, idle: false, refused: true }), 'refused');
  });

  it('says nothing of Run while a statement has nothing written in it', () => {
    assert.equal(statusLineState({ run: null, starting: false, idle: true, refused: false, blank: true }), 'blank');
    assert.equal(statusLineState({ run: RUN, starting: false, idle: true, refused: false, blank: true }), 'run', 'the last answer stays when its statement is cleared');
  });

  it('says a question waits for Run', () => {
    assert.equal(statusLineState({ run: null, starting: false, idle: true, refused: false }), 'idle');
  });
});
