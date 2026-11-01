import { Lock, MoreHorizontal, Pencil, Pin, Play, Square, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { EditMaterializationDialog } from './EditMaterializationDialog';
import { DetailOverviewTab } from './MaterializationOverview';
import { RuntimeTab } from './RuntimeTab';
import { canDelete, canEdit, canResume, canStop, useLifecycleActions } from '../materializations/actions';
import { ProtectionTab } from '../protection/ProtectionTab';
import { PageBody, PageHeader } from '@/components/AppShell';
import { StatusPill } from '@/components/Status';
import { Popover } from '@/components/ui/Popover';
import { Dialog } from '@/components/ui/Dialog';
import { Button, Panel, Skeleton } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { displayName, formatCount } from '@/lib/format';
import { isPinned, togglePin, usePins } from '@/lib/pins';
import { statusOf } from '@/lib/status';
import { TABLE_PARAM, resolveTable } from '../tables/selectedTable';
import { tablePath, type TableTab } from '@/lib/paths';
import { useAuth } from '@/lib/auth';
import { useDetailStream } from '@/lib/live';
import { readableTables, type CpDetail, type CpTableSpec } from '@shared/types';
import { useDomain, useDomainPath } from '@/lib/domains';

/**
 * Each tab, and the dataset permission it needs, beyond seeing the materialization at all, on at
 * least one of its tables' datasets. A table's data, schema and history are on the table's own page.
 */
const TABS = [
  { key: '', label: 'Overview', permission: null },
  { key: 'protection', label: 'Protection', permission: 'dataset.view_schema' },
  { key: 'runtime', label: 'Diagnostics', permission: null },
] as const;

/** The tabs a materialization had for its tables, and where on a table's page each one went. */
const MOVED: Record<string, TableTab> = { data: 'data', schema: 'schema', table: 'history' };

/** Every table a delete removes - written, kept, or still being dropped - in its dataset. */
function tablesRemoved(detail: CpDetail): CpTableSpec[] {
  const leaving = detail.tables
    .filter((record) => record.state === 'dropping')
    .map((record) => ({ name: record.name, source_topic: record.source_topic, dataset: record.dataset, dataset_id: record.dataset_id }));
  return [...readableTables(detail.materialization), ...leaving];
}

export function DetailPage(): ReactNode {
  const domainPath = useDomainPath();
  const { materializationId, tab } = useParams<{ materializationId: string; tab?: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { data } = useDetailStream(materializationId ?? '');
  const { run, pending } = useLifecycleActions();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const { can } = useAuth();
  const { id: domainId } = useDomain();

  if (!materializationId) return <Navigate to={domainPath('/materializations')} replace />;

  const detail = data?.detail ?? null;
  const specs = detail ? readableTables(detail.materialization) : [];
  const tabs = TABS.filter((item) => item.permission === null || specs.some((spec) => can(item.permission, spec.dataset_id)));
  const removed = detail ? tablesRemoved(detail) : [];
  // Deleting takes each table out of its dataset: it needs write access to every one of them.
  const unwritable = [...new Set(removed.filter((spec) => !can('dataset.write', spec.dataset_id)).map((spec) => spec.dataset))];
  // A tab you may not open — from a shared link, say — falls back to the overview.
  const activeTab = tabs.some((item) => item.key === (tab ?? '')) ? (tab ?? '') : '';

  // An address from before tables had pages: the table it named, on its own page, as it was asked for.
  const moved = tab ? MOVED[tab] : undefined;
  if (moved && detail) {
    const spec = resolveTable(specs, searchParams.get(TABLE_PARAM));
    if (spec) {
      const rest = new URLSearchParams(searchParams);
      rest.delete(TABLE_PARAM);
      const query = moved === 'data' && rest.size > 0 ? `?${rest.toString()}` : '';
      return <Navigate to={`${domainPath(tablePath(spec.dataset, spec.name, moved))}${query}`} replace />;
    }
  }

  if (data && !detail && data.error) {
    return (
      <PageBody>
        <Panel className="p-8 text-center">
          <p className="text-sm font-medium">Cannot reach the control plane</p>
          <p className="mt-1 text-[13px] text-[var(--color-ink-muted)]">{data.error}</p>
        </Panel>
      </PageBody>
    );
  }

  return (
    <>
      <PageHeader
        crumbs={
          <Link to={domainPath('/materializations')} className="transition-colors hover:text-[var(--color-ink)]">
            Materializations
          </Link>
        }
        title={detail ? displayName(detail.materialization) : materializationId}
        meta={
          detail && activeTab !== '' ? (
            <StatusPill status={headerStatus(detail)} animate={false} />
          ) : null
        }
        actions={
          detail ? (
            <>
              <PinButton domain={domainId} id={materializationId} label={displayName(detail.materialization)} />
              {canEdit(detail) && can('materializations.edit') ? (
                <Button variant="ghost" onClick={() => setEditing(true)}>
                  <Pencil className="size-3.5" />
                  Edit
                </Button>
              ) : null}
              {canResume(detail) && can('materializations.resume') ? (
                <Button
                  variant="primary"
                  onClick={() => run('resume', materializationId, undefined, displayName(detail.materialization))}
                  loading={pending === 'resume'}
                >
                  <Play className="size-4" />
                  Resume
                </Button>
              ) : null}
              {canStop(detail) && can('materializations.stop') ? (
                <Button onClick={() => run('stop', materializationId, undefined, displayName(detail.materialization))} loading={pending === 'stop'}>
                  <Square className="size-3.5" />
                  Stop
                </Button>
              ) : null}
              {canDelete(detail) && can('materializations.delete') ? (
                <Popover
                  align="end"
                  width={200}
                  trigger={({ open, toggle, id }) => (
                    <Button variant="ghost" onClick={toggle} aria-expanded={open} aria-controls={id} aria-label="More actions" className="px-2.5">
                      <MoreHorizontal className="size-4" />
                    </Button>
                  )}
                >
                  {({ close }) => (
                    <div className="p-1.5" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          close();
                          setConfirmDelete(true);
                        }}
                        className="flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-2 text-left text-[13px] text-[var(--color-flare-ink)] transition-colors hover:bg-[var(--color-raised)]"
                      >
                        <Trash2 className="size-4" />
                        Delete…
                      </button>
                    </div>
                  )}
                </Popover>
              ) : null}
            </>
          ) : null
        }
      >
        <div className="mx-auto max-w-[1400px] overflow-x-auto px-4 sm:px-6">
          <nav className="-mb-px flex gap-1" role="tablist">
            {tabs.map((item) => {
              const active = activeTab === item.key;
              return (
                <button
                  key={item.key}
                  role="tab"
                  aria-selected={active}
                  type="button"
                  onClick={() => navigate(domainPath(`/materializations/${materializationId}${item.key ? `/${item.key}` : ''}`), { replace: true })}
                  className={cn(
                    'border-b-2 px-3 pb-2.5 text-[13px] font-medium whitespace-nowrap transition-colors',
                    active
                      ? 'border-[var(--color-ink)] text-[var(--color-ink)]'
                      : 'border-transparent text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
                  )}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>
        </div>
      </PageHeader>

      {!data ? (
        <PageBody className="space-y-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-64" />
        </PageBody>
      ) : activeTab === 'protection' ? (
        <ProtectionTab snapshot={data} />
      ) : activeTab === 'runtime' ? (
        <RuntimeTab snapshot={data} />
      ) : (
        <DetailOverviewTab snapshot={data} />
      )}

      {detail ? (
        <>
          <EditMaterializationDialog open={editing} onClose={() => setEditing(false)} detail={detail} />
        </>
      ) : null}

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${detail ? displayName(detail.materialization) : materializationId}?`}
        description={`This permanently deletes ${removed.length === 1 ? 'its table and its data' : `its ${removed.length} tables and their data`}. Queries on ${removed.length === 1 ? 'it' : 'them'} stop working. The source topics are not touched.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={pending === 'delete'}
              disabled={unwritable.length > 0}
              onClick={() => {
                run('delete', materializationId, undefined, detail ? displayName(detail.materialization) : materializationId);
                setConfirmDelete(false);
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[13px] leading-relaxed">
          {/* Every table it removes, named, with what it holds: the consequence, before it happens. */}
          <ul className="divide-y divide-[var(--color-line)] rounded-[var(--radius-control)] border border-[var(--color-line)]">
            {removed.map((spec) => {
              const record = detail?.tables.find((table) => table.name === spec.name);
              return (
                <li key={`${spec.dataset}.${spec.name}`} className="flex items-center gap-2 px-3 py-2">
                  <code className="ident min-w-0 flex-1 truncate">
                    {spec.dataset}.{spec.name}
                  </code>
                  {can('dataset.write', spec.dataset_id) ? null : <Lock className="size-3 text-[var(--color-ink-faint)]" aria-label="no write access" />}
                  {record ? <span className="numeric shrink-0 text-[var(--color-ink-muted)]">{formatCount(record.totals.records ?? 0)} rows</span> : null}
                </li>
              );
            })}
          </ul>
          {unwritable.length > 0 ? (
            <p className="text-[var(--color-flare-ink)]">
              Deleting needs write access to {unwritable.join(' and ')}: ask {unwritable.length === 1 ? 'its' : 'their'} owners.
            </p>
          ) : (
            <p className="text-[12px] text-[var(--color-ink-faint)]">
              Where the control plane keeps deleted tables' files, they stay in storage, out of every dataset. Their names are
              free to use again.
            </p>
          )}
        </div>
      </Dialog>
    </>
  );
}

/** The state the header shows on every tab but the overview, whose readout says it. */
function headerStatus(detail: CpDetail) {
  return statusOf({
    desired: detail.status.desired_phase,
    observed: detail.status.observed_phase,
    reason: detail.status.phase_reason,
    health: detail.status.runtime_health.level,
    healthReason: detail.status.runtime_health.reason,
    everRan: detail.status.last_heartbeat != null || detail.status.runtime_progress !== undefined,
  });
}

/** Keep it in the sidebar, to come back to. */
function PinButton({ domain, id, label }: { domain: string; id: string; label: string }): ReactNode {
  const pins = usePins();
  const pinned = isPinned(pins, { kind: 'materialization', domain, id });
  return (
    <Button
      variant="ghost"
      onClick={() => togglePin({ kind: 'materialization', domain, id, label })}
      aria-pressed={pinned}
      aria-label={pinned ? 'Unpin from the sidebar' : 'Pin to the sidebar'}
      title={pinned ? 'Unpin from the sidebar' : 'Pin to the sidebar'}
      className={cn('px-2.5', pinned && 'text-[var(--color-ink)]')}
    >
      <Pin className={cn('size-4', pinned && 'fill-current')} />
    </Button>
  );
}
