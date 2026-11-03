import { Compass } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { fromView, shareLink } from '../explore/explorations';
import { readViewState, writeViewState, type WorkbenchView } from './viewState';
import { Workbench } from './Workbench';
import type { WorkbenchSource } from './scope';
import { namedTable } from '../tables/selectedTable';
import { PageBody } from '@/components/AppShell';
import { useTabShown } from '@/components/TabPanel';
import { Skeleton } from '@/components/ui/primitives';
import { useAuth } from '@/lib/auth';
import { useDomain } from '@/lib/domains';
import type { DetailSnapshot } from '@shared/types';
import { readableTables } from '@shared/types';

/**
 * A table's rows, on its page: the workbench (`Workbench.tsx`) on the page's table, its view kept in
 * the address bar.
 *
 * The address bar seeds the view once; from then on the view drives it, while the tab is shown, and
 * writes it back when the tab is shown again (§11.4a). Copying the address shares the view; reloading
 * restores it, and picks the run on screen back up.
 */
export function DataTab({
  materializationId,
  snapshot,
  table,
}: {
  materializationId: string;
  snapshot: DetailSnapshot;
  /** The table: its name in its materialization, which writes it. */
  table: string;
}): ReactNode {
  const domain = useDomain();
  const { can } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const initial = useRef(readViewState(searchParams)).current;
  const tabShown = useTabShown();

  // Kept tables too: their topics were removed, but they stay readable in their datasets.
  const materialization = snapshot.detail?.materialization;
  const spec = useMemo(
    () => (materialization ? namedTable(readableTables(materialization), table, (candidate) => can('data.query', candidate.dataset_id)) : null),
    // `can` is made anew for every render: the table's own spelling and dataset are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [materialization, table],
  );
  const source = useMemo<WorkbenchSource | null>(
    () =>
      spec
        ? { domain: domain.id, dataset: spec.dataset, table: spec.name, datasetId: spec.dataset_id, materializationId }
        : null,
    [domain.id, spec, materializationId],
  );

  // The view as the workbench last said it, written to the address bar while the tab is shown.
  const latest = useRef<WorkbenchView | null>(null);
  const params = useRef(searchParams);
  params.current = searchParams;
  const mirror = useCallback(
    (view: WorkbenchView) => {
      // The table is the page's own address, never the query's. Replaced, not pushed: a page turn
      // is not a navigation.
      const next = writeViewState({ ...view, table: null });
      if (next.toString() !== params.current.toString()) setSearchParams(next, { replace: true });
    },
    [setSearchParams],
  );
  const onViewChange = useCallback(
    (view: WorkbenchView) => {
      latest.current = view;
      mirror(view);
    },
    [mirror],
  );
  // The address changed under the shown tab - the view is what the tab shows, so it goes back.
  useEffect(() => {
    if (tabShown && latest.current) mirror(latest.current);
  }, [searchParams, tabShown, mirror]);

  const share = useMemo(
    () => ({ link: () => window.location.href, title: 'Copy a link that reopens this view', note: 'It reopens this exact view.' }),
    [],
  );
  // The question on screen, carried into a new exploration - its run too, picked back up there.
  const navigate = useNavigate();
  const actions = useMemo(
    () =>
      source
        ? [
            {
              key: 'explore',
              icon: <Compass className="size-3.5" />,
              label: 'Open in Explore',
              title: 'Carry this question into a new exploration',
              onSelect: () => {
                if (latest.current) void navigate(shareLink(source, fromView(latest.current)));
              },
            },
          ]
        : [],
    [source, navigate],
  );

  return (
    <PageBody>
      {source ? (
        <Workbench
          source={source}
          snapshot={snapshot}
          initialView={initial}
          onViewChange={onViewChange}
          share={share}
          actions={actions}
          frameClassName="h-[calc(100dvh-196px)] min-h-[560px]"
        />
      ) : (
        <div className="space-y-3">
          <Skeleton className="h-10" />
          <Skeleton className="h-[560px]" />
        </div>
      )}
    </PageBody>
  );
}
