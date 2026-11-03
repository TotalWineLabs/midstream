import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowRight, Compass, CornerDownLeft, Database, FolderOpen, LayoutGrid, Pin, Play, Plus, Search, Settings, Square, Table2, UserRound, Waves } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';

import { StatusGlyph } from './Status';
import { useLifecycleActions } from '@/features/materializations/actions';
import { resultPath } from '@/features/search/results';
import { api } from '@/lib/api';
import { useConsoleAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useScopeDomainId, useDomains } from '@/lib/domains';
import { useFleet, type DomainMaterialization } from '@/lib/fleet';
import { matchName, searchTerms, segmentName } from '@/lib/nameSearch';
import { domainPath, explorePath, sectionPath } from '@/lib/paths';
import { isPinned, togglePin, usePins } from '@/lib/pins';
import { rootQueryClient } from '@/lib/queryClient';
import { itemStatus, statusGroup, type Status } from '@/lib/status';

interface Command {
  key: string;
  group: string;
  label: string;
  /** Where the label matched the query, for emphasis. */
  ranges?: Array<[number, number]>;
  detail?: string | null;
  icon?: ReactNode;
  run: () => void;
}

/** Places listed before anything is typed, and found by name after. */
interface Place {
  label: string;
  icon: typeof Waves;
  to: string;
  permission: string | null;
}

/** Materializations offered before anything is typed: the ones that need someone, then the rest. */
const SUGGESTED = 5;

/** A query's rank against a name, or null when it does not match. Lower is better. */
function rank(name: string, terms: string[]): { score: number; ranges: Array<[number, number]> } | null {
  if (terms.length === 0) return { score: 0, ranges: [] };
  return matchName(name.toLowerCase(), terms);
}

/**
 * ⌘K: one field to go anywhere or do anything (docs/10-design-system.md §10.10). Places, the
 * fleet's materializations and what can be done to them answer at once; tables and datasets come
 * from search as it answers. Enter opens or acts, arrows move, Escape closes.
 */
export function CommandMenu({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  if (!open) return null;
  return createPortal(<CommandPanel onClose={onClose} />, document.body);
}

function CommandPanel({ onClose }: { onClose: () => void }): ReactNode {
  const [text, setText] = useState('');
  const query = useDeferredValue(text.trim());
  const terms = useMemo(() => searchTerms(query), [query]);
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const scope = useScopeDomainId();
  const consoleAuth = useConsoleAuth();
  const domains = useDomains();
  const many = domains.length > 1;
  const { data: fleet } = useFleet(null);
  const pins = usePins();
  const { run } = useLifecycleActions();
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const search = useQuery(
    {
      queryKey: ['search', query],
      queryFn: () => api.search(query),
      enabled: query.length > 1,
      placeholderData: keepPreviousData,
      staleTime: 5_000,
    },
    rootQueryClient,
  );

  const commands = useMemo<Command[]>(() => {
    const go = (to: string) => () => {
      onClose();
      void navigate(to);
    };
    const out: Command[] = [];
    const auth = scope ? consoleAuth.forDomain(scope) : consoleAuth.overall;

    const places: Place[] = [
      { label: 'Overview', icon: LayoutGrid, to: sectionPath('overview', scope), permission: 'materializations.view' },
      { label: 'Materializations', icon: Waves, to: sectionPath('materializations', scope), permission: 'materializations.view' },
      { label: 'Datasets', icon: FolderOpen, to: sectionPath('datasets', scope), permission: 'datasets.view' },
      { label: 'Settings', icon: Settings, to: sectionPath('settings', scope), permission: null },
      { label: 'Your account', icon: UserRound, to: '/settings/account', permission: null },
    ];
    // Making one: in the page's domain, or the first the person may create one in.
    const creatable = scope ?? domains.find((domain) => consoleAuth.forDomain(domain.id).can('materializations.create'))?.id ?? null;
    if (creatable && consoleAuth.forDomain(creatable).can('materializations.create')) {
      places.push({ label: 'New materialization', icon: Plus, to: domainPath(creatable, '/materializations/new'), permission: null });
    }
    // Explore reads any domain's tables: there for anyone who may query a dataset anywhere.
    const explores = consoleAuth.overall.canAnywhere('data.query');
    if (explores) {
      places.push({ label: 'Explore', icon: Compass, to: sectionPath('explore', scope), permission: null });
      places.push({ label: 'New exploration', icon: Plus, to: explorePath('new'), permission: null });
    }
    for (const place of places) {
      if (place.permission && !auth.can(place.permission)) continue;
      if (!place.permission && !consoleAuth.overall.signedIn) continue;
      const match = rank(place.label, terms);
      if (!match) continue;
      out.push({ key: `place:${place.label}`, group: 'Go to', label: place.label, ranges: match.ranges, icon: <place.icon className="size-4" />, run: go(place.to) });
    }

    const items = fleet?.items ?? [];
    const matched = items
      .map((item) => {
        const match = rank(item.name, terms) ?? rank(item.materialization_id, terms) ?? (terms.length && item.source_topics.some((topic) => rank(topic, terms)) ? { score: 9, ranges: [] } : null);
        return match ? { item, status: itemStatus(item), match } : null;
      })
      .filter((entry): entry is { item: DomainMaterialization; status: Status; match: { score: number; ranges: Array<[number, number]> } } => entry !== null)
      .sort((left, right) => {
        if (terms.length > 0) return left.match.score - right.match.score;
        // Nothing typed: what needs someone first.
        const order = ['needs-you', 'in-progress', 'flowing', 'stopped'];
        return order.indexOf(statusGroup(left.status)) - order.indexOf(statusGroup(right.status));
      })
      .slice(0, terms.length > 0 ? 8 : SUGGESTED);

    for (const { item, status, match } of matched) {
      const to = domainPath(item.domain, `/materializations/${encodeURIComponent(item.materialization_id)}`);
      out.push({
        key: `mat:${item.domain}/${item.materialization_id}`,
        group: 'Materializations',
        label: item.name,
        ranges: match.ranges,
        detail: [status.label, many ? item.domainName : null].filter(Boolean).join(' · '),
        icon: <StatusGlyph status={status} />,
        run: go(to),
      });
    }

    // What can be done to what was found: only once something is typed, so the list stays short.
    if (terms.length > 0) {
      for (const { item } of matched.slice(0, 3)) {
        const itemAuth = consoleAuth.forDomain(item.domain);
        const target = { kind: 'materialization' as const, domain: item.domain, id: item.materialization_id, label: item.name };
        if (item.desired_phase === 'running' && itemAuth.can('materializations.stop')) {
          out.push({
            key: `stop:${item.domain}/${item.materialization_id}`,
            group: 'Actions',
            label: `Stop ${item.name}`,
            detail: many ? item.domainName : null,
            icon: <Square className="size-3.5" />,
            run: () => {
              onClose();
              run('stop', item.materialization_id, item.domain, item.name);
            },
          });
        }
        if (item.desired_phase === 'stopped' && itemAuth.can('materializations.resume')) {
          out.push({
            key: `resume:${item.domain}/${item.materialization_id}`,
            group: 'Actions',
            label: `Resume ${item.name}`,
            detail: many ? item.domainName : null,
            icon: <Play className="size-3.5" />,
            run: () => {
              onClose();
              run('resume', item.materialization_id, item.domain, item.name);
            },
          });
        }
        out.push({
          key: `pin:${item.domain}/${item.materialization_id}`,
          group: 'Actions',
          label: `${isPinned(pins, target) ? 'Unpin' : 'Pin'} ${item.name}`,
          detail: 'In the sidebar',
          icon: <Pin className="size-3.5" />,
          run: () => {
            togglePin(target);
            onClose();
          },
        });
      }
    }

    // Tables and datasets, as search answers. Materializations are already listed from the fleet.
    if (query.length > 1) {
      const explorable: Command[] = [];
      for (const result of search.data?.results ?? []) {
        if (result.kind === 'materialization') continue;
        out.push({
          key: `search:${result.kind}:${result.domain}/${result.id}`,
          group: result.kind === 'table' ? 'Tables' : 'Datasets',
          label: result.label,
          ranges: rank(result.label, terms)?.ranges,
          detail: result.detail,
          icon: result.kind === 'table' ? <Table2 className="size-4" /> : <Database className="size-4" />,
          run: go(resultPath(result)),
        });
        // A table someone may query can be explored, in a new exploration: its full name says where.
        if (result.kind === 'table' && consoleAuth.forDomain(result.domain).canAnywhere('data.query') && explorable.length < 3) {
          explorable.push({
            key: `explore:${result.domain}/${result.id}`,
            group: 'Explore',
            label: `Explore ${result.domain}.${result.id}`,
            detail: 'In a new exploration',
            icon: <Compass className="size-3.5" />,
            run: go(`${explorePath('new')}?source=${encodeURIComponent(`${result.domain}.${result.id}`)}`),
          });
        }
      }
      out.push(...explorable);
      out.push({
        key: 'search:all',
        group: 'Search',
        label: `See every result for “${query}”`,
        icon: <Search className="size-4" />,
        run: go(`/search?q=${encodeURIComponent(query)}`),
      });
    }
    return out;
  }, [terms, query, fleet, scope, consoleAuth, domains, many, pins, navigate, onClose, run, search.data]);

  // A new query starts at the top.
  useEffect(() => setActive(0), [query]);

  // Keep the active row in view as the arrows move it.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, Math.max(commands.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      commands[active]?.run();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  let lastGroup = '';
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-3 pt-[10vh] sm:p-6 sm:pt-[12vh]">
      <div className="fixed inset-0 bg-[var(--color-scrim)] backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search or jump to"
        className="fade-in relative flex max-h-[72vh] w-full max-w-[640px] flex-col overflow-hidden rounded-[16px] border border-[var(--color-line-strong)] bg-[var(--color-pop)] shadow-[var(--shadow-float)]"
      >
        <div className="flex items-center gap-3 border-b border-[var(--color-line)] px-4">
          <Search className="size-4 shrink-0 text-[var(--color-ink-faint)]" />
          <input
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search or jump to…"
            aria-label="Search or jump to"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-results"
            aria-activedescendant={commands[active] ? `command-${active}` : undefined}
            className="h-14 min-w-0 flex-1 bg-transparent text-[15px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)]"
          />
          <kbd className="hidden rounded border border-[var(--color-line)] px-1.5 text-[11px] text-[var(--color-ink-faint)] sm:block">esc</kbd>
        </div>

        <div ref={list} id="command-results" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-2">
          {commands.length === 0 ? (
            <p className="px-3 py-8 text-center text-[13px] text-[var(--color-ink-muted)]">
              {search.isFetching ? 'Searching…' : 'Nothing matches. Try a table, a topic or a dataset.'}
            </p>
          ) : (
            commands.map((command, index) => {
              const heading = command.group !== lastGroup ? command.group : null;
              lastGroup = command.group;
              return (
                <div key={command.key}>
                  {heading ? <p className="px-3 pt-3 pb-1.5 text-[12px] text-[var(--color-ink-faint)] first:pt-1">{heading}</p> : null}
                  <button
                    type="button"
                    id={`command-${index}`}
                    data-index={index}
                    role="option"
                    aria-selected={index === active}
                    onMouseMove={() => setActive(index)}
                    onClick={() => command.run()}
                    className={cn(
                      'flex h-11 w-full items-center gap-3 rounded-[10px] px-3 text-left text-[14px] transition-colors',
                      index === active ? 'bg-[var(--color-raised)] text-[var(--color-ink)]' : 'text-[var(--color-ink-muted)]',
                    )}
                  >
                    <span className="grid size-5 shrink-0 place-items-center text-[var(--color-ink-muted)]">{command.icon ?? <ArrowRight className="size-4" />}</span>
                    <span className="min-w-0 truncate text-[var(--color-ink)]">
                      {command.ranges && command.ranges.length > 0
                        ? segmentName(command.label, command.ranges).map((segment, at) =>
                            segment.match ? (
                              <mark key={at} className="bg-transparent font-semibold text-[var(--color-ink)]">
                                {segment.text}
                              </mark>
                            ) : (
                              <span key={at}>{segment.text}</span>
                            ),
                          )
                        : command.label}
                    </span>
                    {command.detail ? <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-ink-faint)]">{command.detail}</span> : <span className="flex-1" />}
                    {index === active ? <CornerDownLeft className="size-3.5 shrink-0 text-[var(--color-ink-faint)]" /> : null}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="hidden items-center gap-4 border-t border-[var(--color-line)] px-4 py-2.5 text-[12px] text-[var(--color-ink-faint)] sm:flex">
          <span>↑↓ to move</span>
          <span>↵ to open</span>
          <span>esc to close</span>
        </div>
      </div>
    </div>
  );
}
