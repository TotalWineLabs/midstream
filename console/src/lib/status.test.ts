import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reasonWords, statusGroup, statusOf, type StatusInput } from './status.ts';

const status = (input: StatusInput) => statusOf(input);

describe('statusOf', () => {
  it('reads a healthy running materialization as Flowing, and one with a falling backlog as Catching up', () => {
    const flowing = status({ desired: 'running', observed: 'running', reason: 'runtime_ready', health: 'healthy' });
    assert.deepEqual(flowing, { kind: 'flowing', label: 'Flowing', reason: null, moving: true });
    const catching = status({ desired: 'running', observed: 'running', health: 'healthy', catchingUp: true });
    assert.equal(catching.kind, 'catching-up');
    assert.equal(catching.label, 'Catching up');
  });

  it('names what is happening while it changes', () => {
    assert.equal(status({ desired: 'running', observed: 'requested', reason: 'requested' }).label, 'Starting');
    assert.equal(status({ desired: 'running', observed: 'deploying', reason: 'waiting_for_runtime_ready' }).reason, 'Waiting for its workers');
    const updating = status({ desired: 'running', observed: 'deploying', reason: 'resource_rollout_in_progress' });
    assert.deepEqual([updating.kind, updating.label, updating.moving], ['starting', 'Updating', true]);
    assert.equal(status({ desired: 'running', observed: 'stopped' }).label, 'Resuming');
    const stopping = status({ desired: 'stopped', observed: 'running' });
    assert.deepEqual([stopping.kind, stopping.label, stopping.moving], ['stopped', 'Stopping', true]);
    assert.equal(status({ desired: 'deleting', observed: 'running' }).label, 'Deleting');
  });

  it('settles into Stopped, Paused and Deleted', () => {
    assert.deepEqual(status({ desired: 'stopped', observed: 'stopped', reason: 'runtime_scaled_to_zero' }), {
      kind: 'stopped',
      label: 'Stopped',
      reason: null,
      moving: false,
    });
    assert.equal(status({ desired: 'running', observed: 'paused' }).label, 'Paused');
    assert.equal(status({ desired: 'deleted', observed: 'deleted' }).label, 'Deleted');
  });

  it('says what needs attention in the control plane’s own words when it has them', () => {
    const coded = status({ desired: 'running', observed: 'degraded', reason: 'schema_field_limit' });
    assert.deepEqual([coded.kind, coded.label, coded.reason], ['attention', 'Needs attention', 'A table is at its field limit']);
    const told = status({ desired: 'running', observed: 'degraded', reason: 'schema_field_limit', message: 'orders is at its 2,000-field limit' });
    assert.equal(told.reason, 'orders is at its 2,000-field limit');
    // A stop that did not finish needs someone too.
    assert.equal(status({ desired: 'stopped', observed: 'degraded', reason: 'runtime_scale_down_stalled' }).reason, 'Its workers did not stop');
  });

  it('reads an unhealthy runtime as needing attention, even while its phase says running', () => {
    const unhealthy = status({ desired: 'running', observed: 'running', health: 'degraded', healthReason: 'protection_key_missing' });
    assert.deepEqual([unhealthy.kind, unhealthy.reason], ['attention', 'Missing the protection key']);
    assert.equal(status({ desired: 'running', observed: 'running', health: 'unreachable' }).reason, 'Its workers are not reporting');
    assert.equal(status({ desired: 'running', observed: 'running', health: 'unknown' }).kind, 'flowing');
  });

  it('keeps Failed apart from Needs attention', () => {
    const failed = status({ desired: 'running', observed: 'failed', reason: 'source_topic_missing' });
    assert.deepEqual([failed.kind, failed.label, failed.reason, failed.moving], ['failed', 'Failed', 'A source topic is missing', false]);
  });
});

describe('reasonWords', () => {
  it('reads a code it does not know as words rather than hiding it', () => {
    assert.equal(reasonWords('brand_new_reason'), 'Brand new reason');
    assert.equal(reasonWords('runtime_ready'), null);
    assert.equal(reasonWords(null), null);
  });
});

describe('statusGroup', () => {
  it('puts what needs you first, then what is on its way', () => {
    assert.equal(statusGroup(status({ desired: 'running', observed: 'failed' })), 'needs-you');
    assert.equal(statusGroup(status({ desired: 'running', observed: 'degraded' })), 'needs-you');
    assert.equal(statusGroup(status({ desired: 'stopped', observed: 'running' })), 'in-progress');
    assert.equal(statusGroup(status({ desired: 'running', observed: 'running', catchingUp: true })), 'in-progress');
    assert.equal(statusGroup(status({ desired: 'running', observed: 'running' })), 'flowing');
    assert.equal(statusGroup(status({ desired: 'stopped', observed: 'stopped' })), 'stopped');
  });
});
