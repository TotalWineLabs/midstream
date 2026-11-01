import { CheckCircle2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { StatusLabel } from '@/components/Status';
import { Panel, PanelHeader } from '@/components/ui/primitives';
import type { Status } from '@/lib/status';
import type { RuntimeRollout, RuntimeRolloutState } from '@shared/types';
import { useDomainPath } from '@/lib/domains';

type Outstanding = Exclude<RuntimeRolloutState, 'current'>;

/**
 * Where a materialization that is not current stands, as one of the six states (docs/10-design-system.md
 * §10.6), or in plain words where none fits: an old runtime is not a problem, only out of reach.
 */
const OUTSTANDING: Record<Outstanding, { status: Status | string; hint: string }> = {
  pending: {
    status: { kind: 'starting', label: 'Applying', reason: null, moving: true },
    hint: 'A member still runs an older revision, or settings from before this installation; it picks these up within seconds.',
  },
  stopped: {
    status: { kind: 'stopped', label: 'Stopped', reason: null, moving: false },
    hint: 'No members are running; it takes the current settings when it resumes.',
  },
  not_reporting: {
    status: { kind: 'attention', label: 'Not reporting', reason: null, moving: false },
    hint: 'No member has reported in the last two minutes.',
  },
  unsupported: { status: 'On its next deploy', hint: 'Its runtime predates live settings and takes them when it is next deployed.' },
};

/**
 * How far the current runtime-settings revision has reached the runtimes.
 *
 * Each runtime member reports the revision it runs on its heartbeat; the control plane counts a
 * materialization as current once every member it has heard from lately runs it. At revision 0
 * there is nothing to follow, unless a runtime still runs settings delivered before this
 * installation's (handbook 17 §17.7): those are shown until it drops them.
 */
export function RuntimeRolloutPanel({ rollout }: { rollout: RuntimeRollout | null }): ReactNode {
  const domainPath = useDomainPath();
  if (!rollout) return null;
  const followed = rollout.revision > 0 || rollout.pending > 0;
  const running = rollout.total - rollout.stopped;
  const outstanding = rollout.materializations.filter((item): item is typeof item & { state: Outstanding } => item.state !== 'current');
  // Moving while a member still applies; once none does, any runtime left behind needs someone.
  const label = `${rollout.current} of ${running} running current`;
  const progress =
    running === 0 ? (
      <span className="text-[12px] text-[var(--color-ink-faint)]">No runtimes running</span>
    ) : rollout.current === running ? (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-ink-muted)]">
        <CheckCircle2 className="size-3.5" aria-hidden />
        {label}
      </span>
    ) : (
      <StatusLabel
        className="text-[12px]"
        status={{ kind: rollout.pending > 0 ? 'starting' : 'attention', label, reason: null, moving: rollout.pending > 0 }}
      />
    );

  return (
    <Panel>
      <PanelHeader
        title="Delivery to runtimes"
        description={
          rollout.revision > 0
            ? `Runtimes pick up revision ${rollout.revision} on their next record or heartbeat, without a restart.`
            : followed
              ? 'No runtime setting has been changed here. A runtime still running settings from before this installation drops them on its next record or heartbeat.'
              : 'No runtime setting has been changed here, so every runtime runs the values it was deployed with.'
        }
        actions={followed ? progress : null}
      />
      {followed && outstanding.length > 0 ? (
        <ul className="divide-y divide-[var(--color-line)]">
          {outstanding.map((item) => {
            const state = OUTSTANDING[item.state];
            return (
              <li key={item.materializationId} className="flex items-center justify-between gap-4 px-5 py-2.5 text-[13px]">
                <Link
                  to={domainPath(`/materializations/${encodeURIComponent(item.materializationId)}`)}
                  className="min-w-0 truncate font-medium hover:underline"
                >
                  {item.name || item.materializationId}
                </Link>
                <span className="flex shrink-0 items-center gap-3 text-[12px] text-[var(--color-ink-faint)]">
                  {item.revision !== null && item.state === 'pending' ? <span className="numeric">on revision {item.revision}</span> : null}
                  <span title={state.hint} className="inline-flex">
                    {typeof state.status === 'string' ? (
                      <span className="text-[var(--color-ink-muted)]">{state.status}</span>
                    ) : (
                      <StatusLabel status={state.status} />
                    )}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </Panel>
  );
}
