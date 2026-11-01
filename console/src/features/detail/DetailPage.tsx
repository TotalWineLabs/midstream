import { Lock, MoreHorizontal, Pencil, Pin, Play, Square, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { EditMaterializationDialog } from './EditMaterializationDialog';
import { DetailOverviewTab } from './MaterializationOverview';
import { RuntimeTab } from './RuntimeTab';
import { TableTab } from './TableTab';
import { canDelete, canEdit, canResume, canStop, useLifecycleActions } from '../materializations/actions';
import { DataTab } from '../data/DataTab';
import { ProtectionTab } from '../protection/ProtectionTab';
import { SchemaTab } from '../schema/SchemaTab';
import { LiveIndicator, PageBody, PageHeader } from '@/components/AppShell';
import { StatusPill } from '@/components/Status';
import { Popover } from '@/components/ui/Popover';
import { Dialog } from '@/components/ui/Dialog';
import { Button, Panel, Skeleton } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { displayName } from '@/lib/format';
import { isPinned, togglePin, usePins } from '@/lib/pins';
import { statusOf } from '@/lib/status';
import { TABLE_PARAM } from '../tables/selectedTable';
import { useAuth } from '@/lib/auth';
import { useDetailStream } from '@/lib/live';
import { readableTables, type CpDetail, type CpTableSpec } from '@shared/types';
import { useDomain, useDomainPath } from '@/lib/domains';

/**
 * Each tab, and the dataset permission it needs, beyond seeing the materialization at all, on at
 * least one of its tables' datasets: the Schema tab shows the tables whose schemas the person may
 * see, the Data tab those they may query.
 */
const TABS = [
  { key: '', label: 'Overview', permission: null },
  { key: 'schema', label: 'Schema', permission: 'dataset.view_schema' },
  { key: 'data', label: 'Data', permission: 'data.query' },
  { key: 'table', label: 'Tables', permission: null },
  { key: 'protection', label: 'Protection', permission: 'dataset.view_schema' },
  { key: 'runtime', label: 'Diagnostics', permission: null },
] as const;

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
  const { data, status } = useDetailStream(materializationId ?? '');
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
            <>
              <StatusPill status={headerStatus(detail)} animate={false} />
              <LiveIndicator status={status} generatedAt={data?.generatedAt} error={data?.error ?? null} compact />
            </>
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
                  onClick={() => {
                    // The table chosen on one tab is the one the next shows.
                    const table = searchParams.get(TABLE_PARAM);
                    const query = table ? `?${TABLE_PARAM}=${encodeURIComponent(table)}` : '';
                    navigate(domainPath(`/materializations/${materializationId}${item.key ? `/${item.key}` : ''}${query}`), {
                      replace: true,
                    });
                  }}
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
      ) : activeTab === 'schema' ? (
        <SchemaTab materializationId={materializationId} snapshot={data} />
      ) : activeTab === 'data' ? (
        <DataTab materializationId={materializationId} snapshot={data} />
      ) : activeTab === 'table' ? (
        <TableTab snapshot={data} />
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
        title="Delete materialization?"
        description={`The runtime, its Kafka topics and its consumer group are removed, and so ${
          removed.length > 1 ? `are its ${removed.length} Iceberg tables` : 'is its Iceberg table'
        } with every file in them — unless the control plane has destination cleanup turned off, when the tables leave their datasets but their files stay. The source topics themselves are not touched. This cannot be undone.`}
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
          <div>
            <p className="text-[var(--color-ink-muted)]">
              {removed.length === 1 ? 'This table leaves its dataset' : 'These tables leave their datasets'}, and anyone’s queries of them
              stop working; their names are free to be used again:
            </p>
            <ul className="mt-1.5 space-y-0.5">
              {removed.map((spec) => (
                <li key={`${spec.dataset}.${spec.name}`} className="flex items-center gap-1.5">
                  <code className="numeric">
                    {spec.dataset}.{spec.name}
                  </code>
                  {can('dataset.write', spec.dataset_id) ? null : <Lock className="size-3 text-[var(--color-ink-faint)]" aria-label="no write access" />}
                </li>
              ))}
            </ul>
          </div>
          {unwritable.length > 0 ? (
            <p className="text-[var(--color-phase-failed)]">
              Deleting needs write access to {unwritable.join(' and ')}, which you do not have: ask {unwritable.length === 1 ? 'its' : 'their'}{' '}
              owners.
            </p>
          ) : (
            <p className="text-[var(--color-ink-muted)]">
              Deletion is asynchronous and multi-stage: runtime teardown, observation confirmation, Kafka cleanup, then
              control-plane record removal.
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
