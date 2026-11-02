import { createContext, memo, useContext, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

const TabShownContext = createContext(true);

/**
 * Whether the tab this renders in is the one on screen. True outside a tab panel, so a component asks
 * the same way on a page without tabs.
 *
 * A kept tab is hidden, not gone: what it does on its own waits while this is false — a shortcut on
 * the document, a read on a timer, streaming — and picks up again when it is shown.
 */
export function useTabShown(): boolean {
  return useContext(TabShownContext);
}

/**
 * The tabs of a page opened so far, the one on screen included. Each is rendered from its first
 * opening until the page is left, so going back to it finds it as it was left
 * (docs/10-design-system.md §10.10).
 */
export function useOpenedTabs<T extends string>(active: T): ReadonlySet<T> {
  const [opened, setOpened] = useState<ReadonlySet<T>>(() => new Set([active]));
  if (opened.has(active)) return opened;
  // Added while rendering, not after: a tab opened for the first time shows in this render.
  const next = new Set([...opened, active]);
  setOpened(next);
  return next;
}

/**
 * One tab's content, kept while another tab of the page is shown: its state, what it has read, an
 * editor's text and history, and where it and the page were scrolled.
 *
 * Hidden, it holds still. It does not re-render for the page's updates, which it catches up with when
 * shown, and what in it acts on its own asks `useTabShown` first. It is not drawn but keeps its layout
 * (`.tab-kept`), so showing it again measures nothing anew: a grid keeps its scroll and its columns'
 * widths, an editor its lines.
 */
export const TabPanel = memo(
  function TabPanel({
    id,
    labelledBy,
    shown,
    children,
  }: {
    id: string;
    /** The id of the tab that shows it. */
    labelledBy: string;
    shown: boolean;
    children: ReactNode;
  }): ReactNode {
    const ref = useRef<HTMLDivElement>(null);
    useKeptScroll(ref, shown);
    return (
      <div ref={ref} id={id} role="tabpanel" aria-labelledby={labelledBy} inert={!shown} className={shown ? undefined : 'tab-kept'}>
        <TabShownContext.Provider value={shown}>{children}</TabShownContext.Provider>
      </div>
    );
  },
  // Its own state still renders a hidden tab: a run it follows reports, a read it made lands.
  (previous, next) => !previous.shown && !next.shown,
);

/**
 * Where the page was scrolled while a tab was shown, given back when it is shown again: the page
 * scrolls with its tab, and a shorter tab shown in between would leave it at the top.
 */
function useKeptScroll(ref: RefObject<HTMLElement | null>, shown: boolean): void {
  const top = useRef<number | null>(null);
  useLayoutEffect(() => {
    const scroller = shown ? scrollParent(ref.current) : null;
    if (!scroller) return;
    // Shown for the first time, a tab leaves the page where it is.
    if (top.current !== null) scroller.scrollTop = top.current;
    const remember = (): void => {
      top.current = scroller.scrollTop;
    };
    remember();
    scroller.addEventListener('scroll', remember, { passive: true });
    return () => scroller.removeEventListener('scroll', remember);
  }, [ref, shown]);
}

/** What the page scrolls in: the shell's main column, or else the document. */
function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null;
}
