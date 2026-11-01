import { useMutation } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { PageBody, PageHeader } from '@/components/AppShell';
import { PlanBlocked, PlanCard, PlanGroup, PlanNote, PlanRow, PlanTable } from '@/components/Plan';
import { useToast } from '@/components/ui/Toast';
import { Button, Field, Input, Panel, Select } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { ApiError, type CreateMaterializationInput } from '@/lib/api';
import { useMaterializationDefaults } from '@/lib/defaults';
import { useApi, useDomain, useDomainPath } from '@/lib/domains';
import { useFleet } from '@/lib/fleet';
import { labelProblem } from '@shared/tableNames';
import type { PartitionGranularity } from '@shared/types';

import { ProtectionField } from '../protection/ProtectionField';
import { choiceOf, describeChoice, sameChoice, type ProtectionChoice } from '../protection/protection';
import { TableDraftRow } from '../datasets/TableDraftRow';
import {
  blocksSubmit,
  claimRow,
  defaultDataset,
  draftProblems,
  draftTables,
  rowProblem,
  tableRequests,
  type DraftProblem,
  type TableDraft,
} from '../datasets/tableDrafts';
import { useDatasets, useRefreshDatasets } from '../datasets/useDatasets';
import { TopicPicker } from './TopicPicker';

interface FormState {
  /** A label: free text; empty, the materialization goes by its id. */
  name: string;
  /** In the order chosen: one table each. */
  source_topics: string[];
  /** Each topic's table: the dataset it goes in, and its name. */
  tables: TableDraft[];
  replicas: string;
  /** On unless turned off: more workers while it is far behind. */
  autoscaling: boolean;
  labels: string;
  skip_tombstones: boolean;
  /** Empty takes the control plane's default. */
  partition_granularity: PartitionGranularity | '';
  /** Null until changed: the domain's Protected by default (handbook 22). */
  protection: ProtectionChoice | null;
}

/** Shown until the control plane reports its own defaults, and when it predates reporting them. */
const FALLBACK_REPLICAS = 1;
const OPTION_FIELDS = new Set(['replicas', 'autoscaling', 'labels', 'skip_tombstones', 'partition_granularity']);

const EMPTY: FormState = {
  name: '',
  source_topics: [],
  tables: [],
  replicas: '',
  autoscaling: true,
  labels: '',
  skip_tombstones: false,
  partition_granularity: '',
  protection: null,
};

const GRANULARITY: Record<PartitionGranularity, string> = {
  hour: 'By hour',
  day: 'By day',
  month: 'By month',
  none: 'Not partitioned',
};

/** Parse `key=value, key2=value2` into a label map. */
function parseLabels(raw: string): Record<string, string> {
  const entries = raw
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const index = pair.indexOf('=');
      if (index < 1) throw new Error(`"${pair}" must use key=value syntax`);
      return [pair.slice(0, index).trim(), pair.slice(index + 1).trim()] as const;
    });
  return Object.fromEntries(entries);
}

/**
 * What will this create? (docs/10-design-system.md §10.10, a plan first) One question and one field
 * lead: the topics, each becoming a table by the name SQL will use. The plan beside says exactly what
 * will exist and what it will do before anything runs, and that leaving is fine once it does.
 */
export function CreateMaterializationPage(): ReactNode {
  const domain = useDomain();
  const domainPath = useDomainPath();
  const api = useApi();
  const { data: fleet } = useFleet(domain.id);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [submitted, setSubmitted] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  // What the control plane said about a row - a name taken meanwhile - until the row changes.
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<string, DraftProblem>>(new Map());
  const [optionsOpen, setOptionsOpen] = useState(false);
  const { defaults, datasetRules, tableRules, labelMaxLength, maxTopics, autoscaling: autoscalingPolicy } = useMaterializationDefaults();
  const datasets = useDatasets(true);
  const refreshDatasets = useRefreshDatasets();
  const navigate = useNavigate();
  const toast = useToast();

  const update = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  // A new topic's table goes in the dataset last chosen, named after the topic until renamed.
  const chooseTopics = (topics: string[]): void => {
    setForm((current) => ({
      ...current,
      source_topics: topics,
      tables: draftTables(topics, current.tables, {
        rules: tableRules,
        dataset: defaultDataset(current.tables, datasets.data?.datasets ?? null),
      }),
    }));
    if (fieldError?.field === 'tables') setFieldError(null);
  };

  const changeTable = (draft: TableDraft): void => {
    setForm((current) => {
      const tables = current.tables.map((existing) => (existing.topic === draft.topic ? draft : existing));
      return { ...current, tables: draftTables(current.source_topics, tables, { rules: tableRules, dataset: '' }) };
    });
    setRowErrors((current) => {
      if (!current.has(draft.topic)) return current;
      const next = new Map(current);
      next.delete(draft.topic);
      return next;
    });
  };

  // Surface the offending input even when it lives in the folded options.
  const reportFieldError = (field: string | null, message: string): void => {
    setFieldError(field === null ? null : { field, message });
    if (field !== null && OPTION_FIELDS.has(field)) setOptionsOpen(true);
  };

  const nameProblem = labelProblem(form.name, labelMaxLength);
  const problems = useMemo(
    () => draftProblems(form.tables, { rules: tableRules, datasets: datasets.data?.datasets ?? null }),
    [form.tables, tableRules, datasets.data],
  );
  const problemOf = (draft: TableDraft, position: number): DraftProblem | null => rowErrors.get(draft.topic) ?? problems[position] ?? null;
  const tablesBlocked = form.tables.some((draft, position) => blocksSubmit(problemOf(draft, position)));
  // Every materialization's tables go under the deployment's destination: none, and none can be made.
  const destinationMissing = defaults !== null && !defaults.destinationUri;

  // Data protection: the domain's default, unless chosen otherwise - which needs Choose data
  // protection on every dataset a table goes in (the control plane decides; this says so first).
  const catalog = defaults?.protection ?? null;
  const defaultChoice = useMemo(() => choiceOf(catalog?.default ?? {}, catalog), [catalog]);
  const protection = form.protection ?? defaultChoice;
  const protectionLockedBy = useMemo(() => {
    const byName = new Map((datasets.data?.datasets ?? []).map((dataset) => [dataset.name, dataset]));
    const names = [...new Set(form.tables.map((draft) => draft.dataset).filter(Boolean))];
    return names.filter((name) => {
      const dataset = byName.get(name);
      return dataset !== undefined && !dataset.permissions.includes('dataset.protect');
    });
  }, [form.tables, datasets.data]);
  const protectionChanged = !sameChoice(protection, defaultChoice);

  const mutation = useMutation({
    mutationFn: (input: CreateMaterializationInput) => api.create(input),
    onSuccess: (accepted, input) => {
      toast.success(`Creating ${input.name ?? accepted.materialization_id}`, 'You can leave: it carries on.');
      void refreshDatasets();
      navigate(domainPath(`/materializations/${accepted.materialization_id}`));
    },
    onError: (error: unknown, input) => {
      const message = error instanceof ApiError ? error.message : 'The control plane refused it.';
      const row = error instanceof ApiError ? claimRow(error.details) : null;
      const topic = row ? input.tables[row.index]?.source_topic : undefined;
      if (row && topic) {
        // On the row it is about: a name another request took first, a dataset gone, access taken
        // away, a topic Kafka does not list.
        setRowErrors(new Map([[topic, rowProblem(row.field, message)]]));
        setFieldError(null);
        void refreshDatasets();
      } else {
        const field = error instanceof ApiError ? ((error.details.field as string | undefined) ?? null) : null;
        reportFieldError(field, message);
      }
      toast.error('It could not be created', message);
    },
  });

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    setFieldError(null);
    if (nameProblem || tablesBlocked || destinationMissing) return;
    let labels: Record<string, string>;
    try {
      labels = parseLabels(form.labels);
    } catch (error) {
      reportFieldError('labels', error instanceof Error ? error.message : 'Use key=value pairs');
      return;
    }

    const replicas = form.replicas.trim();
    const maxReplicas = defaults?.maxReplicas;
    if (replicas && (!/^\d+$/.test(replicas) || Number(replicas) < 1 || (maxReplicas && Number(replicas) > maxReplicas))) {
      reportFieldError('replicas', maxReplicas ? `A whole number from 1 to ${maxReplicas}` : 'A whole number of 1 or more');
      return;
    }

    mutation.mutate({
      ...(form.name.trim() ? { name: form.name.trim() } : {}),
      tables: tableRequests(form.tables),
      ...(replicas ? { replicas: Number(replicas) } : {}),
      // On is the control plane's own default, and a control plane before 4.4 knows no such field.
      ...(form.autoscaling ? {} : { autoscaling: false }),
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
      ...(form.skip_tombstones ? { skip_tombstones: true } : {}),
      ...(form.partition_granularity ? { partition_granularity: form.partition_granularity } : {}),
      // Sent only when it differs from the default: matching it is no decision at all.
      ...(catalog && protectionChanged ? { protection: { kinds: protection } } : {}),
    });
  };

  const ready =
    form.source_topics.length > 0 &&
    form.source_topics.length <= maxTopics &&
    !nameProblem &&
    !destinationMissing &&
    !tablesBlocked &&
    !(protectionChanged && protectionLockedBy.length > 0);
  const errorFor = (field: string): string | null => (fieldError?.field === field ? fieldError.message : null);
  const granularity = form.partition_granularity || defaults?.partitionGranularity || 'day';
  const workers = form.replicas.trim() || String(defaults?.replicas ?? FALLBACK_REPLICAS);
  const autoscales = form.autoscaling && autoscalingPolicy?.enabled === true;

  return (
    <>
      <PageHeader
        crumbs={
          <Link to={domainPath('/materializations')} className="transition-colors hover:text-[var(--color-ink)]">
            Materializations
          </Link>
        }
        title="New materialization"
      />
      <PageBody>
        <form onSubmit={onSubmit} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]" noValidate>
          <div className="min-w-0 space-y-6">
            <Panel className="p-5 sm:p-6">
              <h2 className="display text-[20px] leading-tight font-semibold">Which topics should flow into the lake?</h2>
              <p className="mt-1 text-[13px] text-[var(--color-ink-muted)]">Each one becomes a table of its own.</p>
              <div className="mt-5">
                <TopicPicker
                  label="Topics"
                  required
                  value={form.source_topics}
                  onChange={chooseTopics}
                  maxTopics={maxTopics}
                  materializations={fleet?.items ?? []}
                  renderTable={(topic, position) => {
                    const draft = form.tables.find((candidate) => candidate.topic === topic);
                    if (!draft) return null;
                    const problem = problemOf(draft, position);
                    return (
                      <TableDraftRow
                        draft={draft}
                        problem={problem}
                        // "Choose a dataset" waits for a submit; anything else is said at once.
                        showProblem={submitted || rowErrors.has(topic) || (problem !== null && (problem.field === 'name' || draft.dataset !== ''))}
                        datasetRules={datasetRules}
                        onChange={changeTable}
                      />
                    );
                  }}
                  error={
                    errorFor('tables') ?? errorFor('source_topics') ?? (submitted && form.source_topics.length === 0 ? 'Choose at least one topic' : null)
                  }
                  autoFocus
                />
              </div>
            </Panel>

            <Panel className="space-y-5 p-5 sm:p-6">
              <Field label="Name" hint="Optional, for people. Without one, it goes by its id." error={errorFor('name') ?? nameProblem}>
                <Input
                  value={form.name}
                  onChange={(event) => {
                    update('name', event.target.value);
                    if (fieldError?.field === 'name') setFieldError(null);
                  }}
                  placeholder="Orders and invoices"
                  autoComplete="off"
                  maxLength={labelMaxLength + 16}
                  aria-invalid={nameProblem !== null || errorFor('name') !== null}
                />
              </Field>

              {catalog ? (
                <ProtectionField
                  idPrefix="create-protection"
                  catalog={catalog}
                  value={protection}
                  defaultChoice={defaultChoice}
                  lockedBy={protectionLockedBy}
                  error={errorFor('protection')}
                  onChange={(choice) => {
                    update('protection', choice);
                    if (fieldError?.field?.startsWith('protection')) setFieldError(null);
                  }}
                  note="Values are masked before anything is written, so no query ever sees them plain."
                />
              ) : null}

              <section className="rounded-[var(--radius-control)] border border-[var(--color-line)]">
                <button
                  type="button"
                  onClick={() => setOptionsOpen((current) => !current)}
                  aria-expanded={optionsOpen}
                  aria-controls="create-options"
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-[var(--color-raised)]"
                >
                  <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', optionsOpen && 'rotate-90')} />
                  <span className="shrink-0 text-[13px] font-medium">Options</span>
                  <span className="ml-auto min-w-0 truncate text-[12px] text-[var(--color-ink-muted)]">
                    {GRANULARITY[granularity].toLowerCase()} · {workers} {workers === '1' ? 'worker' : 'workers'}
                    {autoscales ? ', more when behind' : ''} · null records {form.skip_tombstones ? 'ignored' : 'kept'}
                  </span>
                </button>
                {optionsOpen ? (
                  <div id="create-options" className="grid gap-4 border-t border-[var(--color-line)] px-3 py-4 sm:grid-cols-2">
                    <Field label="Partitioned" hint="By the Kafka timestamp. Fixed once created." error={errorFor('partition_granularity')}>
                      <Select value={form.partition_granularity} onChange={(event) => update('partition_granularity', event.target.value as PartitionGranularity | '')}>
                        <option value="">Default, {GRANULARITY[defaults?.partitionGranularity ?? 'day'].toLowerCase()}</option>
                        {(Object.keys(GRANULARITY) as PartitionGranularity[]).map((value) => (
                          <option key={value} value={value}>
                            {GRANULARITY[value]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Workers" hint="Can be changed later." error={errorFor('replicas')}>
                      <Input
                        value={form.replicas}
                        onChange={(event) => update('replicas', event.target.value)}
                        placeholder={String(defaults?.replicas ?? FALLBACK_REPLICAS)}
                        inputMode="numeric"
                        spellCheck={false}
                      />
                    </Field>
                    {autoscalingPolicy ? (
                      <Check
                        checked={form.autoscaling}
                        onChange={(value) => update('autoscaling', value)}
                        label="Add workers when far behind"
                        hint={autoscalingPolicy.enabled ? `Up to ${autoscalingPolicy.maxReplicas}, back once caught up.` : 'Off for every materialization in Settings.'}
                      />
                    ) : null}
                    <Check
                      checked={form.skip_tombstones}
                      onChange={(value) => update('skip_tombstones', value)}
                      label="Ignore null records"
                      hint="Kafka tombstones. Kept, each is a row with its key."
                    />
                    <Field label="Labels" hint="key=value, comma separated." error={errorFor('labels')} className="sm:col-span-2">
                      <Input value={form.labels} onChange={(event) => update('labels', event.target.value)} placeholder="team=data, tier=gold" spellCheck={false} />
                    </Field>
                  </div>
                ) : null}
              </section>
            </Panel>
          </div>

          <Plan
            tables={form.tables}
            granularity={GRANULARITY[granularity]}
            workers={workers}
            autoscales={autoscales}
            protection={
              catalog
                ? {
                    short: Object.keys(protection).length === 0 ? 'Nothing masked' : `${Object.keys(protection).length} kinds masked`,
                    full: describeChoice(protection, catalog),
                  }
                : null
            }
            skipTombstones={form.skip_tombstones}
            destinationMissing={destinationMissing}
            ready={ready}
            pending={mutation.isPending}
          />
        </form>
      </PageBody>
    </>
  );
}

/** A switch-like checkbox with its one line of why. */
function Check({ checked, onChange, label, hint }: { checked: boolean; onChange: (value: boolean) => void; label: string; hint: string }): ReactNode {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-[3px] size-3.5 shrink-0 cursor-pointer accent-[var(--color-ink)]"
      />
      <span>
        <span className="block text-[13px] font-medium">{label}</span>
        <span className="block text-[12px] text-[var(--color-ink-muted)]">{hint}</span>
      </span>
    </label>
  );
}

/** Exactly what will exist, by the names SQL will use, and what happens next: before anything runs. */
function Plan({
  tables,
  granularity,
  workers,
  autoscales,
  protection,
  skipTombstones,
  destinationMissing,
  ready,
  pending,
}: {
  tables: TableDraft[];
  granularity: string;
  workers: string;
  autoscales: boolean;
  /** How many kinds are masked, and which, for its tooltip. */
  protection: { short: string; full: string } | null;
  skipTombstones: boolean;
  destinationMissing: boolean;
  ready: boolean;
  pending: boolean;
}): ReactNode {
  const count = tables.length;
  return (
    <aside className="min-w-0 self-start lg:sticky lg:top-6">
      <PlanCard
        action={
          <>
            {destinationMissing ? (
              <PlanBlocked>No storage is set up for tables yet. An administrator sets it in Settings, under Materializations.</PlanBlocked>
            ) : null}
            <Button type="submit" variant="primary" className="w-full" disabled={!ready} loading={pending}>
              {count > 1 ? `Create ${count} tables` : 'Create'}
            </Button>
          </>
        }
      >
        {count === 0 ? (
          <PlanNote>Choose a topic, and what it will create shows here.</PlanNote>
        ) : (
          <>
            <PlanGroup title={`Creates ${count} ${count === 1 ? 'table' : 'tables'}, as SQL will read ${count === 1 ? 'it' : 'them'}`}>
              {tables.map((draft) => (
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
            <dl className="space-y-1.5 border-t border-[var(--color-line)] pt-4">
              <PlanRow label="Partitioned">{granularity}</PlanRow>
              <PlanRow label="Workers">
                {workers}
                {autoscales ? ', more when behind' : ''}
              </PlanRow>
              {protection ? (
                <PlanRow label="Protection">
                  <span title={protection.full}>{protection.short}</span>
                </PlanRow>
              ) : null}
              <PlanRow label="Null records">{skipTombstones ? 'Ignored' : 'Kept'}</PlanRow>
            </dl>
            <PlanNote>About a minute: its names are claimed, its topics sampled, its tables created, then its workers start. You can leave; it carries on.</PlanNote>
          </>
        )}
      </PlanCard>
    </aside>
  );
}
