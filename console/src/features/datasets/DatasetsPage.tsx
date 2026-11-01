import { FolderOpen, Lock, Plus, Search } from 'lucide-react';
import { useDeferredValue, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { PageBody, PageHeader } from '@/components/AppShell';
import { Button, EmptyState, Input, Panel, Skeleton } from '@/components/ui/primitives';
import { ApiError } from '@/lib/api';
import { useConsoleAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { DomainProvider, useDomainPath, useDomains, useOptionalDomain } from '@/lib/domains';
import { formatExact } from '@/lib/format';
import type { ConsoleDomain, CpDataset } from '@shared/types';

import { ChooseDomainDialog } from '../domains/ChooseDomainDialog';
import { HiddenDomains } from '../domains/HiddenDomains';

import { CreateDatasetDialog } from './CreateDatasetDialog';
import { useDatasets } from './useDatasets';

const GRID = 'grid items-center gap-x-6 gap-y-1 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)_minmax(0,1fr)_88px]';

/** Whether a dataset matches a search: its name, description or a table's name, without regard to case. */
export function matchesDataset(dataset: Pick<CpDataset, 'name' | 'description' | 'tables'>, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return true;
  return [dataset.name, dataset.description, ...dataset.tables].some((value) => value.toLowerCase().includes(wanted));
}

/**
 * Every dataset: what it is for, who owns it and the tables in it. Datasets the person cannot read
 * are listed too, locked: their names and tables are no secret, their schemas and data are.
 *
 * Inside a domain, its datasets; on the console's page, every domain's, grouped by domain, each
 * domain's read from it as the person is there (handbook 20).
 */
export function DatasetsPage(): ReactNode {
  const scope = useOptionalDomain();
  const consoleAuth = useConsoleAuth();
  const domains = useDomains();
  const location = useLocation();
  const [search, setSearch] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [creatingIn, setCreatingIn] = useState<ConsoleDomain | null>(null);
  const query = useDeferredValue(search);
  const shown = (scope ? [scope] : domains).filter((domain) => domain.status !== 'misconfigured');
  const readable = shown.filter((domain) => consoleAuth.forDomain(domain.id).can('datasets.view'));
  const unreadable = shown.filter((domain) => !consoleAuth.forDomain(domain.id).can('datasets.view'));
  const creatable = shown.filter((domain) => consoleAuth.forDomain(domain.id).can('datasets.create'));
  const many = !scope && domains.length > 1;
  const create = (): void => {
    if (creatable.length === 1) setCreatingIn(creatable[0]!);
    else setChoosing(true);
  };

  return (
    <>
      <PageHeader
        title="Datasets"
        actions={
          creatable.length > 0 ? (
            <Button variant="primary" onClick={create}>
              <Plus className="size-4" />
              New dataset
            </Button>
          ) : null
        }
      >
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3 px-4 pb-4 sm:px-6">
          <div className="relative min-w-[240px] flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--color-ink-faint)]" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by name, description or table"
              className="pl-9"
              aria-label="Search datasets"
            />
          </div>
        </div>
      </PageHeader>

      <PageBody className="space-y-5">
        {readable.map((domain) => (
          <DomainProvider key={domain.id} domain={domain}>
            <DatasetGroup
              title={many ? domain.name : null}
              query={query}
              canCreate={consoleAuth.forDomain(domain.id).can('datasets.create')}
              onCreate={() => setCreatingIn(domain)}
            />
          </DomainProvider>
        ))}
        {many && unreadable.length > 0 ? (
          <HiddenDomains
            what="datasets"
            hidden={unreadable.map((domain) => ({
              domain: domain.id,
              name: domain.name,
              access: consoleAuth.forDomain(domain.id).signedIn ? 'forbidden' : 'sign_in_required',
              snapshot: null,
            }))}
          />
        ) : null}
        {readable.length === 0 && !many ? (
          <Panel>
            <EmptyState
              icon={<Lock className="size-6" />}
              title="You may not see datasets here"
              action={
                consoleAuth.overall.signedIn ? null : (
                  <Link to="/sign-in" state={{ from: location }} className="text-[13px] font-medium text-[var(--color-ink)] underline-offset-2 hover:underline">
                    Sign in
                  </Link>
                )
              }
            />
          </Panel>
        ) : null}
      </PageBody>

      <ChooseDomainDialog
        open={choosing}
        onClose={() => setChoosing(false)}
        domains={creatable}
        onChoose={setCreatingIn}
        description="A dataset belongs to one domain: its tables are written there and read as <domain>.<dataset>.<table>."
      />
      {creatingIn ? (
        <DomainProvider domain={creatingIn}>
          <CreateDatasetDialog open onClose={() => setCreatingIn(null)} />
        </DomainProvider>
      ) : null}
    </>
  );
}

/** One domain's datasets, as that domain describes them to the person. */
function DatasetGroup({
  title,
  query,
  canCreate,
  onCreate,
}: {
  /** The domain's name, on a page of several; null inside the domain. */
  title: string | null;
  query: string;
  canCreate: boolean;
  onCreate: () => void;
}): ReactNode {
  const datasets = useDatasets();
  const domainPath = useDomainPath();
  const items = useMemo(() => (datasets.data?.datasets ?? []).filter((dataset) => matchesDataset(dataset, query)), [datasets.data, query]);
  const searching = query.trim() !== '';

  return (
    <section aria-label={title ?? undefined} className="space-y-2">
      {title ? (
        <h2 className="flex items-baseline gap-2 px-1 text-[13px] font-semibold tracking-tight">
          <Link to={domainPath('/datasets')} className="hover:underline">
            {title}
          </Link>
          {datasets.data ? <span className="numeric text-[12px] font-normal text-[var(--color-ink-faint)]">{formatExact(items.length)}</span> : null}
        </h2>
      ) : null}
      <Panel className="overflow-hidden">
        {title && searching && datasets.data && items.length === 0 ? (
          <p className="px-5 py-3 text-[13px] text-[var(--color-ink-muted)]">No matches.</p>
        ) : (
          <>
            <div className={cn(GRID, 'hidden border-b border-[var(--color-line)] px-5 py-2 text-[12px] text-[var(--color-ink-faint)] sm:grid')}>
              <span>Dataset</span>
              <span>Tables</span>
              <span>Owners</span>
              <span className="text-right">Your access</span>
            </div>
            {datasets.isPending ? (
              <div className="space-y-px p-5">
                {[0, 1, 2].map((index) => (
                  <Skeleton key={index} className="h-12" />
                ))}
              </div>
            ) : datasets.isError ? (
              <EmptyState
                title="Datasets could not be loaded"
                description={datasets.error instanceof ApiError ? datasets.error.message : 'Try again in a moment.'}
              />
            ) : items.length === 0 ? (
              <EmptyState
                icon={<FolderOpen className="size-6" />}
                title={searching ? 'No matches' : 'No datasets yet'}
                description={
                  searching
                    ? 'Try a different search.'
                    : 'A dataset groups tables under one name, and is shared on its own: SQL reads each table as dataset.table.'
                }
                action={
                  !searching && canCreate ? (
                    <Button variant="primary" onClick={onCreate}>
                      <Plus className="size-4" />
                      New dataset
                    </Button>
                  ) : null
                }
              />
            ) : (
              <ul className="divide-y divide-[var(--color-line)]">
                {items.map((dataset) => (
                  <DatasetRow key={dataset.dataset_id} dataset={dataset} to={domainPath(`/datasets/${encodeURIComponent(dataset.name)}`)} />
                ))}
              </ul>
            )}
          </>
        )}
      </Panel>
    </section>
  );
}

function DatasetRow({ dataset, to }: { dataset: CpDataset; to: string }): ReactNode {
  return (
    <li>
      <Link to={to} className={cn(GRID, 'px-5 py-3 transition-colors hover:bg-[var(--color-raised)]')}>
        <div className="min-w-0">
          <p className="ident flex items-center gap-1.5 truncate text-[13px] font-medium">
            {dataset.name}
            {dataset.locked ? <Lock className="size-3 shrink-0 text-[var(--color-ink-faint)]" aria-label="locked" /> : null}
          </p>
          {dataset.description ? (
            <p className="mt-0.5 truncate text-[12px] text-[var(--color-ink-muted)]" title={dataset.description}>
              {dataset.description}
            </p>
          ) : null}
        </div>
        <p className="truncate text-[12px] text-[var(--color-ink-muted)]" title={dataset.tables.join('\n')}>
          {dataset.table_count === 0 ? (
            <span className="text-[var(--color-ink-faint)]">No tables yet</span>
          ) : (
            <>
              <span className="numeric text-[var(--color-ink)]">
                {formatExact(dataset.table_count)} {dataset.table_count === 1 ? 'table' : 'tables'}
              </span>
              <span className="ident"> · {dataset.tables.slice(0, 3).join(', ')}</span>
              {dataset.table_count > 3 ? ', …' : ''}
            </>
          )}
        </p>
        <p className="truncate text-[12px] text-[var(--color-ink-muted)]" title={dataset.owners.map((owner) => owner.email ?? owner.name).join('\n')}>
          {dataset.owners.length ? dataset.owners.map((owner) => owner.name).join(', ') : 'No owner'}
        </p>
        <span className="text-[12px] sm:text-right">
          <AccessWord dataset={dataset} />
        </span>
      </Link>
    </li>
  );
}

/** What the person may do with a dataset, in a word: a role, or locked. Words, not a state's colour. */
export function AccessWord({ dataset }: { dataset: Pick<CpDataset, 'permissions' | 'locked' | 'name'> }): ReactNode {
  if (dataset.permissions.includes('dataset.manage')) return <span className="text-[var(--color-ink)]">Owner</span>;
  if (dataset.permissions.includes('dataset.write')) return <span className="text-[var(--color-ink)]">Writer</span>;
  if (!dataset.locked) return <span className="text-[var(--color-ink-muted)]">Reader</span>;
  return (
    <span className="inline-flex items-center gap-1 text-[var(--color-ink-faint)]" title={`Its schemas and data need a role on ${dataset.name}: ask one of its owners.`}>
      <Lock className="size-3" aria-hidden />
      Locked
    </span>
  );
}
