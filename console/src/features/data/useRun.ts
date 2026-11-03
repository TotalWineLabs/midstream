import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { pageQueryKey } from './live.ts';
import { lostRun, runGone } from './lostRun.ts';
import { ApiError, api } from '@/lib/api';
import { useApi } from '@/lib/domains';
import type { RunPage, RunRefresh, RunRequest, RunSnapshot, TimeRange } from '@shared/types';

/** How often a run is asked how it is doing while it is followed without its event stream. */
const POLL_MS = 1_000;
/** The same, while its tab is out of sight: it needs to know when the run ends, not every step. */
const HIDDEN_POLL_MS = 2_000;

export { pageQueryKey, pageStage } from './live.ts';

export interface RunController {
  /** The run on screen, kept current from its event stream. */
  run: RunSnapshot | null;
  /**
   * The run Live replaced when a commit moved the question to a new snapshot: the same question, so
   * its rows and its status stand in while the new run counts, and nothing on screen flickers.
   * Null once a person asks a new question.
   */
  carried: RunSnapshot | null;
  /** A run is being created. */
  starting: boolean;
  /** Why the last run could not be created — a bad statement, a filter on a missing column. */
  startError: ApiError | null;
  start: (request: RunRequest) => Promise<RunSnapshot | null>;
  cancel: () => void;
  /** Pick up a run that already exists, e.g. after a page refresh. False when it is gone. */
  attach: (runId: string) => Promise<boolean>;
  /**
   * Bring the run on screen up to date: the live tail's newest records appended to it, or a new run
   * in its place, followed from then on. `range` is its range resolved again, for a new run.
   * Rejects with the API's error; a run that has expired answers 404.
   */
  refresh: (range: TimeRange | null) => Promise<RunRefresh | null>;
}

/**
 * One run at a time, followed live.
 *
 * Starting a run cancels the one before it if it is still working: a new question supersedes the
 * old one, and leaving it to finish would spend the server on an answer nobody will look at.
 * Progress arrives over server-sent events; if the stream drops, the hook polls instead, because a
 * status frozen by a dead transport is indistinguishable from a hung query. A run the console no
 * longer has - it restarted - answers 404, and ends on screen as failed (`lostRun.ts`).
 *
 * Runs start through the console's own route (`POST /api/runs`), whatever their table's domain.
 * `belongs` says whether a run, picked back up by its id, is about what the caller shows. With
 * `stream` false the run is followed by asking every few seconds rather than over an event stream:
 * an exploration out of sight keeps following its run without holding a connection open, since a
 * browser over HTTP/1.1 gives a page only six.
 */
export function useRun({ belongs, stream = true }: { belongs: (run: RunSnapshot) => boolean; stream?: boolean }): RunController {
  const [run, setRun] = useState<RunSnapshot | null>(null);
  const [carried, setCarried] = useState<RunSnapshot | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<ApiError | null>(null);
  const current = useRef<RunSnapshot | null>(null);
  const source = useRef<EventSource | null>(null);
  const poll = useRef<number | null>(null);
  const streaming = useRef(stream);
  streaming.current = stream;
  const belongsTo = useRef(belongs);
  belongsTo.current = belongs;

  const show = useCallback((snapshot: RunSnapshot) => {
    if (current.current && current.current.id !== snapshot.id) return;
    current.current = snapshot;
    setRun(snapshot);
  }, []);

  const stopFollowing = useCallback(() => {
    source.current?.close();
    source.current = null;
    if (poll.current !== null) {
      window.clearInterval(poll.current);
      poll.current = null;
    }
  }, []);

  /** The run on screen, if it is still `runId` and still running, ended: the console no longer has it. */
  const lose = useCallback(
    (runId: string) => {
      const active = current.current;
      if (!active || active.id !== runId || active.state !== 'running') return;
      stopFollowing();
      show(lostRun(active));
    },
    [show, stopFollowing],
  );

  const follow = useCallback(
    (snapshot: RunSnapshot) => {
      stopFollowing();
      current.current = snapshot;
      setRun(snapshot);
      if (snapshot.state !== 'running') return;

      const id = snapshot.id;
      const ask = (every: number): void => {
        poll.current ??= window.setInterval(() => {
          void api
            .run(id)
            .then((next) => {
              show(next);
              if (next.state !== 'running') stopFollowing();
            })
            .catch((error: unknown) => {
              if (runGone(error)) lose(id);
            });
        }, every);
      };
      if (!streaming.current) {
        ask(HIDDEN_POLL_MS);
        return;
      }
      const events = new EventSource(api.runStreamUrl(id));
      source.current = events;
      events.onmessage = (event) => {
        try {
          const next = JSON.parse(event.data as string) as RunSnapshot;
          show(next);
          if (next.state !== 'running') stopFollowing();
        } catch {
          /* a malformed frame is superseded by the next one */
        }
      };
      events.onerror = () => {
        if (source.current !== events) return;
        events.close();
        source.current = null;
        ask(POLL_MS);
      };
    },
    [show, stopFollowing, lose],
  );

  // Out of sight or back: a run still working is followed the other way, from where it is.
  useEffect(() => {
    const active = current.current;
    if (active && active.state === 'running') follow(active);
  }, [stream, follow]);

  const start = useCallback(
    async (request: RunRequest): Promise<RunSnapshot | null> => {
      const previous = current.current;
      if (previous && previous.state === 'running') void api.cancelRun(previous.id).catch(() => undefined);
      stopFollowing();
      current.current = null;
      setCarried(null);
      setStarting(true);
      setStartError(null);
      try {
        const snapshot = await api.startRun(request);
        follow(snapshot);
        return snapshot;
      } catch (error) {
        setStartError(error instanceof ApiError ? error : new ApiError('request_failed', String(error), 0));
        return null;
      } finally {
        setStarting(false);
      }
    },
    [follow, stopFollowing],
  );

  const cancel = useCallback(() => {
    const active = current.current;
    if (!active || active.state !== 'running') return;
    void api
      .cancelRun(active.id)
      .then((snapshot) => {
        show(snapshot);
        stopFollowing();
      })
      .catch((error: unknown) => {
        if (runGone(error)) lose(active.id);
      });
  }, [show, stopFollowing, lose]);

  const attach = useCallback(
    async (runId: string): Promise<boolean> => {
      try {
        const snapshot = await api.run(runId);
        if (!belongsTo.current(snapshot)) return false;
        setCarried(null);
        follow(snapshot);
        return true;
      } catch {
        return false;
      }
    },
    [follow],
  );

  const refresh = useCallback(
    async (range: TimeRange | null): Promise<RunRefresh | null> => {
      const active = current.current;
      if (!active) return null;
      const answer = await api.refreshRun(active.id, range);
      // The run on screen may have changed while the refresh was out; it decides, not this answer.
      if (current.current?.id !== active.id) return answer;
      if (answer.replaced) {
        setCarried(active);
        follow(answer.run);
      } else {
        show(answer.run);
      }
      return answer;
    },
    [follow, show],
  );

  useEffect(() => stopFollowing, [stopFollowing]);

  return { run, carried, starting, startError, start, cancel, attach, refresh };
}

/**
 * One page of the run on screen.
 *
 * A page is requested as soon as any of its rows are ready and again as more arrive, so the grid
 * fills while a run is still counting. A complete page is immutable — the run is pinned to the
 * data as it was when it started — so it is cached for good, and the next page is fetched ahead of
 * the click that will ask for it. That is what makes paging feel instant. Only a refresh that
 * appends the live tail's newest records changes a finished run's rows, and it bumps the run's
 * `revision`, which is part of every page's key.
 */
export function useRunPage(run: RunSnapshot | null, offset: number, limit: number, carriedId: string | null = null) {
  const api = useApi();
  const queryClient = useQueryClient();
  const terminal = run !== null && run.state !== 'running';
  const ready = run ? Math.min(run.rowsReady, offset + limit) : 0;
  const runId = run?.id ?? null;

  const query = useQuery<RunPage>({
    queryKey: pageQueryKey(run, offset, limit),
    queryFn: () => api.runRows(runId as string, offset, limit),
    enabled: runId !== null && (ready > offset || terminal),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
    retry: 0,
    // Within one run — or from the run Live replaced, the same question at a newer snapshot — keep
    // showing the rows on screen while the next read lands; never carry another question's rows.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === runId || (carriedId !== null && previousQuery?.queryKey[1] === carriedId) ? keepPreviousData(previous) : undefined,
  });

  const nextOffset = offset + limit;
  const nextReady = run !== null && (run.rowsReady >= nextOffset + limit || (terminal && run.rowsReady > nextOffset));
  useEffect(() => {
    if (!runId || !nextReady || !query.data?.complete) return;
    void queryClient.prefetchQuery({
      queryKey: pageQueryKey(run, nextOffset, limit),
      queryFn: () => api.runRows(runId, nextOffset, limit),
      staleTime: Number.POSITIVE_INFINITY,
    });
  }, [queryClient, runId, nextOffset, limit, nextReady, query.data?.complete, run]);

  // The last page is the other place people jump to, so it is read as soon as the total is final.
  const pageable = run === null ? 0 : run.request.kind === 'sql' ? (run.rowsRetained ?? 0) : run.rows;
  const lastOffset = Math.max(0, Math.ceil(pageable / limit) - 1) * limit;
  const settled = run !== null && run.state === 'succeeded' && run.totalExact;
  useEffect(() => {
    if (!runId || !settled || lastOffset <= nextOffset) return;
    void queryClient.prefetchQuery({
      queryKey: pageQueryKey(run, lastOffset, limit),
      queryFn: () => api.runRows(runId, lastOffset, limit),
      staleTime: Number.POSITIVE_INFINITY,
    });
    // Once per run, revision and page size: the run object changes with every snapshot.
  }, [queryClient, runId, run?.revision, settled, lastOffset, limit]);

  return query;
}
