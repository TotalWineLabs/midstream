// Type-only, so `node --test` can load this module without the bundler's path aliases.
import type { LifecyclePhase, MaterializationSummary, RuntimeHealthLevel } from '@shared/types';

/**
 * The six states a materialization is in, each a shape, a colour and a word: eleven phases, four
 * health levels and the drift between desired and observed read as one (docs/10-design-system.md
 * §10.6).
 */
export type StatusKind = 'flowing' | 'catching-up' | 'starting' | 'attention' | 'failed' | 'stopped';

export interface Status {
  kind: StatusKind;
  /** The kind's word, or what is happening while it changes: Updating, Resuming, Stopping, Deleting. */
  label: string;
  /** Why, in plain words, where the state needs one. */
  reason: string | null;
  /** On its way somewhere: the glyph turns until it settles. */
  moving: boolean;
}

export interface StatusInput {
  desired: LifecyclePhase;
  observed: LifecyclePhase;
  /** The control plane's reason code. */
  reason?: string | null;
  /** The control plane's own words, which say more than any code. */
  message?: string | null;
  health?: RuntimeHealthLevel;
  healthReason?: string | null;
  /** The lag trend reads a backlog above the floor as clearly falling. */
  catchingUp?: boolean;
}

const PENDING = new Set<LifecyclePhase>(['requested', 'discovering', 'discovered', 'deploying']);

/** Reasons that mean a running materialization is taking a change, not starting for the first time. */
const UPDATING = new Set([
  'resource_generation_not_observed',
  'resource_rollout_in_progress',
  'runtime_apply_in_progress',
  'changing_topics',
  'topic_change_pending',
]);

/** Reasons that say how a stop is going. */
const STOPPING = new Set(['waiting_for_runtime_scale_down', 'waiting_for_consumer_group_empty']);

/**
 * Each reason code the control plane gives, in words a person reads at a glance. Null for a reason
 * the state's own word already says. Codes stay in Diagnostics.
 */
const REASON_WORDS: Record<string, string | null> = {
  requested: 'Requested',
  discovering: 'Reading its topics',
  discovered: 'Creating its tables',
  waiting_for_runtime_ready: 'Waiting for its workers',
  waiting_for_runtime_agents: 'Waiting for its workers',
  resource_generation_not_observed: 'Applying a change',
  resource_rollout_in_progress: 'Rolling out a change',
  runtime_apply_in_progress: 'Applying a change',
  changing_topics: 'Changing its topics',
  topic_change_pending: 'Changing its topics',
  waiting_for_runtime_scale_down: 'Waiting for its workers to stop',
  waiting_for_consumer_group_empty: 'Waiting for its workers to stop',
  runtime_ready: null,
  running: null,
  runtime_scaled_to_zero: null,
  stopped: null,
  paused: null,
  all_managed_agents_paused: null,
  resource_missing_after_delete: null,
  materialization_deleting: null,
  deleting: null,
  deleted: null,
  runtime_scale_down_stalled: 'Its workers did not stop',
  runtime_members_restarting: 'Its workers keep restarting',
  members_restarting: 'Its workers keep restarting',
  resource_ready_but_runtime_silent: 'Its workers are not reporting',
  mixed_agent_states: 'Some of its workers are not running',
  resource_not_ready: 'Its runtime is not ready',
  runtime_not_deployed: 'Its runtime is not deployed',
  commits_stalled: 'Commits have stalled',
  runtime_data_validation_degraded: 'Records are failing validation',
  runtime_infrastructure_degraded: 'Trouble reaching Kafka or storage',
  runtime_reported_degraded: 'Its workers report a problem',
  protection_key_missing: 'Missing the protection key',
  protection_key_mismatch: 'Has another protection key',
  protection_key_not_configured: 'No protection key is set up',
  commit_failed: 'A commit failed',
  schema_evolution_failed: 'A schema change failed',
  schema_field_limit: 'A table is at its field limit',
  table_unavailable: 'A table is unavailable',
  protection_commit_failed: 'Masking could not be recorded',
  compaction_failed: 'Merging small files failed',
  drop_failed: 'A table could not be dropped',
  topic_missing: 'A source topic is missing',
  source_topic_missing: 'A source topic is missing',
  topic_unavailable: 'A source topic is unavailable',
  destination_not_configured: 'No storage is set up for it',
  table_not_created: 'A table could not be created',
};

/** A reason code in words: its own, where the console knows it, or the code made readable. */
export function reasonWords(code: string | null | undefined): string | null {
  if (!code) return null;
  if (code in REASON_WORDS) return REASON_WORDS[code] ?? null;
  const spaced = code.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Read one materialization's phases, health and lag as one state. */
export function statusOf(input: StatusInput): Status {
  const { desired, observed, catchingUp = false } = input;
  const said = (kind: StatusKind, label: string, reason: string | null, moving: boolean): Status => ({ kind, label, reason, moving });
  const why = (): string | null => input.message?.trim() || reasonWords(input.reason);

  if (observed === 'deleted') return said('stopped', 'Deleted', null, false);
  if (desired === 'deleting' || desired === 'deleted' || observed === 'deleting') return said('stopped', 'Deleting', null, true);
  if (observed === 'failed') return said('failed', 'Failed', why(), false);
  if (observed === 'degraded') return said('attention', 'Needs attention', why(), false);

  if (desired === 'stopped') {
    if (observed === 'stopped' || observed === 'paused') return said('stopped', 'Stopped', null, false);
    // Only a stop's own reasons: the rollout that carries it out is not news.
    return said('stopped', 'Stopping', STOPPING.has(input.reason ?? '') ? reasonWords(input.reason) : null, true);
  }
  if (observed === 'stopped') return said('starting', 'Resuming', null, true);
  if (observed === 'paused') return said('stopped', 'Paused', null, false);
  if (PENDING.has(observed)) {
    const updating = UPDATING.has(input.reason ?? '');
    return said('starting', updating ? 'Updating' : 'Starting', reasonWords(input.reason), true);
  }

  if (input.health === 'degraded' || input.health === 'unreachable') {
    const reason = reasonWords(input.healthReason) ?? (input.health === 'unreachable' ? 'Its workers are not reporting' : 'Its workers report a problem');
    return said('attention', 'Needs attention', reason, false);
  }
  if (catchingUp) return said('catching-up', 'Catching up', null, true);
  return said('flowing', 'Flowing', null, true);
}

/** A fleet row's state, from what the list carries: its phases, reason, health level and lag trend. */
export function itemStatus(
  item: Pick<MaterializationSummary, 'desired_phase' | 'observed_phase' | 'phase_reason' | 'runtimeHealth'> & Partial<Pick<MaterializationSummary, 'lagState'>>,
): Status {
  return statusOf({
    desired: item.desired_phase,
    observed: item.observed_phase,
    reason: item.phase_reason,
    health: item.runtimeHealth,
    catchingUp: item.lagState === 'draining',
  });
}

/** Groups a list reads in, by what someone does about them: the ones that need you first. */
export type StatusGroup = 'needs-you' | 'in-progress' | 'flowing' | 'stopped';

export function statusGroup(status: Status): StatusGroup {
  if (status.kind === 'failed' || status.kind === 'attention') return 'needs-you';
  if (status.kind === 'starting' || status.kind === 'catching-up' || (status.kind === 'stopped' && status.moving)) return 'in-progress';
  if (status.kind === 'flowing') return 'flowing';
  return 'stopped';
}
