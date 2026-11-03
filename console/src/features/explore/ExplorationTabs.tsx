import { ChevronDown, Copy, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import type { ExplorationSummary } from './explorations';
import { RelativeTime } from '@/components/Inline';
import { Popover } from '@/components/ui/Popover';
import { cn } from '@/lib/cn';

/**
 * The open explorations, as tabs (docs/design/explore.md §4.2): each its name and a way to close it;
 * then a new one. ← and → move between them, Delete closes the one with focus, a double click or F2
 * renames it. The address bar says which is shown.
 */
export function ExplorationTabs({
  tabs,
  shown,
  tabId,
  panelId,
  onShow,
  onClose,
  onNew,
  onRename,
}: {
  tabs: ReadonlyArray<Pick<ExplorationSummary, 'id' | 'label'>>;
  shown: string | null;
  tabId: (id: string) => string;
  panelId: (id: string) => string;
  onShow: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
}): ReactNode {
  const [renaming, setRenaming] = useState<string | null>(null);
  const strip = useRef<HTMLDivElement>(null);

  // The tab shown is in view when the strip scrolls sideways.
  useEffect(() => {
    if (!shown) return;
    strip.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(shown)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [shown]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string): void => {
    const at = tabs.findIndex((tab) => tab.id === id);
    const move = (to: number): void => {
      const next = tabs[(to + tabs.length) % tabs.length];
      if (!next) return;
      onShow(next.id);
      strip.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(next.id)}"]`)?.focus();
    };
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      move(at + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      move(at - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      move(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      move(tabs.length - 1);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      // Focus stays in the strip, on the tab shown next, rather than falling to the page.
      const neighbour = tabs[at + 1] ?? tabs[at - 1];
      onClose(id);
      if (neighbour) {
        window.requestAnimationFrame(() => strip.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(neighbour.id)}"]`)?.focus());
      }
    } else if (event.key === 'F2') {
      event.preventDefault();
      setRenaming(id);
    }
  };

  return (
    <div className="flex min-w-0 items-end gap-1">
      <div ref={strip} role="tablist" aria-label="Explorations" className="-mb-px flex min-w-0 items-end gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const selected = tab.id === shown;
          return (
            <div
              key={tab.id}
              className={cn(
                'group flex shrink-0 items-center gap-0.5 border-b-2 transition-colors',
                selected ? 'border-[var(--color-ink)]' : 'border-transparent',
              )}
            >
              {renaming === tab.id ? (
                <RenameField
                  initial={tab.label}
                  onDone={(title) => {
                    setRenaming(null);
                    if (title !== null) onRename(tab.id, title);
                  }}
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  id={tabId(tab.id)}
                  data-tab={tab.id}
                  aria-selected={selected}
                  aria-controls={panelId(tab.id)}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => onShow(tab.id)}
                  onDoubleClick={() => setRenaming(tab.id)}
                  onKeyDown={(event) => onKeyDown(event, tab.id)}
                  title={`${tab.label} · double-click or F2 to rename`}
                  className={cn(
                    // A phone's finger needs 44 px; a pointer, the strip's own height.
                    // The ring inside the tab: the strip scrolls sideways, and would clip one drawn outside it.
                    'max-w-[240px] truncate px-2.5 py-3 text-[13px] leading-5 font-medium whitespace-nowrap transition-colors focus-visible:outline-offset-[-2px] md:pt-0 md:pb-2.5',
                    selected ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
                  )}
                >
                  {tab.label}
                </button>
              )}
              <button
                type="button"
                onClick={() => onClose(tab.id)}
                aria-label={`Close ${tab.label}`}
                title="Close it: it stays under All explorations"
                tabIndex={-1}
                className={cn(
                  'size-11 shrink-0 place-items-center rounded text-[var(--color-ink-faint)] transition-opacity hover:bg-[var(--color-raised)] hover:text-[var(--color-ink)] md:mb-2.5 md:size-5',
                  // Shown by a pointer coming near; a finger cannot hover, so a phone closes only the tab shown.
                  selected ? 'grid opacity-100' : 'hidden opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 md:grid',
                )}
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onNew}
        aria-label="New exploration"
        title="New exploration"
        className="grid size-11 shrink-0 place-items-center rounded-[var(--radius-control)] text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-raised)] hover:text-[var(--color-ink)] md:mb-2 md:size-7"
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
}

/** A tab's name being changed: Enter keeps it, Escape or a blank name leaves it as it was. */
function RenameField({ initial, onDone }: { initial: string; onDone: (title: string | null) => void }): ReactNode {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (title: string | null): void => {
    if (done.current) return;
    done.current = true;
    onDone(title);
  };
  return (
    <input
      autoFocus
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.target.select()}
      onBlur={() => finish(value.trim() || null)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') finish(value.trim() || null);
        else if (event.key === 'Escape') finish(null);
      }}
      maxLength={80}
      aria-label="Name this exploration"
      className="mb-1.5 h-7 w-[200px] rounded-[var(--radius-control)] border border-[var(--color-line-strong)] bg-[var(--color-shelf)] px-2 text-[13px] font-medium text-[var(--color-ink)] outline-none focus:border-[var(--color-ink-muted)]"
    />
  );
}

/**
 * Every exploration this browser keeps, the most recently changed first: open one, duplicate it to
 * try a variation, or delete it - at once, with Undo in its toast (§10.10).
 */
export function ExplorationsMenu({
  list,
  open,
  onOpen,
  onDuplicate,
  onDelete,
  onNew,
}: {
  list: readonly ExplorationSummary[];
  open: ReadonlySet<string>;
  onOpen: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
}): ReactNode {
  return (
    <Popover
      align="end"
      width={360}
      trigger={({ toggle, open: shown, id }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={shown}
          aria-controls={id}
          data-role="explorations-menu"
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 text-[12px] font-medium transition-colors max-md:h-11',
            shown ? 'bg-[var(--color-raised)] text-[var(--color-ink)]' : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-raised)] hover:text-[var(--color-ink)]',
          )}
        >
          All explorations
          <ChevronDown className="size-3.5" />
        </button>
      )}
    >
      {({ close }) => (
        <div className="flex max-h-[min(440px,calc(100dvh-200px))] flex-col">
          <ul aria-label="Explorations kept in this browser" className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {list.length === 0 ? (
              <li className="px-3 py-4 text-[12px] text-[var(--color-ink-muted)]">None yet.</li>
            ) : (
              list.map((entry) => (
                <li key={entry.id} className="group flex items-center gap-1 rounded-[var(--radius-control)] pr-1 hover:bg-[var(--color-raised)]">
                  <button
                    type="button"
                    onClick={() => {
                      close();
                      onOpen(entry.id);
                    }}
                    className="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-2.5 py-1.5 text-left"
                  >
                    <span className="flex w-full min-w-0 items-center gap-2 text-[12.5px] text-[var(--color-ink)]">
                      <span className="min-w-0 truncate font-medium">{entry.label}</span>
                      {open.has(entry.id) ? <span className="shrink-0 text-[11px] font-normal text-[var(--color-ink-faint)]">open</span> : null}
                    </span>
                    <span className="flex w-full min-w-0 items-center gap-1.5 text-[11px] text-[var(--color-ink-muted)]">
                      <span className="shrink-0 whitespace-nowrap">
                        <RelativeTime value={entry.updatedAt} />
                      </span>
                      {entry.source ? (
                        <>
                          <span aria-hidden>·</span>
                          <span className="ident truncate">{`${entry.source.domain}.${entry.source.dataset}.${entry.source.table}`}</span>
                        </>
                      ) : null}
                    </span>
                  </button>
                  {/* Shown by a pointer coming near; a finger cannot hover, so on a phone they are always there. */}
                  <span className="flex shrink-0 items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 max-md:opacity-100">
                    <MenuIcon
                      label={`Duplicate ${entry.label}`}
                      onClick={() => {
                        close();
                        onDuplicate(entry.id);
                      }}
                    >
                      <Copy className="size-3.5" />
                    </MenuIcon>
                    <MenuIcon label={`Delete ${entry.label}`} onClick={() => onDelete(entry.id)}>
                      <Trash2 className="size-3.5" />
                    </MenuIcon>
                  </span>
                </li>
              ))
            )}
          </ul>
          <div className="border-t border-[var(--color-line)] p-1.5">
            <button
              type="button"
              onClick={() => {
                close();
                onNew();
              }}
              className="flex h-8 w-full items-center gap-2 rounded-[var(--radius-control)] px-2.5 text-left text-[12.5px] font-medium text-[var(--color-ink)] hover:bg-[var(--color-raised)]"
            >
              <Plus className="size-3.5 text-[var(--color-ink-muted)]" />
              New exploration
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}

function MenuIcon({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid size-7 place-items-center rounded text-[var(--color-ink-faint)] hover:bg-[var(--color-ridge)] hover:text-[var(--color-ink)] max-md:size-11"
    >
      {children}
    </button>
  );
}
