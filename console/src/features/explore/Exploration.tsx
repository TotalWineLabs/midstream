import { Code2, Compass, Table2 } from 'lucide-react';
import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';

import { HistoryColumn } from './HistoryColumn';
import { TableChooser } from './TableChooser';
import { useTableWriter } from './TablesRail';
import {
  changesWhatIsShown,
  fromView,
  fullName,
  newExploration,
  questionOf,
  recordQuestion,
  settleQuestion,
  shareLink,
  toView,
  viewOfQuestion,
  type Exploration as Document,
  type Question,
  type StoredView,
} from './explorations';
import { findTable, type LakeDomain, type LakeTable } from './lake';
import { explorationStore } from './useExplorations';
import { Workbench, type QuestionEvent, type WorkbenchHandle } from '../data/Workbench';
import { sameTable, type WorkbenchSource } from '../data/scope';
import type { WorkbenchView } from '../data/viewState';
import { useTabShown } from '@/components/TabPanel';
import { Button, EmptyState, Panel, Skeleton } from '@/components/ui/primitives';
import { DomainProvider, useConsoleConfig } from '@/lib/domains';
import { useDetailStream } from '@/lib/live';
import type { TableRef } from '@shared/types';

/** How long after the last change of a view it is kept: a burst of edits is written once. */
const SAVE_AFTER_MS = 300;

/** What the page does to an exploration from outside it: the Tables rail's choices, a new name. */
export interface ExplorationHandle {
  /** A table chosen: browsed here, or its name put in the statement while it writes SQL. */
  table: (table: LakeTable) => void;
  /** A column chosen: its name put in the statement while it writes SQL; false otherwise. */
  column: (name: string) => boolean;
  rename: (title: string | null) => void;
  /** Keep now what is waiting to be kept: before the page reads the document to delete or copy it. */
  flush: () => void;
}

/** What the page shows of an exploration around it: the rail's current table and what a choice does. */
export interface ExplorationState {
  source: TableRef | null;
  writingSql: boolean;
}

/**
 * One exploration (docs/design/explore.md §5): its workbench over the table it is about - or a
 * statement over the lake - and its history. While it is open it owns its document, kept as it
 * changes: a view's edits a moment after the last, a question as it is asked.
 *
 * Kept as it is while the page around it changes for other reasons - another exploration saved, the
 * list of them grown.
 */
export const Exploration = memo(function Exploration({
  id,
  lake,
  many,
  historyOpen,
  wide,
  onCloseHistory,
  onState,
  keep,
  ref,
}: {
  id: string;
  lake: readonly LakeDomain[];
  many: boolean;
  historyOpen: boolean;
  /** Desktop width: history is a column, not a sheet. */
  wide: boolean;
  onCloseHistory: () => void;
  onState: (id: string, state: ExplorationState) => void;
  /** The explorations open now, which a full storage never lets go. */
  keep: () => ReadonlySet<string>;
  ref?: Ref<ExplorationHandle>;
}): ReactNode {
  const shown = useTabShown();
  const store = explorationStore();
  // What is shown of the document; `latest` is the document itself, its view as the workbench last said.
  const [doc, setDoc] = useState<Document>(() => store.load(id) ?? newExploration(id));
  const latest = useRef(doc);
  const pending = useRef<number | null>(null);
  // The question on screen, which Streaming's runs and History's choices follow.
  const [onScreen, setOnScreen] = useState<string | null>(() => doc.history[0]?.id ?? null);
  const onScreenRef = useRef(onScreen);
  onScreenRef.current = onScreen;
  const [running, setRunning] = useState(false);
  // What the workbench is mounted with: a new key mounts it afresh, on another question.
  const [mount, setMount] = useState<{ key: number; view: StoredView; opening: 'run' | 'wait' }>(() => ({ key: 0, view: doc.view, opening: 'run' }));
  const bench = useRef<WorkbenchHandle | null>(null);

  const persist = useCallback(() => {
    if (pending.current !== null) {
      window.clearTimeout(pending.current);
      pending.current = null;
    }
    store.save(latest.current, keep());
  }, [store, keep]);

  /**
   * The document, changed: kept at once, or a moment after the last of a burst of view edits.
   *
   * Rendered again only when what it shows changes - the table, whether it writes SQL, its history:
   * a view is the workbench's to show, so a keystroke renders the workbench and not the exploration
   * around it. An update for each keystroke would also outrun React: a keystroke's own commit runs
   * the effect that reports it, and an update made there waits for the next keystroke, until React
   * calls the chain endless.
   */
  const commit = useCallback(
    (next: Document, at: 'now' | 'soon') => {
      const before = latest.current;
      latest.current = next;
      if (changesWhatIsShown(before, next)) setDoc(next);
      if (at === 'now') {
        persist();
        return;
      }
      if (pending.current !== null) window.clearTimeout(pending.current);
      pending.current = window.setTimeout(persist, SAVE_AFTER_MS);
    },
    [persist],
  );
  // Leaving keeps what was changed.
  useEffect(
    () => () => {
      if (pending.current !== null) persist();
    },
    [persist],
  );

  const table = findTable(lake, doc.source);
  const lakeKnown = lake.length > 0 && lake.every((domain) => !domain.loading);
  // Only a table the person may browse is looked up and browsed: the server would refuse the rest,
  // and the page says why instead of starting what it knows will fail.
  const browsable = table?.browsable ?? false;
  const writer = useTableWriter(browsable ? table : null);
  // Made again only when where the table is changes - not with every frame the lake is rebuilt on.
  const source = useMemo<WorkbenchSource | null>(
    () => (table && browsable && writer.materializationId ? { ...table.ref, datasetId: table.datasetId, materializationId: writer.materializationId } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [table?.key, table?.datasetId, browsable, writer.materializationId],
  );
  const writingSql = doc.view.sql !== null;

  useEffect(() => {
    onState(id, { source: doc.source, writingSql });
  }, [id, doc.source, writingSql, onState]);

  const onViewChange = useCallback(
    (view: WorkbenchView) => {
      const stored = fromView(view);
      if (JSON.stringify(stored) === JSON.stringify(latest.current.view)) return;
      commit({ ...latest.current, view: stored, updatedAt: new Date().toISOString() }, 'soon');
    },
    [commit],
  );

  const onQuestion = useCallback(
    (event: QuestionEvent) => {
      if (event.kind === 'asked') {
        const { exploration, onScreen: first } = recordQuestion(latest.current, questionOf(crypto.randomUUID(), event.request, event.view, event.run));
        setOnScreen(first);
        setRunning(event.run.state === 'running');
        commit(exploration, 'now');
        return;
      }
      setRunning(false);
      const next = settleQuestion(latest.current, event.run, onScreenRef.current);
      if (next !== latest.current) commit(next, 'now');
    },
    [commit],
  );

  /** Mount the workbench afresh on `view`, about `about`. */
  const load = useCallback(
    (about: TableRef | null, view: StoredView, opening: 'run' | 'wait') => {
      commit({ ...latest.current, source: about, view, updatedAt: new Date().toISOString() }, 'now');
      setRunning(false);
      setMount((current) => ({ key: current.key + 1, view, opening }));
    },
    [commit],
  );

  /** Browse a table: the question on screen stays in History, and a new one is asked of it. */
  const browse = useCallback(
    (chosen: LakeTable) => {
      const base = latest.current.view;
      if (!chosen.browsable) {
        // Browsing reads the materialization writing it, which this person may not see: a statement asks it.
        load(null, { ...base, sql: `SELECT *\nFROM ${fullName(chosen.ref)}\nLIMIT 1000`, filters: [], page: 0, visibleColumns: null, pinnedColumn: null, runId: null }, 'run');
        return;
      }
      load(chosen.ref, { ...base, filters: [], sql: null, page: 0, visibleColumns: null, pinnedColumn: null, runId: null }, 'run');
    },
    [load],
  );

  const writeSql = useCallback(() => {
    load(null, { ...latest.current.view, sql: '', filters: [], page: 0, visibleColumns: null, pinnedColumn: null, runId: null }, 'wait');
  }, [load]);

  const openQuestion = useCallback(
    (question: Question) => {
      const view = viewOfQuestion(question, latest.current.view, sameTable(question.source, latest.current.source));
      setOnScreen(question.id);
      load(question.source, view, 'wait');
      // On a phone History is a sheet over the answer: the answer is what was asked for.
      if (!wide) onCloseHistory();
    },
    [load, wide, onCloseHistory],
  );

  useImperativeHandle(
    ref,
    () => ({
      table: (chosen: LakeTable) => {
        if (latest.current.view.sql !== null && bench.current?.insert(fullName(chosen.ref))) return;
        browse(chosen);
      },
      column: (name: string) => bench.current?.insert(/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`) ?? false,
      rename: (title: string | null) => commit({ ...latest.current, title: title?.trim() || null, updatedAt: new Date().toISOString() }, 'now'),
      flush: () => {
        if (pending.current !== null) persist();
      },
    }),
    [browse, commit, persist],
  );

  // Opened since the last render: History slides in then, and not when this exploration opens beside it.
  const historyWasOpen = useRef(historyOpen);
  const historyOpened = historyOpen && !historyWasOpen.current;
  useEffect(() => {
    historyWasOpen.current = historyOpen;
  });

  const config = useConsoleConfig();
  const domains = config.data?.domains ?? [];
  const home = domains.find((domain) => domain.id === config.data?.settingsHome) ?? domains[0] ?? null;
  const sourceDomain = doc.source ? (domains.find((domain) => domain.id === doc.source?.domain) ?? null) : home;
  const share = useMemo(
    () => ({
      link: () => `${window.location.origin}${shareLink(latest.current.source, latest.current.view)}`,
      title: 'Copy a link that asks this question again',
      note: 'It reopens this question for anyone who may read its tables.',
    }),
    [],
  );
  const initialView = useMemo(() => toView(mount.view), [mount.view]);
  const chooser = <TableChooser lake={lake} source={doc.source} many={many} onChoose={browse} />;

  let content: ReactNode;
  if (!doc.source && !writingSql) {
    content = (
      <Panel>
        <EmptyState
          icon={<Compass className="size-6" />}
          title="Explore any table you may read"
          description="Browse a table’s rows, or write SQL over any tables, in any domain, joined by their full names."
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              {chooser}
              <Button variant="secondary" size="sm" onClick={writeSql}>
                <Code2 className="size-3.5" />
                Write SQL
              </Button>
            </div>
          }
        />
      </Panel>
    );
  } else if (doc.source && (!lakeKnown || writer.pending) && !source) {
    content = <Loading />;
  } else if (doc.source && !source) {
    // Readable, though not browsable: a statement reads it without the materialization's detail.
    const asSql = table !== null && table.queryable && !table.browsable;
    content = (
      <Panel>
        <EmptyState
          icon={<Table2 className="size-6" />}
          title={`${fullName(doc.source)} is not one you may browse`}
          description={
            table?.locked
              ? `Its dataset is locked to you. Ask one of the owners of ${doc.source.dataset} for a role on it.`
              : asSql
                ? 'You may query this table, but not browse it.'
                : table
                  ? `You may not query its dataset. Ask one of the owners of ${doc.source.dataset} for a role on it.`
                  : 'It may have been dropped, or its domain cannot be reached right now.'
          }
          action={
            asSql && table ? (
              <Button size="sm" onClick={() => browse(table)}>
                <Code2 className="size-3.5" />
                Query it with SQL
              </Button>
            ) : (
              // Another table: the one named is the one that cannot be opened.
              <TableChooser lake={lake} source={null} many={many} onChoose={browse} />
            )
          }
        />
      </Panel>
    );
  } else if (sourceDomain === null) {
    content = <Loading />;
  } else {
    content = (
      <DomainProvider domain={sourceDomain}>
        {source ? (
          <SourceBench
            key={`${source.domain}.${source.dataset}.${source.table}`}
            benchKey={mount.key}
            source={source}
            shown={shown}
            benchRef={bench}
            initialView={initialView}
            opening={mount.opening}
            onViewChange={onViewChange}
            onQuestion={onQuestion}
            share={share}
            leading={writingSql ? null : chooser}
          />
        ) : (
          <Workbench
            key={`lake:${mount.key}`}
            ref={bench}
            source={null}
            snapshot={null}
            initialView={initialView}
            opening={mount.opening}
            onViewChange={onViewChange}
            onQuestion={onQuestion}
            share={share}
            frameClassName="h-full min-h-0"
            pollWhileHidden
          />
        )}
      </DomainProvider>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col p-3 sm:p-4">{content}</div>
      {historyOpen ? (
        <HistoryColumn
          history={doc.history}
          onScreen={onScreen}
          running={running}
          onOpen={openQuestion}
          onClose={onCloseHistory}
          sheet={!wide}
          slide={historyOpened}
        />
      ) : null}
    </div>
  );
});

/**
 * The workbench over a table, fed by the live detail of the materialization writing it - while shown.
 * Mounted once per table: another question about it mounts a new workbench (`benchKey`) inside, and
 * the table's detail stays, so the frame never drops to a skeleton between two questions.
 */
function SourceBench({
  source,
  benchKey,
  shown,
  benchRef,
  initialView,
  opening,
  onViewChange,
  onQuestion,
  share,
  leading,
}: {
  source: WorkbenchSource;
  /** The question on screen: a new one mounts the workbench afresh. */
  benchKey: number;
  shown: boolean;
  benchRef: Ref<WorkbenchHandle>;
  initialView: WorkbenchView;
  opening: 'run' | 'wait';
  onViewChange: (view: WorkbenchView) => void;
  onQuestion: (event: QuestionEvent) => void;
  share: { link: () => string; title: string; note: string };
  leading: ReactNode;
}): ReactNode {
  // Out of sight it holds no connection open: its last frame stays, and it catches up when shown.
  const detail = useDetailStream(source.materializationId, { enabled: shown });
  if (!detail.data) return <Loading />;
  return (
    <Workbench
      key={benchKey}
      ref={benchRef}
      source={source}
      snapshot={detail.data}
      initialView={initialView}
      opening={opening}
      onViewChange={onViewChange}
      onQuestion={onQuestion}
      share={share}
      leading={leading}
      frameClassName="h-full min-h-0"
      pollWhileHidden
    />
  );
}

function Loading(): ReactNode {
  return (
    <div className="space-y-3">
      <Skeleton className="h-10" />
      <Skeleton className="h-[420px]" />
    </div>
  );
}
