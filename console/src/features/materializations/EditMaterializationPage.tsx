import { useMutation, useQuery } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';

import { canEdit } from './actions';
import { TopicPicker, assignableMembers } from './TopicPicker';
import { FixedTableRow, TableDraftRow } from '../datasets/TableDraftRow';
import { blocksSubmit, claimRow, defaultDataset, draftProblems, draftTables, rowProblem, type DraftProblem, type TableDraft } from '../datasets/tableDrafts';
import { useDatasets, useRefreshDatasets } from '../datasets/useDatasets';
import { keepOrder, planTopicChange } from '../detail/topicChange';
import { ProtectionField } from '../protection/ProtectionField';
import { choiceChanges, choiceOf, describeChoice, sameChoice, type ProtectionChoice } from '../protection/protection';
import { PageBody, PageHeader } from '@/components/AppShell';
import { PlanBlocked, PlanCard, PlanChange, PlanGroup, PlanItem, PlanNote, PlanTable } from '@/components/Plan';
import { useToast } from '@/components/ui/Toast';
import { Button, EmptyState, Field, Input, KeyValue, Panel, Skeleton } from '@/components/ui/primitives';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useMaterializationDefaults } from '@/lib/defaults';
import { useApi, useDomain, useDomainPath } from '@/lib/domains';
import { useFleet } from '@/lib/fleet';
import { displayName, formatCount } from '@/lib/format';
import { useDetailStream } from '@/lib/live';
import { labelProblem, normalizeLabel } from '@shared/tableNames';
import type { ConsoleAutoscaling, CpAccepted, CpAutoscale, CpDetail, CpTableSpec, MaterializationUpdate, RemovedTableAction, TableRequest } from '@shared/types';

/** Used until the control plane reports its own limit. */
const FALLBACK_MAX_WORKERS = 64;

/**
 * Changing a materialization, with its plan beside it (docs/10-design-system.md §10.10, "A plan
 * first"): its name, the topics it reads, its workers, whether more join while it is far behind,
 * and how it masks. The plan says what each table becomes — added, written again, kept read-only,
 * dropped with its data — what else changes, and what it costs, before anything is saved.
 *
 * A topic added gets a table of its own, in the dataset chosen for it, its name claimed there before
 * the change applies. The table of a topic removed is kept, read-only, or dropped with its data —
 * asked for each one, every time. Adding, removing and dropping tables needs write access to their
 * datasets. Changing the topics stops the workers until their consumer group has emptied, then
 * starts them with the new ones. A stopped materialization runs with the changes once resumed.
 */
export function EditMaterializationPage(): ReactNode {
  const domainPath = useDomainPath();
  const { materializationId = '' } = useParams<{ materializationId: string }>();
  const { data } = useDetailStream(materializationId);
  const detail = data?.detail ?? null;
  const back = domainPath(`/materializations/${encodeURIComponent(materializationId)}`);

  if (data && !detail) {
    return (
      <PageBody>
        <Panel>
          <EmptyState
            title={data.error ? 'Cannot reach the control plane' : 'Not found'}
            description={data.error ?? 'This materialization is no longer present.'}
            action={
              <Link to={domainPath('/materializations')} className="text-[13px] font-medium hover:underline">
                All materializations
              </Link>
            }
          />
        </Panel>
      </PageBody>
    );
  }
  if (!detail) {
    return (
      <PageBody className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Skeleton className="h-[420px]" />
        <Skeleton className="h-64" />
      </PageBody>
    );
  }
  // One that is being deleted, or not yet created, has nothing to change.
  if (!canEdit(detail)) return <Navigate to={back} replace />;
  // Keyed, so the form starts from the materialization as it is when the page opens; what changes
  // while it is open still reaches the plan.
  return <EditForm key={materializationId} detail={detail} back={back} />;
}

function EditForm({ detail, back }: { detail: CpDetail; back: string }): ReactNode {
  const api = useApi();
  const navigate = useNavigate();
  const domain = useDomain();
  const domainPath = useDomainPath();
  const toast = useToast();
  const { can } = useAuth();
  const { materialization, status } = detail;
  const current = materialization.replicas ?? 1;
  // Absent from a control plane before 4.4, which never scales a runtime: nothing to switch.
  const currentAutoscaling = materialization.autoscaling;
  const [label, setLabel] = useState(materialization.name);
  const [workers, setWorkers] = useState(String(current));
  const [autoscaling, setAutoscaling] = useState(currentAutoscaling ?? true);
  const [topics, setTopics] = useState<string[]>(materialization.source_topics);
  const [drafts, setDrafts] = useState<TableDraft[]>([]);
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<string, DraftProblem>>(new Map());
  const [submitted, setSubmitted] = useState(false);
  const [actions, setActions] = useState<Record<string, RemovedTableAction>>({});
  const [dropKept, setDropKept] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<{ field: string | null; message: string } | null>(null);
  const { defaults, datasetRules, tableRules, labelMaxLength, maxTopics, autoscaling: autoscalingPolicy } = useMaterializationDefaults();
  // Data protection (handbook 22): absent from control planes before 1.0.0-rc.5, which offer none.
  const protectionCatalog = defaults?.protection ?? null;
  const currentProtection = useMemo(() => choiceOf(materialization.protection ?? null, protectionCatalog), [materialization.protection, protectionCatalog]);
  const [protection, setProtection] = useState<ProtectionChoice>(currentProtection);
  // Then mask the rows already written (handbook 22 §22.14), purging the older snapshots unless asked not to.
  const [reprotect, setReprotect] = useState(false);
  const [purge, setPurge] = useState(true);
  const datasets = useDatasets(true);
  const refreshDatasets = useRefreshDatasets();
  const { data: fleet } = useFleet(domain.id);

  const change = useMemo(() => planTopicChange(detail, topics), [detail, topics]);
  // Every name the materialization's tables hold - written, kept, being dropped, dropped with their
  // files kept - which no new table may take.
  const existingNames = useMemo(() => [...change.fixed.values(), ...change.taken], [change]);

  const chooseTopics = (next: string[]): void => {
    const ordered = keepOrder(materialization.source_topics, next);
    const added = ordered.filter((topic) => !change.fixed.has(topic));
    setTopics(ordered);
    setDrafts((existing) =>
      draftTables(added, existing, { rules: tableRules, dataset: defaultDataset(existing, datasets.data?.datasets ?? null), taken: existingNames }),
    );
  };

  const changeTable = (draft: TableDraft): void => {
    setDrafts((existing) =>
      draftTables(
        existing.map((candidate) => candidate.topic),
        existing.map((candidate) => (candidate.topic === draft.topic ? draft : candidate)),
        { rules: tableRules, dataset: '', taken: existingNames },
      ),
    );
    setRowErrors((errors) => {
      if (!errors.has(draft.topic)) return errors;
      const next = new Map(errors);
      next.delete(draft.topic);
      return next;
    });
  };

  const problems = useMemo(
    () => draftProblems(drafts, { rules: tableRules, datasets: datasets.data?.datasets ?? null, taken: existingNames }),
    [drafts, tableRules, datasets.data, existingNames],
  );
  const problemOf = (draft: TableDraft, position: number): DraftProblem | null => rowErrors.get(draft.topic) ?? problems[position] ?? null;
  const draftsBlocked = drafts.some((draft, position) => blocksSubmit(problemOf(draft, position)));
  const labelError = labelProblem(label, labelMaxLength);
  const labelChanged =
    normalizeLabel(label) !== normalizeLabel(materialization.name) && !(normalizeLabel(label) === '' && materialization.name === materialization.materialization_id);
  const others = useMemo(
    () => (fleet?.items ?? []).filter((item) => item.materialization_id !== materialization.materialization_id),
    [fleet?.items, materialization.materialization_id],
  );

  // Shared with the topic picker, so this is usually answered from cache.
  const catalog = useQuery({ queryKey: ['topics'], queryFn: () => api.topics(), staleTime: 15_000 });
  // Every topic's partition count, once all are known: what the workers share between them.
  const counts = topics.map((name) => catalog.data?.topics.find((topic) => topic.name === name)?.partitions ?? null);
  const partitions = counts.every((count): count is number => count !== null) ? counts : null;

  const maxWorkers = defaults?.maxReplicas ?? FALLBACK_MAX_WORKERS;
  const parsed = /^\d+$/.test(workers.trim()) ? Number(workers.trim()) : null;
  const invalidWorkers = parsed === null || parsed < 1 ? 'A whole number of 1 or more' : parsed > maxWorkers ? `At most ${maxWorkers} on this control plane` : null;
  const workersChanged = parsed !== null && parsed !== current;
  const autoscalingChanged = currentAutoscaling !== undefined && autoscaling !== currentAutoscaling;
  const undecided = change.removed.filter((spec) => !actions[spec.name]);
  const droppedKept = change.stillKept.filter((spec) => dropKept.has(spec.name));
  const protectionChanged = protectionCatalog !== null && !sameChoice(protection, currentProtection);
  // Choosing how it masks needs Choose data protection on every dataset it writes into, those of the
  // topics this edit adds or writes again included: the new policy masks their tables too.
  const datasetIdOf = (name: string): string | null => datasets.data?.datasets.find((item) => item.name === name)?.dataset_id ?? null;
  const protectionLockedBy = [
    ...new Set(
      [
        ...[...materialization.tables, ...change.resumed].map((spec) => ({ id: spec.dataset_id, name: spec.dataset })),
        ...drafts.filter((draft) => draft.dataset).map((draft) => ({ id: datasetIdOf(draft.dataset), name: draft.dataset })),
      ]
        .filter((item) => item.id !== null && !can('dataset.protect', item.id))
        .map((item) => item.name),
    ),
  ];
  // Rewriting what is already written is table maintenance, of every table it keeps.
  const mayReprotect =
    can('materializations.maintain') && [...materialization.tables, ...(materialization.retired_tables ?? [])].every((spec) => can('dataset.protect', spec.dataset_id));
  const reprotectAfter = protectionChanged && mayReprotect && protectionLockedBy.length === 0 && reprotect;
  const anyChange = labelChanged || workersChanged || autoscalingChanged || change.changesTopics || droppedKept.length > 0 || protectionChanged;
  const stopped = status.desired_phase === 'stopped';
  // Each table added, written again, removed or dropped is in a dataset the person must be able to write.
  const affected = [...change.resumed, ...change.removed, ...droppedKept];
  const unwritable = affected.filter((spec) => !can('dataset.write', spec.dataset_id));
  const pending = materialization.pending_topic_change ?? null;
  const dropped = [...change.removed.filter((spec) => actions[spec.name] === 'drop'), ...droppedKept];
  const keptReadOnly = change.removed.filter((spec) => actions[spec.name] === 'keep');

  // The one thing to do before it can be saved, said beside Save: the first that applies.
  const blockedBy =
    labelError ??
    (topics.length === 0 ? 'A materialization reads at least one topic.' : null) ??
    (pending !== null && (change.changesTopics || droppedKept.length > 0)
      ? 'Its last change of topics is still being applied. Change them again once it is done.'
      : null) ??
    (unwritable.length > 0
      ? `${unwritable.map(qualified).join(', ')} ${unwritable.length === 1 ? 'is' : 'are'} in ${[...new Set(unwritable.map((spec) => spec.dataset))].join(' and ')}, which you cannot change: ask one of its owners for write access.`
      : null) ??
    (undecided.length > 0 ? `Choose whether to keep or drop ${undecided.map(qualified).join(' and ')}.` : null) ??
    (draftsBlocked ? 'Finish naming the new tables.' : null) ??
    invalidWorkers ??
    (protectionChanged && protectionLockedBy.length > 0 ? `Choosing how it masks needs data protection rights on ${protectionLockedBy.join(' and ')}.` : null);
  const blocked = blockedBy !== null || !anyChange;

  const mutation = useMutation({
    mutationFn: (body: MaterializationUpdate) => api.update(materialization.materialization_id, body),
    onSuccess: (accepted) => {
      toast.success(
        'Change requested',
        describeAccepted(materialization, accepted, {
          current,
          workers: parsed,
          autoscaling: autoscalingChanged ? autoscaling : null,
          stopped,
          protection: protectionChanged,
          reprotect: reprotectAfter,
        }),
      );
      void refreshDatasets();
      void navigate(back);
    },
    onError: (failure: unknown, body) => {
      const message = failure instanceof ApiError ? failure.message : 'The control plane rejected the change.';
      const row = failure instanceof ApiError ? claimRow(failure.details) : null;
      const topic = row ? body.tables?.[row.index]?.source_topic : undefined;
      if (row && topic && drafts.some((draft) => draft.topic === topic)) {
        setRowErrors(new Map([[topic, rowProblem(row.field, message)]]));
        setError(null);
        void refreshDatasets();
      } else if (row?.field === 'source_topic') {
        // A kept table's topic, read again, has no row of its own: said under the topics.
        setError({ field: 'tables', message });
      } else {
        const field = failure instanceof ApiError && typeof failure.details.field === 'string' ? failure.details.field : null;
        setError({ field, message });
      }
      toast.error('Could not change the materialization', message);
    },
  });

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (blocked || parsed === null) return;
    const body: MaterializationUpdate = {};
    if (labelChanged) body.name = normalizeLabel(label);
    if (workersChanged) body.replicas = parsed;
    if (autoscalingChanged) body.autoscaling = autoscaling;
    if (change.changesTopics) {
      const byTopic = new Map(drafts.map((draft) => [draft.topic, draft]));
      body.tables = topics.map((topic): TableRequest => {
        const draft = byTopic.get(topic);
        return draft ? { source_topic: topic, dataset: draft.dataset, name: draft.name.trim() } : { source_topic: topic };
      });
    }
    const removed: Record<string, RemovedTableAction> = {};
    for (const spec of change.removed) removed[spec.name] = actions[spec.name] as RemovedTableAction;
    for (const spec of droppedKept) removed[spec.name] = 'drop';
    if (Object.keys(removed).length > 0) body.removed_tables = removed;
    if (protectionChanged) body.protection = { kinds: protection, ...(reprotectAfter ? { reprotect: { purge } } : {}) };
    setError(null);
    mutation.mutate(body);
  };
  const specOf = (topic: string): CpTableSpec | undefined => [...materialization.tables, ...(materialization.retired_tables ?? [])].find((spec) => spec.source_topic === topic);
  const rowsOf = (spec: CpTableSpec): number | null => detail.tables.find((record) => record.name === spec.name)?.totals.records ?? null;
  const errorFor = (field: string): string | null => (error && (error.field === field || (field === 'replicas' && !error.field)) ? error.message : null);
  const name = displayName(materialization);

  return (
    <>
      <PageHeader
        crumbs={
          <>
            <Link to={domainPath('/materializations')} className="transition-colors hover:text-[var(--color-ink)]">
              Materializations
            </Link>
            <span className="px-1.5 text-[var(--color-ink-faint)]">/</span>
            <Link to={back} className="transition-colors hover:text-[var(--color-ink)]">
              {name}
            </Link>
          </>
        }
        title={`Edit ${name}`}
      />
      <PageBody>
        <form onSubmit={onSubmit} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]" noValidate>
          <div className="min-w-0 space-y-6">
            <Panel className="space-y-5 p-5 sm:p-6">
              <div>
                <h2 className="display text-[20px] leading-tight font-semibold">Which topics does it read?</h2>
                <p className="mt-1 text-[13px] text-[var(--color-ink-muted)]">Each one is a table of its own. Removing one asks what becomes of its table.</p>
              </div>
              {pending ? (
                <p className="rounded-[var(--radius-control)] bg-[var(--color-raised)] px-3 py-2 text-[12px] text-[var(--color-ink-muted)]">
                  Adding {pending.added.map((spec) => `${spec.dataset}.${spec.name}`).join(', ')}: their names are being claimed. The topics can be changed again
                  once that is done.
                </p>
              ) : null}
              <TopicPicker
                label="Topics"
                value={topics}
                onChange={chooseTopics}
                maxTopics={maxTopics}
                materializations={others}
                renderTable={(topic) => {
                  const spec = specOf(topic);
                  if (spec) return <FixedTableRow dataset={spec.dataset} name={spec.name} note={change.notes.get(topic)} />;
                  const position = drafts.findIndex((draft) => draft.topic === topic);
                  const draft = drafts[position];
                  if (!draft) return null;
                  const problem = problemOf(draft, position);
                  return (
                    <TableDraftRow
                      draft={draft}
                      problem={problem}
                      showProblem={submitted || rowErrors.has(topic) || (problem !== null && (problem.field === 'name' || draft.dataset !== ''))}
                      datasetRules={datasetRules}
                      onChange={changeTable}
                    />
                  );
                }}
                notes={new Map([...change.notes].filter(([topic]) => !specOf(topic)))}
                verb="saving"
                error={errorFor('tables') ?? errorFor('source_topics') ?? (topics.length === 0 ? 'A materialization reads at least one topic' : null)}
              />

              {change.removed.length > 0 ? (
                <section className="space-y-3 border-t border-[var(--color-line)] pt-4">
                  <div>
                    <h3 className="text-[13px] font-semibold">{change.removed.length === 1 ? 'Its table, once the topic is removed' : 'Their tables, once the topics are removed'}</h3>
                    <p className="mt-0.5 text-[12px] text-[var(--color-ink-muted)]">
                      Kept, a table stays readable, and is written again if its topic comes back. Dropped, it is deleted with its data.
                    </p>
                  </div>
                  {change.removed.map((spec) => (
                    <RemovedTableChoice
                      key={spec.name}
                      spec={spec}
                      rows={rowsOf(spec)}
                      writable={can('dataset.write', spec.dataset_id)}
                      value={actions[spec.name] ?? null}
                      onChange={(action) => setActions((existing) => ({ ...existing, [spec.name]: action }))}
                    />
                  ))}
                  {errorFor('removed_tables') ? <p className="text-[12px] text-[var(--color-flare-ink)]">{errorFor('removed_tables')}</p> : null}
                </section>
              ) : null}

              {change.stillKept.length > 0 ? (
                <section className="space-y-2 border-t border-[var(--color-line)] pt-4">
                  <div>
                    <h3 className="text-[13px] font-semibold">Kept tables</h3>
                    <p className="mt-0.5 text-[12px] text-[var(--color-ink-muted)]">
                      Readable, no longer written. Add a topic back to write its table again, or drop a table with its data.
                    </p>
                  </div>
                  {change.stillKept.map((spec) => (
                    <label key={spec.name} className="flex cursor-pointer items-center gap-2 text-[13px]">
                      <input
                        type="checkbox"
                        checked={dropKept.has(spec.name)}
                        onChange={(event) =>
                          setDropKept((existing) => {
                            const next = new Set(existing);
                            if (event.target.checked) next.add(spec.name);
                            else next.delete(spec.name);
                            return next;
                          })
                        }
                        disabled={!can('dataset.write', spec.dataset_id)}
                        className="size-3.5 cursor-pointer accent-[var(--color-ink)] disabled:cursor-not-allowed"
                      />
                      <span className="min-w-0">
                        Drop <code className="ident">{qualified(spec)}</code> and its data
                        {can('dataset.write', spec.dataset_id) ? null : <NoWriteAccess dataset={spec.dataset} />}
                      </span>
                    </label>
                  ))}
                </section>
              ) : null}
            </Panel>

            <Panel className="space-y-5 p-5 sm:p-6">
              <Field label="Name" hint="For people. Left empty, it goes by its id. Changing it touches nothing else." error={errorFor('name') ?? labelError}>
                <Input
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder={materialization.materialization_id}
                  autoComplete="off"
                  maxLength={labelMaxLength + 16}
                />
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Workers"
                  hint={workerHint({ parsed, current, partitions, topics, stopped })}
                  error={errorFor('replicas') ?? (workers.trim() && invalidWorkers ? invalidWorkers : null)}
                >
                  <Input
                    value={workers}
                    onChange={(event) => setWorkers(event.target.value)}
                    inputMode="numeric"
                    spellCheck={false}
                    className="numeric max-w-[10rem]"
                  />
                </Field>
                {currentAutoscaling !== undefined ? (
                  <label className="flex cursor-pointer items-start gap-2.5 sm:pt-6">
                    <input
                      type="checkbox"
                      checked={autoscaling}
                      onChange={(event) => setAutoscaling(event.target.checked)}
                      className="mt-[3px] size-3.5 shrink-0 cursor-pointer accent-[var(--color-ink)]"
                    />
                    <span>
                      <span className="block text-[13px] font-medium">Add workers when far behind</span>
                      <span className="block text-[12px] text-[var(--color-ink-muted)]">
                        {autoscaleHint({ on: autoscaling, autoscale: detail.autoscale ?? null, policy: autoscalingPolicy })}
                      </span>
                    </span>
                  </label>
                ) : null}
              </div>

              {protectionCatalog ? (
                <ProtectionField
                  idPrefix="edit-protection"
                  catalog={protectionCatalog}
                  value={protection}
                  defaultChoice={currentProtection}
                  baselineTag="current"
                  resetLabel="Keep the current protection"
                  lockedBy={protectionLockedBy}
                  error={error?.field?.startsWith('protection') ? error.message : null}
                  onChange={setProtection}
                  startOpen={protectionChanged}
                  note="Applies to records written from now on, within seconds, without a restart."
                />
              ) : null}

              {protectionChanged && mayReprotect && protectionLockedBy.length === 0 ? (
                <div className="space-y-2.5">
                  <Check
                    checked={reprotect}
                    onChange={setReprotect}
                    label="Also mask rows already written"
                    hint="Once each table records the new policy, the maintenance app rewrites the files holding in plain text what it now masks."
                  />
                  {reprotect ? (
                    <div className="ml-6">
                      <Check
                        checked={purge}
                        onChange={setPurge}
                        label="Purge the plain text now"
                        hint="Then expire each table’s older snapshots and delete the files only they held: time travel to before the rewrite ends."
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}

              <dl className="grid gap-3 border-t border-[var(--color-line)] pt-4 sm:grid-cols-2">
                <KeyValue label="Id" mono>
                  {materialization.materialization_id}
                </KeyValue>
                <KeyValue label="Storage per worker" mono>
                  {materialization.storage_size ?? '—'}
                </KeyValue>
                <KeyValue label="Destination" mono className="sm:col-span-2">
                  <span title={materialization.destination_uri}>{materialization.destination_uri}</span>
                </KeyValue>
                <p className="text-[12px] text-[var(--color-ink-faint)] sm:col-span-2">Fixed when it was created.</p>
              </dl>
            </Panel>
          </div>

          <aside className="min-w-0 self-start lg:sticky lg:top-6">
            <PlanCard
              action={
                <>
                  {submitted || anyChange ? (blockedBy ? <PlanBlocked>{blockedBy}</PlanBlocked> : null) : null}
                  <Button type="submit" variant={dropped.length > 0 ? 'danger' : 'primary'} className="w-full" disabled={blocked} loading={mutation.isPending}>
                    {dropped.length > 0 ? `Save, dropping ${dropped.length} ${dropped.length === 1 ? 'table' : 'tables'}` : 'Save changes'}
                  </Button>
                  <Link
                    to={back}
                    className="block rounded-[var(--radius-control)] py-1.5 text-center text-[13px] text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-ink)]"
                  >
                    Cancel
                  </Link>
                </>
              }
            >
              {!anyChange ? (
                <PlanNote>Change something, and what it does shows here.</PlanNote>
              ) : (
                <>
                  {drafts.length > 0 ? (
                    <PlanGroup title={`Adds ${drafts.length === 1 ? 'a table' : `${drafts.length} tables`}`}>
                      {drafts.map((draft) => (
                        <PlanTable
                          key={draft.topic}
                          dataset={draft.dataset || 'dataset'}
                          name={draft.name || 'table'}
                          detail={
                            <>
                              from <span className="ident">{draft.topic}</span>
                            </>
                          }
                        />
                      ))}
                    </PlanGroup>
                  ) : null}
                  {change.resumed.length > 0 ? (
                    <PlanGroup title="Writes again">
                      {change.resumed.map((spec) => (
                        <PlanTable key={spec.name} dataset={spec.dataset} name={spec.name} detail="its topic is read again, where it left off" />
                      ))}
                    </PlanGroup>
                  ) : null}
                  {keptReadOnly.length > 0 ? (
                    <PlanGroup title="Keeps, read-only">
                      {keptReadOnly.map((spec) => (
                        <PlanTable key={spec.name} dataset={spec.dataset} name={spec.name} detail="no longer written; still readable" />
                      ))}
                    </PlanGroup>
                  ) : null}
                  {dropped.length > 0 ? (
                    <PlanGroup title="Drops, with their data — this cannot be undone">
                      {dropped.map((spec) => {
                        const rows = rowsOf(spec);
                        return <PlanTable key={spec.name} dataset={spec.dataset} name={spec.name} detail={rows !== null ? `${formatCount(rows)} rows` : undefined} />;
                      })}
                    </PlanGroup>
                  ) : null}
                  {labelChanged || workersChanged || autoscalingChanged ? (
                    <PlanGroup title="Changes">
                      {labelChanged ? <PlanChange label="Name" from={name} to={normalizeLabel(label) || materialization.materialization_id} /> : null}
                      {workersChanged ? <PlanChange label="Workers" from={current} to={parsed} /> : null}
                      {autoscalingChanged ? <PlanChange label="More when behind" from={currentAutoscaling ? 'On' : 'Off'} to={autoscaling ? 'On' : 'Off'} /> : null}
                    </PlanGroup>
                  ) : null}
                  {protectionChanged && protectionCatalog ? (
                    <PlanGroup title="Masks">
                      {choiceChanges(currentProtection, protection, protectionCatalog).map((line) => (
                        <PlanItem key={line}>{line}</PlanItem>
                      ))}
                      {reprotectAfter ? (
                        <PlanItem detail={purge ? 'then purges the plain text from older versions' : 'older versions keep it until they expire'}>
                          Rows already written too
                        </PlanItem>
                      ) : null}
                    </PlanGroup>
                  ) : null}
                  <PlanNote>{costOf({ topics: change.changesTopics || droppedKept.length > 0, added: drafts.length > 0, workers: workersChanged, protection: protectionChanged, stopped })}</PlanNote>
                  {protectionChanged && protectionCatalog ? (
                    <PlanNote>
                      <span title={describeChoice(protection, protectionCatalog)}>
                        Masks {Object.keys(protection).length === 0 ? 'nothing' : `${Object.keys(protection).length} kinds`} from then on.
                      </span>
                    </PlanNote>
                  ) : null}
                </>
              )}
            </PlanCard>
          </aside>
        </form>
      </PageBody>
    </>
  );
}

/** What the change costs, in time and in work stopping, as it will happen. */
function costOf({ topics, added, workers, protection, stopped }: { topics: boolean; added: boolean; workers: boolean; protection: boolean; stopped: boolean }): string {
  if (stopped) return 'It is stopped: it runs with these changes once resumed.';
  const parts: string[] = [];
  if (added) parts.push('The new tables’ names are claimed first, then their topics sampled and the tables created.');
  if (topics) parts.push('Its workers stop until their consumer group has emptied — about two minutes — then start with the new topics, each table where it left off.');
  else if (workers) parts.push('Its workers are re-applied with the new count.');
  if (protection) parts.push('Protection applies within seconds, without a restart.');
  return parts.length > 0 ? parts.join(' ') : 'Applies at once.';
}

/** A table as SQL reads it: `<dataset>.<table>`. */
function qualified(spec: Pick<CpTableSpec, 'dataset' | 'name'>): string {
  return `${spec.dataset}.${spec.name}`;
}

function NoWriteAccess({ dataset }: { dataset: string }): ReactNode {
  return (
    <span className="ml-1.5 inline-flex items-center gap-1 text-[var(--color-ink-faint)]" title={`Needs write access to ${dataset}`}>
      <Lock className="size-3" aria-hidden />
      no write access to {dataset}
    </span>
  );
}

/** A switch-like checkbox with its one line of why. */
function Check({ checked, onChange, label, hint }: { checked: boolean; onChange: (value: boolean) => void; label: string; hint: string }): ReactNode {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-[3px] size-3.5 shrink-0 cursor-pointer accent-[var(--color-ink)]" />
      <span>
        <span className="block text-[13px] font-medium">{label}</span>
        <span className="block text-[12px] text-[var(--color-ink-muted)]">{hint}</span>
      </span>
    </label>
  );
}

/** What becomes of a removed topic's table: kept read-only, or dropped with its data. Asked every time. */
function RemovedTableChoice({
  spec,
  rows,
  writable,
  value,
  onChange,
}: {
  spec: CpTableSpec;
  rows: number | null;
  /** Whether the person may change the table's dataset; removing its topic does. */
  writable: boolean;
  value: RemovedTableAction | null;
  onChange: (action: RemovedTableAction) => void;
}): ReactNode {
  const option = (action: RemovedTableAction, label: string): ReactNode => (
    <label
      className={cn(
        'flex cursor-pointer items-center rounded-[6px] px-2.5 py-1 text-[12px] font-medium whitespace-nowrap transition-colors',
        value === action ? 'bg-[var(--color-shelf)] text-[var(--color-ink)] shadow-sm' : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
        !writable && 'cursor-not-allowed opacity-50',
      )}
    >
      <input type="radio" name={`removed-${spec.name}`} value={action} checked={value === action} disabled={!writable} onChange={() => onChange(action)} className="sr-only" />
      {label}
    </label>
  );
  return (
    <div role="radiogroup" aria-label={`What becomes of ${spec.name}`} className="flex flex-wrap items-center justify-between gap-2">
      <span className="min-w-0 text-[13px]">
        <code className="ident">{qualified(spec)}</code>
        <span className="text-[var(--color-ink-faint)]">
          {rows !== null ? ` · ${formatCount(rows)} rows` : ''} · topic {spec.source_topic}
        </span>
        {writable ? null : <NoWriteAccess dataset={spec.dataset} />}
      </span>
      <span className="inline-flex items-center gap-0.5 rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-raised)] p-0.5">
        {option('keep', 'Keep read-only')}
        {option('drop', 'Drop with its data')}
      </span>
    </div>
  );
}

/** The toast after a change is accepted: what it does, as the control plane planned it. */
function describeAccepted(
  materialization: CpDetail['materialization'],
  accepted: CpAccepted,
  {
    current,
    workers,
    autoscaling,
    stopped,
    protection = false,
    reprotect = false,
  }: { current: number; workers: number | null; autoscaling: boolean | null; stopped: boolean; protection?: boolean; reprotect?: boolean },
): string {
  const parts: string[] = [];
  const change = accepted.topic_change;
  const list = (specs: CpTableSpec[]): string => specs.map(qualified).join(', ');
  if (change?.added.length) parts.push(`adding ${list(change.added)}`);
  if (change?.resumed.length) parts.push(`writing ${list(change.resumed)} again`);
  if (change?.kept.length) parts.push(`keeping ${list(change.kept)} read-only`);
  if (change?.dropped.length) parts.push(`dropping ${list(change.dropped)}`);
  if (workers !== null && workers !== current) parts.push(`${current} → ${workers} worker${workers === 1 ? '' : 's'}`);
  if (autoscaling !== null) parts.push(autoscaling ? 'more workers when behind' : 'no more workers when behind');
  if (protection) parts.push(reprotect ? 'new data protection, for records written from now on and then for the rows already written' : 'new data protection, for records written from now on');
  if (accepted.name && accepted.name !== materialization.name) parts.push(`now named ${accepted.name}`);
  const what = parts.length ? parts.join('; ') : 'no change';
  return `${displayName(materialization)}: ${what}${stopped ? ', applied when it is resumed' : ''}.`;
}

/**
 * What adding workers does for this materialization: what turning it off undoes now, and the
 * deployment's own switch, which overrides it.
 */
function autoscaleHint({ on, autoscale, policy }: { on: boolean; autoscale: CpAutoscale | null; policy: ConsoleAutoscaling | null }): string {
  if (policy && !policy.enabled) return 'Off for every materialization (Settings › Materializations), so none are added while it is off there.';
  const scaled = autoscale?.replicas ?? null;
  if (scaled !== null && autoscale) {
    return on
      ? `Running ${scaled} workers while it catches up; back to ${autoscale.own_replicas} once caught up.`
      : `Running ${scaled} workers while it catches up. Turned off, it goes back to ${autoscale.own_replicas} at once.`;
  }
  const most = policy ? `, up to ${policy.maxReplicas},` : '';
  return `Adds workers while it is far behind its topics${most} and goes back once caught up.`;
}

/**
 * What a count of workers means for these topics. Workers share every topic's partitions, but the
 * partitions of topics with as many partitions go to the same workers, so the workers that can be
 * kept busy are fewer than the partitions in all (`assignableMembers`).
 */
function workerHint({
  parsed,
  current,
  partitions,
  topics,
  stopped,
}: {
  parsed: number | null;
  current: number;
  partitions: number[] | null;
  topics: readonly string[];
  stopped: boolean;
}): string {
  const parts: string[] = [`Now ${current}.`];
  if (partitions !== null && topics.length > 0) {
    const total = partitions.reduce((sum, count) => sum + count, 0);
    const busy = assignableMembers(partitions);
    const what = topics.length === 1 ? `${topics[0]} has ${total} partition${total === 1 ? '' : 's'}` : `Its ${topics.length} topics have ${total} partitions`;
    parts.push(
      parsed !== null && parsed > busy
        ? `${what}, which keep at most ${busy} worker${busy === 1 ? '' : 's'} busy, so ${parsed - busy} would have none to read.`
        : `${what}, shared among the workers.`,
    );
  }
  if (stopped) parts.push('It is stopped, so the new count applies when it is resumed.');
  return parts.join(' ');
}
