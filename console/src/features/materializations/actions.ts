import { useMutation } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { useToast } from '@/components/ui/Toast';
import { ApiError, domainApi } from '@/lib/api';
import { useOptionalDomain } from '@/lib/domains';
import type { CpDetail } from '@shared/types';

export type LifecycleAction = 'stop' | 'resume' | 'delete';

/** What each action says once accepted, and when it fails, about the materialization by name. */
const WORDS: Record<LifecycleAction, { done: (name: string) => string; detail?: string; failed: (name: string) => string }> = {
  stop: {
    done: (name) => `${name} is stopping`,
    detail: 'Nothing is lost: its tables stay readable, and Resume picks up where it left off.',
    failed: (name) => `${name} could not be stopped`,
  },
  resume: { done: (name) => `${name} is resuming`, failed: (name) => `${name} could not be resumed` },
  delete: { done: (name) => `Deleting ${name}`, failed: (name) => `${name} could not be deleted` },
};

/**
 * Lifecycle mutations against the control plane.
 *
 * Every mutation is accepted asynchronously (202), so the UI never optimistically rewrites
 * state — it relies on the live stream to reflect what actually happened.
 */
export function useLifecycleActions(): {
  /**
   * Act on a materialization of `domain` (the page's own, inside a domain), called `name` in what
   * the console says back. A stop acts at once and offers Undo rather than asking first.
   */
  run: (action: LifecycleAction, materializationId: string, domain?: string, name?: string) => void;
  pending: LifecycleAction | null;
} {
  const scope = useOptionalDomain();
  const toast = useToast();
  const [pending, setPending] = useState<LifecycleAction | null>(null);

  const mutation = useMutation({
    mutationFn: async ({ action, id, domain }: { action: LifecycleAction; id: string; domain: string; name: string }) => {
      const api = domainApi(domain);
      if (action === 'stop') return api.stop(id);
      if (action === 'resume') return api.resume(id);
      return api.remove(id);
    },
    onSuccess: (_accepted, variables) => {
      const words = WORDS[variables.action];
      const undo =
        variables.action === 'stop'
          ? { label: 'Undo', onClick: () => mutation.mutate({ ...variables, action: 'resume' }) }
          : undefined;
      toast.success(words.done(variables.name), words.detail, undo);
    },
    onError: (error: unknown, variables) => {
      toast.error(
        WORDS[variables.action].failed(variables.name),
        error instanceof ApiError ? error.message : 'The control plane refused it.',
      );
    },
    onSettled: () => setPending(null),
  });

  const run = useCallback(
    (action: LifecycleAction, materializationId: string, domain: string | undefined = scope?.id, name: string = materializationId) => {
      if (!domain) throw new Error('say which domain the materialization is in');
      setPending(action);
      mutation.mutate({ action, id: materializationId, domain, name });
    },
    [mutation, scope?.id],
  );

  return { run, pending };
}

/**
 * Whether the runtime exists to act on. Stopping and rescaling both re-apply it, which needs every
 * one of its tables; the control plane refuses either before they are all created.
 */
export function hasRuntime(detail: CpDetail): boolean {
  const created = new Set(detail.tables.map((table) => table.name));
  return detail.materialization.tables.length > 0 && detail.materialization.tables.every((table) => created.has(table.name));
}

function isLeaving(detail: CpDetail): boolean {
  const desired = detail.materialization.desired_phase ?? detail.status.desired_phase;
  return desired === 'deleting' || desired === 'deleted';
}

/**
 * Offered while the materialization is meant to run. Decided by the desired phase, not the observed
 * one: a materialization still converging toward running can be stopped, and one already stopping
 * offers Resume instead.
 */
export function canStop(detail: CpDetail): boolean {
  const desired = detail.status.desired_phase;
  return (desired === 'running' || desired === 'paused') && hasRuntime(detail) && !isLeaving(detail);
}

/** Offered while the materialization is meant to be stopped, including while it is stopping. */
export function canResume(detail: CpDetail): boolean {
  const desired = detail.status.desired_phase;
  return (desired === 'stopped' || desired === 'paused') && !isLeaving(detail);
}

export function canEdit(detail: CpDetail): boolean {
  return hasRuntime(detail) && !isLeaving(detail);
}

export function canDelete(detail: CpDetail): boolean {
  const phase = detail.status.observed_phase;
  return phase !== 'deleting' && phase !== 'deleted';
}
