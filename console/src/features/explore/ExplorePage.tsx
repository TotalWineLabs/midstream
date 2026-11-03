import { Compass, History, PanelLeftOpen, Plus } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { Exploration, type ExplorationHandle, type ExplorationState } from './Exploration';
import { ExplorationTabs, ExplorationsMenu } from './ExplorationTabs';
import { OPEN_LIMIT, fromShareLink, newExploration, titleOf } from './explorations';
import { closeTab, openTab } from './store';
import { TablesRail } from './TablesRail';
import { explorationStore, useExplorationList, useStoredFlag, useStoredNumber, useTabStrip } from './useExplorations';
import { useSheet } from './useSheet';
import { useLake } from './useLake';
import type { LakeTable } from './lake';
import { ResizeHandle } from '../data/ResizeHandle';
import { PageHeader } from '@/components/AppShell';
import { TabPanel } from '@/components/TabPanel';
import { useToast } from '@/components/ui/Toast';
import { Button, EmptyState, Panel } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { useDomains } from '@/lib/domains';
import { useMinWidth } from '@/lib/media';
import { explorePath } from '@/lib/paths';

const RAIL_MIN = 220;
const RAIL_MAX = 480;

/**
 * Navigations already acted on: an address that makes an exploration makes one, though React runs a
 * page's effects twice while developing it.
 */
const handled = new Set<string>();

/**
 * Explore (docs/design/explore.md): what does the data say? Explorations side by side, each a
 * workbench over any table the person may read, in any domain - or a statement over the lake - with
 * its questions kept; the lake's tables beside them.
 *
 * Its addresses: `/explore` shows what this browser tab showed, or the most recent exploration, or a
 * new one; `/explore/<id>` that exploration; `/explore/new?…` a new one from a share link.
 */
export function ExplorePage(): ReactNode {
  const { explorationId } = useParams<{ explorationId?: string }>();
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const store = explorationStore();
  const list = useExplorationList();
  const [strip, setStrip] = useTabStrip();
  const lake = useLake();
  const domains = useDomains();
  const many = domains.length > 1;
  const wide = useMinWidth(768);
  const [railOpen, setRailOpen] = useStoredFlag('console.explore.tablesOpen', true);
  const [railWidth, setRailWidth] = useStoredNumber('console.explore.tablesWidth', RAIL_MIN, RAIL_MAX, 280);
  const [historyOpen, setHistoryOpen] = useStoredFlag('console.explore.historyOpen', false);
  // On a phone the rail is a sheet over the page, opened when asked.
  const [railSheet, setRailSheet] = useState(false);
  const railSheetRef = useRef<HTMLDivElement>(null);
  const closeRailSheet = useCallback(() => setRailSheet(false), []);
  useSheet(railSheetRef, !wide && railSheet, closeRailSheet);
  const scope = params.get('domain');
  const suffix = scope ? `?domain=${encodeURIComponent(scope)}` : '';
  const ids = useId();
  const tabId = useCallback((id: string) => `${ids}tab-${id}`, [ids]);
  const panelId = useCallback((id: string) => `${ids}panel-${id}`, [ids]);

  const kept = useMemo(() => new Set(list.map((entry) => entry.id)), [list]);
  const openNow = useRef(strip.open);
  openNow.current = strip.open;
  const keep = useCallback(() => new Set(openNow.current), []);
  const handles = useRef(new Map<string, ExplorationHandle>());
  // Each exploration's ref, made once: a new one every render would render it again for nothing.
  const refs = useRef(new Map<string, (handle: ExplorationHandle | null) => void>());
  const refFor = useCallback((id: string) => {
    let made = refs.current.get(id);
    if (!made) {
      made = (handle) => {
        if (handle) handles.current.set(id, handle);
        else handles.current.delete(id);
      };
      refs.current.set(id, made);
    }
    return made;
  }, []);
  const closeHistory = useCallback(() => setHistoryOpen(false), [setHistoryOpen]);
  const [states, setStates] = useState<Record<string, ExplorationState>>({});
  const onState = useCallback(
    (id: string, state: ExplorationState) =>
      setStates((current) => (JSON.stringify(current[id]) === JSON.stringify(state) ? current : { ...current, [id]: state })),
    [],
  );

  // The router moves the address in a transition, after the strip has changed: until it lands, the
  // address still names where the page was, and the effect below must not act on it - it would open
  // again a tab just closed, or call one just deleted unknown.
  const here = useRef(location.key);
  useLayoutEffect(() => {
    here.current = location.key;
  }, [location.key]);
  const leaving = useRef<string | null>(null);
  const go = useCallback(
    (id: string | null, state?: unknown) => {
      leaving.current = here.current;
      void navigate(`${explorePath(id)}${suffix}`, { replace: true, state });
    },
    [navigate, suffix],
  );

  /** A new exploration, open and shown; refused with eight open. */
  const create = useCallback(
    (init: Parameters<typeof newExploration>[1] = {}): string | null => {
      if (openNow.current.length >= OPEN_LIMIT) {
        toast.error(`${OPEN_LIMIT} explorations are open`, 'Close one to open another: it stays under All explorations.');
        return null;
      }
      const document = newExploration(crypto.randomUUID(), init);
      const { dropped } = store.save(document, new Set([...openNow.current, document.id]));
      if (dropped.length > 0) toast.success('Older explorations were removed to make room', 'This browser keeps the most recent ones.');
      setStrip((current) => openTab(current, document.id, OPEN_LIMIT).strip);
      openNow.current = [...openNow.current, document.id];
      return document.id;
    },
    [store, setStrip, toast],
  );

  // The address says what is shown: make, open or pick the exploration it names.
  useEffect(() => {
    if (leaving.current === location.key) return;
    leaving.current = null;
    if (explorationId === 'new') {
      if (handled.has(location.key)) return;
      handled.add(location.key);
      const made = create(fromShareLink(params));
      go(made ?? strip.shown);
      return;
    }
    if (explorationId) {
      if (!kept.has(explorationId)) {
        if (handled.has(location.key)) return;
        handled.add(location.key);
        toast.error('That exploration is not in this browser', 'Explorations are kept by the browser they were made in.');
        go(null);
        return;
      }
      if (strip.shown === explorationId) return;
      const { strip: next, refused } = openTab(strip, explorationId, OPEN_LIMIT);
      if (refused) {
        toast.error(`${OPEN_LIMIT} explorations are open`, 'Close one to open another: it stays under All explorations.');
        go(strip.shown);
        return;
      }
      setStrip(() => next);
      return;
    }
    // Explore itself: what this tab showed, else the most recent, else a new one - but not after the
    // last one was closed, which leaves the page empty on purpose.
    if (strip.shown) {
      go(strip.shown);
      return;
    }
    if ((location.state as { closed?: boolean } | null)?.closed || handled.has(location.key)) return;
    handled.add(location.key);
    const recent = list[0]?.id;
    if (recent) {
      setStrip((current) => openTab(current, recent, OPEN_LIMIT).strip);
      go(recent);
      return;
    }
    const made = create();
    if (made) go(made);
  }, [explorationId, kept, strip, list, location.key, location.state, params, create, go, setStrip, toast]);

  const shown = strip.shown;
  const shownState = shown ? states[shown] : undefined;
  const labels = useMemo(() => new Map(list.map((entry) => [entry.id, entry.label])), [list]);
  const tabs = strip.open.map((id) => ({ id, label: labels.get(id) ?? 'New exploration' }));

  const close = useCallback(
    (id: string) => {
      const next = closeTab(strip, id);
      setStrip(() => next);
      handles.current.delete(id);
      refs.current.delete(id);
      go(next.shown, next.shown ? undefined : { closed: true });
    },
    [strip, setStrip, go],
  );

  const remove = useCallback(
    (id: string) => {
      // Its edits of the last moment too: Undo brings back what was on screen, and nothing saves it
      // again once it is gone.
      handles.current.get(id)?.flush();
      const document = store.load(id);
      const wasOpen = strip.open.includes(id);
      if (wasOpen) close(id);
      store.remove(id);
      if (!document) return;
      toast.success(`${titleOf(document)} deleted`, undefined, {
        label: 'Undo',
        onClick: () => {
          store.save(document, keep());
          if (wasOpen) {
            setStrip((current) => openTab(current, document.id, OPEN_LIMIT).strip);
            go(document.id);
          }
        },
      });
    },
    [store, strip.open, close, toast, keep, setStrip, go],
  );

  const duplicate = useCallback(
    (id: string) => {
      handles.current.get(id)?.flush();
      const document = store.load(id);
      if (!document) return;
      const made = create({ source: document.source, view: { ...document.view, runId: null }, title: document.title ? `${document.title} (copy)` : null });
      if (made) {
        const copy = store.load(made);
        if (copy) store.save({ ...copy, history: document.history }, keep());
        go(made);
      }
    },
    [store, create, keep, go],
  );

  // The rail acts on the exploration shown, or on a new one when none is.
  const onTable = useCallback(
    (table: LakeTable) => {
      const handle = shown ? handles.current.get(shown) : undefined;
      if (handle) {
        handle.table(table);
        if (!wide) setRailSheet(false);
        return;
      }
      const made = create({ source: table.ref });
      if (made) go(made);
    },
    [shown, create, go, wide],
  );
  const onNewExploration = useCallback(
    (table: LakeTable) => {
      const made = create({ source: table.ref });
      if (made) go(made);
      if (!wide) setRailSheet(false);
    },
    [create, go, wide],
  );
  const copy = useCallback(
    (text: string) => {
      void navigator.clipboard.writeText(text);
      toast.success('Copied', text);
    },
    [toast],
  );
  const onColumn = useCallback(
    (_table: LakeTable, column: string) => {
      const handle = shown ? handles.current.get(shown) : undefined;
      if (!handle?.column(column)) copy(column);
    },
    [shown, copy],
  );

  const currentKey = shownState?.source ? `${shownState.source.domain}.${shownState.source.dataset}.${shownState.source.table}`.toLowerCase() : null;
  const rail = (
    <TablesRail
      lake={lake}
      many={many}
      scope={scope}
      current={currentKey}
      writingSql={shownState?.writingSql ?? false}
      onTable={onTable}
      onNewExploration={onNewExploration}
      onColumn={onColumn}
      onCopy={copy}
      onClose={() => (wide ? setRailOpen(false) : setRailSheet(false))}
      width={wide ? railWidth : null}
    />
  );

  return (
    <div className="flex h-full min-h-[520px] flex-col">
      <PageHeader
        title="Explore"
        wide
        actions={
          <>
            {wide && railOpen ? null : (
              <Button variant="ghost" size="sm" onClick={() => (wide ? setRailOpen(true) : setRailSheet(true))} aria-label="Show the tables" className="max-md:h-11">
                <PanelLeftOpen className="size-4" />
                Tables
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setHistoryOpen((value) => !value)}
              aria-pressed={historyOpen}
              className={cn('max-md:h-11', historyOpen && 'bg-[var(--color-raised)] text-[var(--color-ink)]')}
            >
              <History className="size-4" />
              History
            </Button>
            <ExplorationsMenu
              list={list}
              open={new Set(strip.open)}
              onOpen={(id) => {
                const { strip: next, refused } = openTab(strip, id, OPEN_LIMIT);
                if (refused) {
                  toast.error(`${OPEN_LIMIT} explorations are open`, 'Close one to open another: it stays under All explorations.');
                  return;
                }
                setStrip(() => next);
                go(id);
              }}
              onDuplicate={duplicate}
              onDelete={remove}
              onNew={() => {
                const made = create();
                if (made) go(made);
              }}
            />
          </>
        }
      >
        <div className="px-4 sm:px-6">
          <ExplorationTabs
            tabs={tabs}
            shown={shown}
            tabId={tabId}
            panelId={panelId}
            onShow={(id) => {
              // Shown at once; the address follows.
              setStrip((current) => ({ ...current, shown: id }));
              go(id);
            }}
            onClose={close}
            onNew={() => {
              const made = create();
              if (made) go(made);
            }}
            onRename={(id, title) => handles.current.get(id)?.rename(title)}
          />
        </div>
      </PageHeader>

      <div className="flex min-h-0 flex-1">
        {wide && railOpen ? (
          <>
            {rail}
            <ResizeHandle
              orientation="vertical"
              label="Resize the table list"
              value={railWidth}
              min={RAIL_MIN}
              max={RAIL_MAX}
              onResize={(delta) => setRailWidth((current) => Math.min(RAIL_MAX, Math.max(RAIL_MIN, current + delta)))}
            />
          </>
        ) : null}
        <div className="relative min-w-0 flex-1">
          {strip.open.length === 0 ? (
            <div className="p-4">
              <Panel>
                <EmptyState
                  icon={<Compass className="size-6" />}
                  title="No exploration open"
                  description="An exploration is a table’s rows, or a statement over any tables, with the questions it asked."
                  action={
                    <Button
                      size="sm"
                      onClick={() => {
                        const made = create();
                        if (made) go(made);
                      }}
                    >
                      <Plus className="size-4" />
                      New exploration
                    </Button>
                  }
                />
              </Panel>
            </div>
          ) : (
            strip.open.map((id) => (
              <TabPanel key={id} id={panelId(id)} labelledBy={tabId(id)} shown={id === shown} className="absolute inset-0">
                <Exploration
                  id={id}
                  ref={refFor(id)}
                  lake={lake}
                  many={many}
                  historyOpen={historyOpen}
                  wide={wide}
                  onCloseHistory={closeHistory}
                  onState={onState}
                  keep={keep}
                />
              </TabPanel>
            ))
          )}
        </div>
      </div>

      {!wide && railSheet
        ? createPortal(
            <div ref={railSheetRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Tables" className="slide-in-right fixed inset-0 z-50 flex bg-[var(--color-surface)] outline-none">
              {rail}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
