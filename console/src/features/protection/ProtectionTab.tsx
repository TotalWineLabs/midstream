import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Shield, ShieldOff } from 'lucide-react';
import type { ReactNode } from 'react';

import { PageBody } from '@/components/AppShell';
import { RelativeTime } from '@/components/Inline';
import { useToast } from '@/components/ui/Toast';
import { Button, EmptyState, Panel, PanelHeader, Skeleton } from '@/components/ui/primitives';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useMaterializationDefaults } from '@/lib/defaults';
import { formatExact } from '@/lib/format';
import { useApi } from '@/lib/domains';
import type { CpProtectionCatalog, CpProtectionReviewItem, CpProtectionReviewTable, DetailSnapshot } from '@shared/types';

import { ProtectionChips, ProtectionStateBadge } from './ProtectionSummary';
import { describeChoice, choiceOf, kindLabel, maskName } from './protection';
import { ReprotectPanel } from './ReprotectPanel';

/**
 * The Protection tab (handbook 22): the policy in force and how far it has reached; what the tables
 * hold in plain text that they mask now, with the action that masks it (a reprotect); per table, every
 * protected field with its kind, its mask and the schema it was protected from; what the current
 * rules would protect otherwise, with the action that applies them; and the history of policies.
 */
export function ProtectionTab({ snapshot }: { snapshot: DetailSnapshot }): ReactNode {
  const api = useApi();
  const materializationId = snapshot.materializationId;
  const catalog = useMaterializationDefaults().defaults?.protection ?? null;
  const review = useQuery({
    queryKey: ['protection', materializationId],
    queryFn: () => api.protection(materializationId),
    refetchInterval: 15_000,
  });
  const detail = snapshot.detail;
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const written = detail?.materialization.tables ?? [];
  const mayChoose = can('materializations.edit') && written.every((spec) => can('dataset.protect', spec.dataset_id));
  const applyRules = useMutation({
    mutationFn: () =>
      api.update(materializationId, {
        protection: { kinds: choiceOf(detail?.materialization.protection ?? null, catalog), apply_rules: true },
      }),
    onSuccess: () => {
      toast.success('Applying the current rules', 'Each table records them within seconds, and its writers follow.');
      void queryClient.invalidateQueries({ queryKey: ['protection', materializationId] });
    },
    onError: (error: unknown) => toast.error('Could not apply the current rules', error instanceof ApiError ? error.message : String(error)),
  });

  if (review.isLoading) {
    return (
      <PageBody className="space-y-4">
        <Skeleton className="h-28" />
        <Skeleton className="h-64" />
      </PageBody>
    );
  }
  if (review.error || !review.data) {
    return (
      <PageBody>
        <Panel>
          <EmptyState
            title="Protection could not be loaded"
            description={review.error instanceof Error ? review.error.message : 'The control plane did not answer.'}
            action={
              <Button size="sm" onClick={() => void review.refetch()}>
                Retry
              </Button>
            }
          />
        </Panel>
      </PageBody>
    );
  }
  const data = review.data;
  // A table that has not recorded the current revision yet lists what that revision is about to
  // change; one that has lists only what a newer release's rules match that it recorded otherwise.
  const behind = (table: CpProtectionReviewTable): boolean => table.created && (table.recorded_revision ?? 0) < data.revision;
  const pending = data.review.filter(behind);
  const ruled = data.review.filter((table) => !behind(table));
  const pendingCount = pending.reduce((count, table) => count + table.would_change.length, 0);
  const rulesWouldChange = ruled.reduce((count, table) => count + table.would_change.length, 0);
  const kinds = Object.keys(data.policy.kinds ?? {}).length;
  const tableCount = Object.keys(data.tables).length;
  const applying = data.revision > 0 && (data.members_behind.length > 0 || data.tables_behind.length > 0);
  const latest = data.review.flatMap((table) => table.history).reduce<(typeof data.review)[number]['history'][number] | null>(
    (newest, change) => (newest === null || change.revision > newest.revision ? change : newest),
    null,
  );
  return (
    <PageBody className="space-y-6">
      {/* What it protects, and whether that is in force: the answer first. */}
      <Panel className="px-5 py-5 sm:px-7 sm:py-6">
        <div className="flex flex-wrap items-center gap-2">{data.revision > 0 ? <ProtectionStateBadge summary={data} /> : null}</div>
        <p className="display mt-3 flex items-center gap-3 text-[28px] leading-tight font-semibold sm:text-[32px]">
          <Shield className="size-6 shrink-0 text-[var(--color-ink-muted)]" aria-hidden />
          {kinds === 0 ? 'Nothing masked' : `${kinds} ${kinds === 1 ? 'kind' : 'kinds'} masked`}
        </p>
        <div className="mt-3">
          <ProtectionChips policy={data.policy} catalog={catalog} />
        </div>
        <p className="mt-3 text-[14px] text-[var(--color-ink-muted)]">
          Masked before anything is written, so no query, engine or file holds the plain value. A change reaches new records within
          seconds.
        </p>
        <p className="mt-3 text-[12px] text-[var(--color-ink-faint)]">
          {data.revision > 0 ? `Revision ${data.revision}` : 'Created before data protection'}
          {data.changed_by ? ` · by ${data.changed_by}` : ''}
          {latest?.at ? (
            <>
              {' · '}
              <RelativeTime value={latest.at} />
            </>
          ) : null}
          {data.reason === 'apply_rules' ? ' · the current rules applied' : ''}
        </p>
        {applying ? (
          <p className="mt-3 text-[13px] text-[var(--color-dawn-ink)]">
            Applying: {formatExact(tableCount - data.tables_behind.length)} of {formatExact(tableCount)} tables
            {data.members_reporting > 0
              ? `, ${formatExact(data.members_reporting - data.members_behind.length)} of ${formatExact(data.members_reporting)} workers`
              : ''}
          </p>
        ) : null}
      </Panel>

      <ReprotectPanel review={data} detail={detail ?? null} />

      {pendingCount > 0 ? (
        <Panel>
          <PanelHeader
            title={`${formatExact(pendingCount)} ${pendingCount === 1 ? 'field' : 'fields'} revision ${data.revision} is about to protect otherwise`}
            description="Each table records the revision on its next commit, within seconds; its writers follow."
          />
          <ReviewItems tables={pending} catalog={catalog} />
        </Panel>
      ) : null}

      {rulesWouldChange > 0 ? (
        <Panel>
          <PanelHeader
            title={`${formatExact(rulesWouldChange)} ${rulesWouldChange === 1 ? 'field' : 'fields'} the current rules would protect otherwise`}
            description="A newer release's rules match fields these tables recorded otherwise. A field keeps the protection its table recorded until the rules are applied again; applying them affects records written from then on."
            actions={
              mayChoose ? (
                <Button size="sm" onClick={() => applyRules.mutate()} loading={applyRules.isPending}>
                  <RefreshCw className="size-3.5" />
                  Apply the current rules
                </Button>
              ) : null
            }
          />
          <ReviewItems tables={ruled} catalog={catalog} />
        </Panel>
      ) : null}

      <ProtectedFields tables={data.review} catalog={catalog} counters={data.tables} revision={data.revision} />
      <History tables={data.review} catalog={catalog} />
      {data.hidden_tables > 0 ? (
        <p className="text-[12px] text-[var(--color-ink-muted)]">
          {data.hidden_tables} {data.hidden_tables === 1 ? 'table is' : 'tables are'} in datasets whose schemas you may not see.
        </p>
      ) : null}
    </PageBody>
  );
}

/** Each field whose protection would change, with its table: `kind mask → kind mask`. */
function ReviewItems({ tables, catalog }: { tables: CpProtectionReviewTable[]; catalog: CpProtectionCatalog | null }): ReactNode {
  const describe = (decision: CpProtectionReviewItem['current']): string =>
    decision ? `${kindLabel(catalog, decision.kind)} ${maskName(decision.mask, catalog).toLowerCase()}` : 'plain';
  return (
    <ul className="divide-y divide-[var(--color-line)]">
      {tables.flatMap((table) =>
        table.would_change.map((item) => (
          <li key={`${table.table}:${item.field_id}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-[13px]">
            <code className="ident">
              {table.dataset}.{table.table} · {item.name}
            </code>
            <span className="text-[12px] text-[var(--color-ink-muted)]">
              {describe(item.current)}
              {' → '}
              {describe(item.proposed)}
            </span>
          </li>
        )),
      )}
    </ul>
  );
}

/**
 * Every protected field, by table: its kind, its mask and the schema it was protected from. Tables
 * that protect nothing are named together, once.
 */
function ProtectedFields({
  tables,
  catalog,
  counters,
  revision,
}: {
  tables: CpProtectionReviewTable[];
  catalog: CpProtectionCatalog | null;
  counters: Record<string, { recorded_revision: number | null; protected_values: number; withheld_values: number }>;
  revision: number;
}): ReactNode {
  const withFields = tables.filter((table) => table.fields.length > 0);
  const without = tables.filter((table) => table.created && table.fields.length === 0);
  const waiting = tables.filter((table) => !table.created);
  return (
    <Panel className="overflow-hidden">
      <header className="px-5 pt-4 pb-3">
        <h2 className="text-[15px] font-semibold">Protected fields</h2>
      </header>
      {withFields.map((table) => {
        const active = table.fields.filter((field) => field.active);
        const plainAgain = table.fields.filter((field) => !field.active);
        const counted = counters[table.table];
        return (
          <section key={table.table} className="border-t border-[var(--color-line)]">
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-3 pb-1">
              <p className="ident text-[13px]">
                <span className="text-[var(--color-ink-muted)]">{table.dataset}.</span>
                {table.table}
              </p>
              <p className="numeric text-[12px] text-[var(--color-ink-muted)]">
                {formatExact(counted?.protected_values ?? 0)} masked · {formatExact(counted?.withheld_values ?? 0)} withheld
                {table.created && (table.recorded_revision ?? 0) < revision ? (
                  <span className="text-[var(--color-dawn-ink)]"> · recording revision {revision}</span>
                ) : null}
              </p>
            </div>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[12px] text-[var(--color-ink-faint)]">
                  <th className="px-5 py-1.5 font-normal">Field</th>
                  <th className="px-3 py-1.5 font-normal">Kind</th>
                  <th className="px-3 py-1.5 font-normal">Mask</th>
                  <th className="px-5 py-1.5 text-right font-normal">Since schema</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-line)]">
                {active.map((field) => (
                  <tr key={field.field_id}>
                    <td className="px-5 py-2">
                      <span className="inline-flex items-center gap-1.5">
                        <Shield className="size-3.5 text-[var(--color-ink-muted)]" aria-label="protected" />
                        <code className="ident">{field.name}</code>
                      </span>
                    </td>
                    <td className="px-3 py-2">{kindLabel(catalog, field.kind)}</td>
                    <td className="px-3 py-2">{maskName(field.mask, catalog)}</td>
                    <td className="numeric px-5 py-2 text-right">{field.since_schema_id}</td>
                  </tr>
                ))}
                {plainAgain.map((field) => (
                  <tr key={field.field_id} className="text-[var(--color-ink-muted)]">
                    <td className="px-5 py-2">
                      <span className="inline-flex items-center gap-1.5">
                        <ShieldOff className="size-3.5" aria-label="written plain again" />
                        <code className="ident">{field.name}</code>
                      </span>
                    </td>
                    <td className="px-3 py-2">{kindLabel(catalog, field.kind)}</td>
                    <td className="px-3 py-2">Plain since schema {field.until_schema_id}</td>
                    <td className="numeric px-5 py-2 text-right">{field.since_schema_id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
      {without.length > 0 ? (
        <p className="border-t border-[var(--color-line)] px-5 py-3 text-[13px] text-[var(--color-ink-muted)]">
          {withFields.length > 0 ? 'Nothing matches in ' : 'No field matches a kind it masks, in '}
          {without.map((table, index) => (
            <span key={table.table}>
              {index > 0 ? (index === without.length - 1 ? ' and ' : ', ') : ''}
              <code className="ident">{table.table}</code>
            </span>
          ))}
          .
        </p>
      ) : null}
      {waiting.length > 0 ? (
        <p className="border-t border-[var(--color-line)] px-5 py-3 text-[13px] text-[var(--color-ink-muted)]">
          {waiting.length === 1 ? 'One table is' : `${waiting.length} tables are`} not created yet.
        </p>
      ) : null}
    </Panel>
  );
}

/** Each revision once, newest first: who chose it, when, and what it masks. */
function History({ tables, catalog }: { tables: CpProtectionReviewTable[]; catalog: CpProtectionCatalog | null }): ReactNode {
  const byRevision = new Map<number, CpProtectionReviewTable['history'][number]>();
  for (const change of tables.flatMap((table) => table.history)) {
    if (!byRevision.has(change.revision)) byRevision.set(change.revision, change);
  }
  const changes = [...byRevision.values()].sort((left, right) => right.revision - left.revision);
  if (changes.length === 0) return null;
  return (
    <Panel className="px-5 py-4">
      <h2 className="text-[15px] font-semibold">History</h2>
      <ol className="mt-3 space-y-2 text-[13px]">
        {changes.map((change) => (
          <li key={change.revision} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">Revision {change.revision}</span>
            <span className="text-[12px] text-[var(--color-ink-muted)]">
              {change.at ? <RelativeTime value={change.at} /> : null}
              {change.by ? ` · ${change.by}` : ''}
              {change.schema_id !== null ? ` · from schema ${change.schema_id}` : ''}
              {change.reason === 'apply_rules' ? ' · the current rules applied' : ''}
            </span>
            <span className="w-full text-[12px] text-[var(--color-ink-faint)]">{describeChoice(choiceOf(change.policy, catalog), catalog)}</span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
