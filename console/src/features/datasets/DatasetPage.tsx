import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { PageBody, PageHeader } from '@/components/AppShell';
import { RelativeTime } from '@/components/Inline';
import { PlanBlocked, PlanGroup, PlanItem, PlanNote, PlanTable } from '@/components/Plan';
import { StatusLabel } from '@/components/Status';
import { Dialog } from '@/components/ui/Dialog';
import { Popover } from '@/components/ui/Popover';
import { useToast } from '@/components/ui/Toast';
import { Button, EmptyState, Field, Input, Panel, Skeleton } from '@/components/ui/primitives';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useApi, useDomain, useDomainPath } from '@/lib/domains';
import { useFleet } from '@/lib/fleet';
import { formatCount } from '@/lib/format';
import { tablePath } from '@/lib/paths';
import { readFailed } from '@/lib/reads';
import { itemStatus } from '@/lib/status';
import type { CpDatasetDetail, CpDatasetTable } from '@shared/types';

import { tableStatus } from '../tables/TablePage';
import { AccessWord } from './DatasetsPage';
import { SharePopover } from './SharePopover';
import { useRefreshDatasets } from './useDatasets';

/** Read a dataset again: after a change to it, its access, or its tables. */
export function datasetKey(name: string): readonly unknown[] {
  return ['dataset', name];
}

/**
 * One dataset: what is in it, and who can use it (docs/10-design-system.md §10.5). Its tables lead,
 * each with the materialization that writes it and its state. Its owners share it — the people and
 * groups with a role on it, in a popover like a document's (`SharePopover`) — change its
 * description, and delete it once it holds no tables.
 */
export function DatasetPage(): ReactNode {
  const domainPath = useDomainPath();
  const api = useApi();
  const { name = '', tab } = useParams<{ name: string; tab?: string }>();
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const dataset = useQuery({ queryKey: datasetKey(name), queryFn: () => api.dataset(name), refetchInterval: 15_000, retry: 0 });
  const data = dataset.data ?? null;
  const manages = data !== null && can('dataset.manage', data.dataset_id);
  const crumbs = (
    <Link to={domainPath('/datasets')} className="transition-colors hover:text-[var(--color-ink)]">
      Datasets
    </Link>
  );

  // A refresh that fails keeps the page as it was; a final answer does not.
  if (readFailed(dataset)) {
    const missing = dataset.error instanceof ApiError && dataset.error.status === 404;
    return (
      <>
        <PageHeader crumbs={crumbs} title={name} />
        <PageBody>
          <Panel>
            <EmptyState
              title={missing ? `There is no dataset ${name}` : 'The dataset could not be loaded'}
              description={dataset.error instanceof ApiError && !missing ? dataset.error.message : 'It may have been deleted.'}
              action={
                <Link to={domainPath('/datasets')} className="text-[13px] font-medium hover:underline">
                  All datasets
                </Link>
              }
            />
          </Panel>
        </PageBody>
      </>
    );
  }

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title={name}
        subtitle={data?.description || null}
        meta={
          data ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-[var(--color-ink-muted)]">
              <AccessWord dataset={data} />
              <span aria-hidden className="size-[3px] rounded-full bg-[var(--color-ink-faint)]" />
              <span>{data.owners.length ? `Owned by ${data.owners.map((owner) => owner.name).join(', ')}` : 'No owner'}</span>
            </span>
          ) : (
            <Skeleton className="h-5 w-56" />
          )
        }
        actions={
          manages && data ? (
            <>
              <SharePopover dataset={data.name} defaultOpen={tab === 'access'} />
              <Popover
                align="end"
                width={220}
                trigger={({ open, toggle, id }) => (
                  <Button variant="ghost" onClick={toggle} aria-expanded={open} aria-controls={id} aria-label="More actions" className="px-2.5">
                    <MoreHorizontal className="size-4" />
                  </Button>
                )}
              >
                {({ close }) => (
                  <div className="p-1.5" role="menu">
                    <MenuItem
                      icon={<Pencil className="size-4" />}
                      onClick={() => {
                        close();
                        setEditing(true);
                      }}
                    >
                      Edit description…
                    </MenuItem>
                    <MenuItem
                      icon={<Trash2 className="size-4" />}
                      danger
                      onClick={() => {
                        close();
                        setDeleting(true);
                      }}
                    >
                      Delete dataset…
                    </MenuItem>
                  </div>
                )}
              </Popover>
            </>
          ) : null
        }
      />

      {!data ? (
        <PageBody>
          <Skeleton className="h-48" />
        </PageBody>
      ) : (
        <DatasetTables dataset={data} />
      )}

      {data ? (
        <>
          <EditDatasetDialog open={editing} onClose={() => setEditing(false)} dataset={data} />
          <DeleteDatasetDialog open={deleting} onClose={() => setDeleting(false)} dataset={data} />
        </>
      ) : null}
    </>
  );
}

function MenuItem({ icon, danger = false, onClick, children }: { icon: ReactNode; danger?: boolean; onClick: () => void; children: ReactNode }): ReactNode {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-[var(--color-raised)]',
        danger ? 'text-[var(--color-flare-ink)]' : 'text-[var(--color-ink)]',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

/** The tables in it, each with the materialization writing it and its state. */
function DatasetTables({ dataset }: { dataset: CpDatasetDetail }): ReactNode {
  const { can } = useAuth();
  const domainPath = useDomainPath();
  const shown = dataset.tables.filter((table) => table.state !== 'dropped');
  return (
    <PageBody className="space-y-4">
      {dataset.locked ? (
        <p className="flex items-start gap-2 rounded-[var(--radius-control)] bg-[var(--color-raised)] px-4 py-3 text-[13px] text-[var(--color-ink-muted)]">
          <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Locked to you: you see its tables’ names, not their schemas or data. Ask one of its owners to share it with you.
        </p>
      ) : null}
      <Panel className="overflow-hidden">
        <header className="px-5 pt-4 pb-3">
          <h2 className="text-[15px] font-semibold">
            Tables <span className="numeric font-normal text-[var(--color-ink-faint)]">{shown.length}</span>
          </h2>
        </header>
        {shown.length === 0 ? (
          <EmptyState
            title="No tables yet"
            description="A table goes in it when a materialization writes a topic here: choose this dataset for the topic."
            action={
              can('dataset.write', dataset.dataset_id) && can('materializations.create') ? (
                <Link
                  to={domainPath('/materializations/new')}
                  className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-on-primary)] hover:opacity-90"
                >
                  <Plus className="size-4" />
                  New materialization
                </Link>
              ) : null
            }
          />
        ) : (
          <ul className="divide-y divide-[var(--color-line)] border-t border-[var(--color-line)]">
            {shown.map((table) => (
              <TableRow key={`${table.materialization_id}:${table.name}`} dataset={dataset} table={table} />
            ))}
          </ul>
        )}
      </Panel>
    </PageBody>
  );
}

function TableRow({ dataset, table }: { dataset: CpDatasetDetail; table: CpDatasetTable }): ReactNode {
  const domainPath = useDomainPath();
  const domain = useDomain();
  const { can } = useAuth();
  const { data: fleet } = useFleet(domain.id);
  const item = fleet?.items.find((candidate) => candidate.domain === domain.id && candidate.materialization_id === table.materialization_id);
  const status = tableStatus(table, null, item ? itemStatus(item) : null);
  const canOpen = can('materializations.view_details');
  const opens = canOpen && !dataset.locked && (table.state === 'active' || table.state === 'retired');
  const name = (
    <>
      <span className="text-[var(--color-ink-muted)]">{dataset.name}.</span>
      {table.name}
    </>
  );
  return (
    <li
      className={cn(
        'grid gap-x-6 gap-y-1 px-5 py-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center',
        table.state === 'dropping' && 'opacity-60',
      )}
    >
      <div className="min-w-0">
        {opens ? (
          <Link to={domainPath(tablePath(dataset.name, table.name))} className="ident block truncate text-[13px] font-medium hover:underline">
            {name}
          </Link>
        ) : (
          <span className="ident block truncate text-[13px] font-medium">{name}</span>
        )}
        <span className="ident block truncate text-[12px] text-[var(--color-ink-faint)]">{table.source_topic}</span>
      </div>
      <span className="min-w-0 truncate text-[13px] text-[var(--color-ink-muted)]">
        from{' '}
        {canOpen && table.materialization_name !== null ? (
          <Link to={domainPath(`/materializations/${encodeURIComponent(table.materialization_id)}`)} className="text-[var(--color-ink)] hover:underline">
            {table.materialization_name}
          </Link>
        ) : (
          <span className="text-[var(--color-ink)]">{table.materialization_name ?? table.materialization_id}</span>
        )}
      </span>
      <span className="min-w-0 text-[13px]">{status ? <StatusLabel status={status} /> : null}</span>
      <span className="text-[12px] whitespace-nowrap text-[var(--color-ink-faint)] sm:text-right">
        {table.last_commit_at ? <RelativeTime value={table.last_commit_at} prefix="committed" /> : 'nothing committed yet'}
      </span>
    </li>
  );
}

function EditDatasetDialog({ open, onClose, dataset }: { open: boolean; onClose: () => void; dataset: CpDatasetDetail }): ReactNode {
  const api = useApi();
  const [description, setDescription] = useState(dataset.description);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const refresh = useRefreshDatasets();
  const toast = useToast();

  useEffect(() => {
    if (open) {
      setDescription(dataset.description);
      setError(null);
    }
  }, [open, dataset.description]);

  const save = useMutation({
    mutationFn: () => api.updateDataset(dataset.name, { description: description.trim(), base_revision: dataset.revision }),
    onSuccess: async () => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: datasetKey(dataset.name) }), refresh()]);
      toast.success('Description saved', dataset.name);
      onClose();
    },
    onError: (failure: unknown) => setError(failure instanceof ApiError ? failure.message : 'The change could not be saved.'),
  });

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Describe ${dataset.name}`}
      description="What it is for, in a sentence. Its name never changes."
      footer={
        <>
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="edit-dataset" loading={save.isPending} disabled={description.trim() === dataset.description}>
            Save
          </Button>
        </>
      }
    >
      <form id="edit-dataset" onSubmit={onSubmit} className="space-y-3">
        <Field label="Description" error={error}>
          <Input autoFocus value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} />
        </Field>
      </form>
    </Dialog>
  );
}

/** Deleting a dataset, with its plan: refused while it holds tables, which it names; its grants go with it. */
function DeleteDatasetDialog({ open, onClose, dataset }: { open: boolean; onClose: () => void; dataset: CpDatasetDetail }): ReactNode {
  const domainPath = useDomainPath();
  const api = useApi();
  const navigate = useNavigate();
  const refresh = useRefreshDatasets();
  const toast = useToast();
  const remove = useMutation({
    mutationFn: () => api.deleteDataset(dataset.name),
    onSuccess: async () => {
      await refresh();
      toast.success(`${dataset.name} deleted`, 'Its name is free to use again.');
      onClose();
      void navigate(domainPath('/datasets'));
    },
    onError: (failure: unknown) => toast.error('Could not delete the dataset', failure instanceof ApiError ? failure.message : 'Try again in a moment.'),
  });
  const held = dataset.tables.filter((table) => table.state !== 'dropped');
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Delete ${dataset.name}?`}
      footer={
        held.length > 0 ? (
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              Delete {dataset.name}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {held.length > 0 ? (
          <>
            <PlanBlocked>
              It still holds {held.length === 1 ? 'a table' : `${formatCount(held.length)} tables`}. A dataset can be deleted once its tables are gone: dropped, or their
              materializations deleted.
            </PlanBlocked>
            <PlanGroup title="Holds">
              {held.map((table) => (
                <PlanTable
                  key={`${table.materialization_id}:${table.name}`}
                  dataset={dataset.name}
                  name={table.name}
                  detail={`from ${table.materialization_name ?? table.materialization_id}`}
                />
              ))}
            </PlanGroup>
          </>
        ) : (
          <>
            <PlanGroup title="Deletes">
              <PlanItem detail="and who can use it: every grant on it goes with it">
                The dataset <span className="ident">{dataset.name}</span>
              </PlanItem>
            </PlanGroup>
            <PlanNote>Its name is free to use again. This cannot be undone.</PlanNote>
          </>
        )}
      </div>
    </Dialog>
  );
}
