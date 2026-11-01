import { Check, ChevronsUpDown, Database, Info, LayoutGrid, Layers, LogIn, LogOut, PanelLeftClose, PanelLeftOpen, Search, Settings, UserRound, Waves, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';

import { Avatar } from './Avatar';
import { CommandMenu } from './CommandMenu';
import { DomainDot } from './DomainChip';
import { Lockup, Mark } from './Logo';
import { StatusGlyph } from './Status';
import { Shimmer } from './motion/Shimmer';
import { Dialog } from './ui/Dialog';
import { Popover } from './ui/Popover';
import { Button, SegmentedControl } from './ui/primitives';
import { useAppearance, type Appearance } from '@/lib/appearance';
import { cn } from '@/lib/cn';
import { useConsoleAuth, type Auth } from '@/lib/auth';
import { sectionOf, sectionPath, useConsoleConfig, useScopeDomainId, type ShellSection } from '@/lib/domains';
import { useFleet } from '@/lib/fleet';
import { formatRelativeTime } from '@/lib/format';
import { FleetStreamProvider, useTicker, type LiveStatus } from '@/lib/live';
import { domainPath, tablePath } from '@/lib/paths';
import { togglePin, usePins, type Pin } from '@/lib/pins';
import { FOCUS_SEARCH_EVENT } from '@/lib/shortcuts';
import { itemStatus, statusGroup } from '@/lib/status';
import type { ConsoleDomain } from '@shared/types';

/** The places people work in, in every domain or in one (handbook 20). Search lives in ⌘K. */
const NAV_ITEMS: Array<{ section: ShellSection; label: string; icon: typeof Waves; permission: string }> = [
  { section: 'overview', label: 'Overview', icon: LayoutGrid, permission: 'materializations.view' },
  { section: 'materializations', label: 'Materializations', icon: Waves, permission: 'materializations.view' },
  { section: 'datasets', label: 'Datasets', icon: Database, permission: 'datasets.view' },
];

/** Settings holds everyone's own account, so it is there for anyone signed in. */
function canOpenSettings(auth: Auth): boolean {
  return auth.signedIn || auth.can('settings.view');
}

const SIDEBAR_KEY = 'console.sidebar.collapsed';

/**
 * Sidebar width, remembered across sessions. Collapsed, it keeps only its icons, which hands about
 * 170 px back to the page: worth having on a table's rows, where width is the scarce resource.
 */
function useSidebar(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggle = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0');
      } catch {
        /* private browsing; the preference simply does not persist */
      }
      return next;
    });
  }, []);
  return [collapsed, toggle];
}

/** One component and the build it is running; `null` reads as unavailable rather than absent. */
function VersionRow({ label, hint, version }: { label: string; hint: string; version: string | null }): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <dt className="text-[13px] font-medium">{label}</dt>
        <dd className="mt-0.5 text-[12px] text-[var(--color-ink-muted)]">{hint}</dd>
      </div>
      <span className="numeric shrink-0 text-[13px]">
        {version ? (
          `v${version}`
        ) : (
          <span className="text-[var(--color-ink-faint)]" title="Could not be reached">
            unavailable
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * Whether the page's data is live: a Current dot that beats once for every frame that arrives, so it
 * moves with the data rather than on a timer (docs/10-design-system.md §10.7).
 */
export function LiveIndicator({
  status,
  generatedAt,
  error,
  compact = false,
}: {
  status: LiveStatus;
  generatedAt?: string | null;
  error?: string | null;
  /** Just the dot, with the words in its tooltip. */
  compact?: boolean;
}): ReactNode {
  const now = useTicker(1000);
  const healthy = status === 'live' && !error;
  const words = healthy
    ? generatedAt
      ? `Live · updated ${formatRelativeTime(generatedAt, now)}`
      : 'Live'
    : status === 'connecting'
      ? 'Connecting…'
      : (error ?? 'Reconnecting…');

  return (
    <span className="inline-flex items-center gap-2 text-[12px] text-[var(--color-ink-muted)]" title={words}>
      <span
        // A new key for each frame starts the beat again.
        key={healthy ? (generatedAt ?? 'live') : status}
        className={cn('size-1.5 shrink-0 rounded-full', healthy ? 'heartbeat bg-[var(--color-current)]' : 'bg-[var(--color-buoy)]')}
      />
      {compact ? <span className="sr-only">{words}</span> : healthy ? 'Live' : <Shimmer>{words}</Shimmer>}
    </span>
  );
}

export function AppShell({ children }: { children: ReactNode }): ReactNode {
  return (
    <FleetStreamProvider>
      <Shell>{children}</Shell>
    </FleetStreamProvider>
  );
}

function Shell({ children }: { children: ReactNode }): ReactNode {
  const [collapsed, toggleSidebar] = useSidebar();
  const [aboutOpen, setAboutOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const consoleAuth = useConsoleAuth();
  const scope = useScopeDomainId();
  // The shell sits around a domain's pages, so it asks the address which domain they are of.
  const auth = scope ? consoleAuth.forDomain(scope) : consoleAuth.overall;
  const navItems = NAV_ITEMS.filter((item) => auth.can(item.permission)).map((item) => ({
    ...item,
    to: sectionPath(item.section, scope),
    end: item.section === 'overview',
  }));
  const settingsVisible = canOpenSettings(auth) || canOpenSettings(consoleAuth.overall);
  const consoleConfig = useConsoleConfig();
  const domains = consoleConfig.data?.domains ?? [];
  const troubled = domains.filter((domain) => domain.status === 'misconfigured' || domain.status === 'incompatible');
  const { pathname } = useLocation();
  useCommandShortcut(() => setCommandOpen(true));

  // A page change closes the command menu behind it.
  useEffect(() => setCommandOpen(false), [pathname]);

  return (
    <div className="flex h-full min-h-0 bg-[var(--color-surface)]">
      <aside
        className={cn(
          'hidden shrink-0 flex-col md:flex',
          'transition-[width] duration-[var(--duration-panel)] ease-[var(--ease-out)]',
          collapsed ? 'w-[60px]' : 'w-[236px]',
        )}
      >
        <div className={cn('flex h-14 shrink-0 items-center', collapsed ? 'justify-center px-2' : 'justify-between pr-2 pl-5')}>
          <Link to={sectionPath('overview', scope)} aria-label="Midstream overview" className="rounded-[var(--radius-control)]">
            {collapsed ? <Mark size={24} className="text-[var(--color-current)]" /> : <Lockup />}
          </Link>
          {collapsed ? null : (
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              className="grid size-8 place-items-center rounded-[var(--radius-control)] text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-raised)] hover:text-[var(--color-ink)]"
            >
              <PanelLeftClose className="size-4" />
            </button>
          )}
        </div>

        {domains.length > 1 ? <DomainSwitcher domains={domains} scope={scope} collapsed={collapsed} /> : null}

        <div className={cn('pb-2', collapsed ? 'px-2' : 'px-3')}>
          <button
            type="button"
            onClick={() => setCommandOpen(true)}
            title={collapsed ? 'Search or jump to… (⌘K)' : undefined}
            className={cn(
              'flex h-9 w-full items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-shelf)] text-[13px] text-[var(--color-ink-faint)] transition-colors hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink-muted)]',
              collapsed ? 'justify-center px-0' : 'px-2.5',
            )}
          >
            <Search className="size-4 shrink-0" />
            {collapsed ? (
              <span className="sr-only">Search or jump to…</span>
            ) : (
              <>
                <span className="flex-1 text-left">Search or jump to…</span>
                <kbd className="rounded border border-[var(--color-line)] px-1.5 font-sans text-[11px]">⌘K</kbd>
              </>
            )}
          </button>
        </div>

        <nav className={cn('flex flex-col gap-0.5', collapsed ? 'px-2' : 'px-3')} aria-label="Main">
          {navItems.map((item) => (
            <SidebarLink key={item.to} to={item.to} end={item.end} label={item.label} icon={item.icon} collapsed={collapsed}>
              {item.section === 'materializations' ? <NeedsYouBadge scope={scope} collapsed={collapsed} /> : null}
            </SidebarLink>
          ))}
        </nav>

        <PinnedItems collapsed={collapsed} />

        <div className={cn('mt-auto flex flex-col gap-0.5 pb-3', collapsed ? 'px-2' : 'px-3')}>
          {settingsVisible ? <SidebarLink to={sectionPath('settings', scope)} label="Settings" icon={Settings} collapsed={collapsed} /> : null}
          {collapsed ? (
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label="Expand sidebar"
              title="Expand sidebar"
              className="grid h-9 place-items-center rounded-[var(--radius-control)] text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-raised)] hover:text-[var(--color-ink)]"
            >
              <PanelLeftOpen className="size-4" />
            </button>
          ) : null}
          <div className={cn('mt-2 flex items-center border-t border-[var(--color-line)] pt-3', collapsed ? 'flex-col gap-2' : 'justify-between gap-2 pl-1')}>
            <AccountMenu collapsed={collapsed} onAbout={() => setAboutOpen(true)} />
            <ShellLive compact={collapsed} />
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col md:py-2 md:pr-2">
        <PhoneTopBar onCommand={() => setCommandOpen(true)} onAbout={() => setAboutOpen(true)} />
        {troubled.map((domain) => (
          <p
            key={domain.id}
            role="alert"
            className="mb-2 rounded-[var(--radius-control)] bg-[var(--color-flare-wash)] px-4 py-2 text-[12px] text-[var(--color-flare-ink)]"
          >
            {domain.statusMessage}
          </p>
        ))}
        <main className="min-h-0 flex-1 overflow-y-auto bg-[var(--color-canvas)] pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:rounded-[var(--radius-panel)] md:border md:border-[var(--color-line)] md:pb-0">
          {children}
        </main>
      </div>

      <BottomBar navItems={navItems} onCommand={() => setCommandOpen(true)} />
      <CommandMenu open={commandOpen} onClose={() => setCommandOpen(false)} />

      <Dialog
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
        title="About this deployment"
        description="Each part is deployed on its own, so their versions can differ."
        footer={
          <Button variant="secondary" onClick={() => setAboutOpen(false)}>
            Close
          </Button>
        }
      >
        <dl className="divide-y divide-[var(--color-line)]">
          <VersionRow label="Console" hint="This web application" version={consoleConfig.data?.version ?? null} />
          {domains.map((domain) => (
            <VersionRow
              key={domain.id}
              label={domains.length > 1 ? `${domain.name} control plane` : 'Control plane'}
              hint={`Serves ${domain.id}: its API, and runs its materializations`}
              version={domain.version}
            />
          ))}
        </dl>
        {consoleConfig.data?.federationKeysAgree === false ? (
          <p className="mt-4 text-[12px] leading-relaxed text-[var(--color-flare-ink)]">
            The domains sign access tokens with different federation keys, so a token made in one is refused in another. Give
            every domain the same federation-key.
          </p>
        ) : null}
        <p className="mt-4 text-[12px] leading-relaxed text-[var(--color-ink-muted)]">
          Each materialization&rsquo;s workers report their own version, on its page. They keep their build until the
          materialization is applied again, so they can trail the control plane.
        </p>
      </Dialog>
    </div>
  );
}

function SidebarLink({
  to,
  end,
  label,
  icon: Icon,
  collapsed,
  children,
}: {
  to: string;
  end?: boolean;
  label: string;
  icon: typeof Waves;
  collapsed: boolean;
  children?: ReactNode;
}): ReactNode {
  return (
    <NavLink
      to={to}
      end={end}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        cn(
          'relative flex h-9 items-center gap-2.5 rounded-[var(--radius-control)] text-[13px] font-medium transition-colors',
          collapsed ? 'justify-center px-0' : 'px-2.5',
          isActive
            ? 'bg-[var(--color-raised)] text-[var(--color-ink)]'
            : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-raised)] hover:text-[var(--color-ink)]',
        )
      }
    >
      <Icon className="size-4 shrink-0" />
      {collapsed ? <span className="sr-only">{label}</span> : <span className="min-w-0 flex-1 truncate">{label}</span>}
      {children}
    </NavLink>
  );
}

/** How many materializations need someone: failed or needing attention. Nothing at all when none do. */
function NeedsYouBadge({ scope, collapsed }: { scope: string | null; collapsed: boolean }): ReactNode {
  const { data } = useFleet(scope);
  const needing = useMemo(() => (data?.items ?? []).map((item) => itemStatus(item)).filter((status) => statusGroup(status) === 'needs-you'), [data]);
  if (needing.length === 0) return null;
  const failed = needing.some((status) => status.kind === 'failed');
  const label = `${needing.length} need${needing.length === 1 ? 's' : ''} you`;
  if (collapsed) {
    return (
      <span
        title={label}
        className={cn('absolute top-1.5 right-2 size-2 rounded-full', failed ? 'bg-[var(--color-flare)]' : 'bg-[var(--color-buoy)]')}
      />
    );
  }
  return (
    <span
      title={label}
      className={cn(
        'numeric rounded-full px-1.5 py-px text-[11px] font-semibold',
        failed ? 'bg-[var(--color-flare-wash)] text-[var(--color-flare-ink)]' : 'bg-[var(--color-buoy-wash)] text-[var(--color-buoy-ink)]',
      )}
    >
      {needing.length}
    </span>
  );
}

/** Where a pin opens: the page of what was pinned. */
function pinPath(pin: Pin): string {
  if (pin.kind === 'materialization') return domainPath(pin.domain, `/materializations/${encodeURIComponent(pin.id)}`);
  if (pin.kind === 'dataset') return domainPath(pin.domain, `/datasets/${encodeURIComponent(pin.id)}`);
  // `<dataset>.<table>`: a dataset's name has no dot.
  const dot = pin.id.indexOf('.');
  return domainPath(pin.domain, tablePath(pin.id.slice(0, dot), pin.id.slice(dot + 1)));
}

/** What this person keeps to come back to, each with its state. No heading when there is nothing. */
function PinnedItems({ collapsed }: { collapsed: boolean }): ReactNode {
  const pins = usePins();
  const { data } = useFleet(null);
  if (pins.length === 0) return null;
  const byKey = new Map((data?.items ?? []).map((item) => [`${item.domain}/${item.materialization_id}`, item]));

  return (
    <div className={cn('mt-5 flex min-h-0 flex-col', collapsed ? 'px-2' : 'px-3')}>
      {collapsed ? null : <p className="px-2.5 pb-1.5 text-[12px] text-[var(--color-ink-faint)]">Pinned</p>}
      <ul className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
        {pins.map((pin) => {
          // A table shows its materialization's state, under its own name.
          const owner = pin.kind === 'materialization' ? pin.id : pin.kind === 'table' ? pin.materializationId : undefined;
          const item = owner ? byKey.get(`${pin.domain}/${owner}`) : undefined;
          const label = pin.kind === 'materialization' ? (item?.name ?? pin.label) : pin.label;
          const to = pinPath(pin);
          return (
            <li key={`${pin.kind}/${pin.domain}/${pin.id}`} className="group relative">
              <NavLink
                to={to}
                title={collapsed ? label : undefined}
                className={({ isActive }) =>
                  cn(
                    'flex h-8 items-center gap-2.5 rounded-[var(--radius-control)] text-[13px] transition-colors',
                    collapsed ? 'justify-center' : 'pr-7 pl-2.5',
                    isActive ? 'bg-[var(--color-raised)] text-[var(--color-ink)]' : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-raised)] hover:text-[var(--color-ink)]',
                  )
                }
              >
                {item ? <StatusGlyph status={itemStatus(item)} /> : <Database className="size-3.5 shrink-0" />}
                {collapsed ? (
                  <span className="sr-only">{label}</span>
                ) : (
                  <span className={cn('min-w-0 truncate', pin.kind === 'table' && 'numeric text-[12.5px]')}>{label}</span>
                )}
              </NavLink>
              {collapsed ? null : (
                <button
                  type="button"
                  onClick={() => togglePin(pin)}
                  aria-label={`Unpin ${label}`}
                  title="Unpin"
                  className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded text-[var(--color-ink-faint)] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[var(--color-ink)] focus-visible:opacity-100"
                >
                  <X className="size-3" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The fleet's own liveness, in the shell, for every page. */
function ShellLive({ compact }: { compact: boolean }): ReactNode {
  const { data, status } = useFleet(null);
  return <LiveIndicator status={status} generatedAt={data?.generatedAt ?? null} error={data?.controlPlaneError ?? null} compact={compact} />;
}

/** On a phone: the mark, and the account, with the page beneath. */
function PhoneTopBar({ onCommand, onAbout }: { onCommand: () => void; onAbout: () => void }): ReactNode {
  return (
    <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center justify-between border-b border-[var(--color-line)] bg-[var(--color-surface)] px-4 md:hidden">
      <Link to="/" aria-label="Midstream overview" className="flex items-center gap-2">
        <Mark size={22} className="text-[var(--color-current)]" />
        <span className="font-display text-[16px] font-semibold tracking-[-0.022em]">Midstream</span>
      </Link>
      <div className="flex items-center gap-3">
        <ShellLive compact />
        <button type="button" onClick={onCommand} aria-label="Search or jump to" className="grid size-9 place-items-center rounded-[var(--radius-control)] text-[var(--color-ink-muted)]">
          <Search className="size-[18px]" />
        </button>
        <AccountMenu collapsed onAbout={onAbout} align="end" side="bottom" />
      </div>
    </header>
  );
}

/** On a phone, the places people go, under their thumb. */
function BottomBar({
  navItems,
  onCommand,
}: {
  navItems: Array<{ to: string; end: boolean; label: string; icon: typeof Waves }>;
  onCommand: () => void;
}): ReactNode {
  const itemClass = 'flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium';
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-30 flex border-t border-[var(--color-line)] bg-[var(--color-surface)] pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {navItems.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) => cn(itemClass, 'h-16', isActive ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-faint)]')}
        >
          <item.icon className="size-5" />
          {item.label}
        </NavLink>
      ))}
      <button type="button" onClick={onCommand} className={cn(itemClass, 'h-16 text-[var(--color-ink-faint)]')}>
        <Search className="size-5" />
        Search
      </button>
    </nav>
  );
}

/** ⌘K or Ctrl+K, anywhere: the command menu. `/` too, outside a text field. */
function useCommandShortcut(open: () => void): void {
  const { pathname } = useLocation();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName));
      const commandK = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k';
      const slash = event.key === '/' && !typing && !event.metaKey && !event.ctrlKey;
      if (!commandK && !slash) return;
      event.preventDefault();
      // The search page has its own field: ⌘K there focuses it.
      if (pathname === '/search') window.dispatchEvent(new Event(FOCUS_SEARCH_EVENT));
      else open();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, pathname]);
}

/**
 * Which part of the console the pages are about: every domain, or one (handbook 20). Choosing keeps
 * the section - the overview, the lists, settings - that is open.
 */
function DomainSwitcher({ domains, scope, collapsed }: { domains: ConsoleDomain[]; scope: string | null; collapsed: boolean }): ReactNode {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const section = sectionOf(pathname);
  const current = domains.find((domain) => domain.id === scope) ?? null;
  const choose = (domain: string | null): void => {
    void navigate(sectionPath(section === 'search' ? 'overview' : section, domain));
  };
  const itemClass =
    'flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-[var(--color-raised)]';
  return (
    <div className={cn('pb-2', collapsed ? 'px-2' : 'px-3')}>
      <Popover
        side="bottom"
        width={232}
        trigger={({ open, toggle, id }) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-controls={id}
            aria-label="Choose a domain"
            title={collapsed ? (current?.name ?? 'All domains') : undefined}
            className={cn(
              'flex h-9 w-full items-center gap-2 rounded-[var(--radius-control)] text-[13px] font-medium transition-colors hover:bg-[var(--color-raised)]',
              collapsed ? 'justify-center px-0' : 'px-2.5',
            )}
          >
            {current ? <DomainDot domain={current} /> : <Layers className="size-4 shrink-0 text-[var(--color-ink-muted)]" />}
            {collapsed ? null : <span className="min-w-0 flex-1 truncate text-left">{current?.name ?? 'All domains'}</span>}
            {collapsed ? null : <ChevronsUpDown className="size-3.5 shrink-0 text-[var(--color-ink-faint)]" />}
          </button>
        )}
      >
        {({ close }) => (
          <div className="p-1.5" role="menu">
            <button
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => {
                close();
                choose(null);
              }}
            >
              <Layers className="size-4 shrink-0 text-[var(--color-ink-muted)]" />
              <span className="flex-1">All domains</span>
              {scope === null ? <Check className="size-3.5 text-[var(--color-ink)]" /> : null}
            </button>
            <div className="my-1 border-t border-[var(--color-line)]" />
            {domains.map((domain) => (
              <button
                key={domain.id}
                type="button"
                role="menuitem"
                disabled={domain.status === 'misconfigured'}
                className={cn(itemClass, domain.status === 'misconfigured' && 'opacity-50')}
                onClick={() => {
                  close();
                  choose(domain.id);
                }}
              >
                <DomainDot domain={domain} />
                <span className="min-w-0 flex-1 truncate">{domain.name}</span>
                {scope === domain.id ? <Check className="size-3.5 text-[var(--color-ink)]" /> : null}
              </button>
            ))}
          </div>
        )}
      </Popover>
    </div>
  );
}

const APPEARANCES: Array<{ value: Appearance; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/**
 * The person using the page: their account, how the console looks, and signing out of every domain;
 * or, for someone signed in nowhere, the way to sign in.
 */
function AccountMenu({
  collapsed,
  onAbout,
  align = 'start',
  side = 'top',
}: {
  collapsed: boolean;
  onAbout: () => void;
  align?: 'start' | 'end';
  side?: 'top' | 'bottom';
}): ReactNode {
  const consoleAuth = useConsoleAuth();
  const auth = consoleAuth.overall;
  const domains = useConsoleConfig().data?.domains ?? [];
  const signedInNames = consoleAuth.signedInDomains.map((id) => domains.find((domain) => domain.id === id)?.name ?? id);
  const navigate = useNavigate();
  const location = useLocation();
  const [appearance, setAppearance] = useAppearance();
  const itemClass =
    'flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-2 text-left text-[13px] text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-raised)] hover:text-[var(--color-ink)]';

  if (!auth.signedIn) {
    return (
      <button
        type="button"
        onClick={() => navigate('/sign-in', { state: { from: location } })}
        title={collapsed ? 'Sign in' : undefined}
        className={cn(
          'flex min-w-0 items-center gap-2 rounded-[var(--radius-control)] py-1.5 text-[13px] font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-raised)]',
          collapsed ? 'justify-center px-2' : 'px-2',
        )}
      >
        <LogIn className="size-4 shrink-0" />
        {collapsed ? <span className="sr-only">Sign in</span> : <span className="truncate">Sign in</span>}
      </button>
    );
  }

  const principal = auth.principal;
  return (
    <Popover
      side={side}
      align={align}
      width={260}
      trigger={({ open, toggle, id }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={id}
          aria-label="Your account"
          title={collapsed ? principal.display_name : undefined}
          className={cn(
            'flex min-w-0 items-center gap-2 rounded-[var(--radius-control)] py-1 text-[13px] text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-raised)] hover:text-[var(--color-ink)]',
            collapsed ? 'justify-center px-1' : 'max-w-[140px] px-1.5',
          )}
        >
          <Avatar name={principal.display_name} email={principal.email} size="sm" />
          {collapsed ? null : <span className="truncate">{principal.first_name ?? principal.display_name}</span>}
        </button>
      )}
    >
      {({ close }) => (
        <div className="p-1.5">
          <div className="flex items-center gap-2.5 px-2.5 pt-1.5 pb-2.5">
            <Avatar name={principal.display_name} email={principal.email} />
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium">{principal.display_name}</p>
              <p className="truncate text-[12px] text-[var(--color-ink-muted)]">{principal.email}</p>
            </div>
          </div>
          {domains.length > 1 ? (
            <p className="px-2.5 pb-2.5 text-[12px] text-[var(--color-ink-muted)]">
              Signed in to {signedInNames.join(', ')}
              {signedInNames.length < domains.length ? (
                <>
                  {' · '}
                  <button
                    type="button"
                    className="link font-medium"
                    onClick={() => {
                      close();
                      navigate('/sign-in', { state: { from: location } });
                    }}
                  >
                    sign in to more
                  </button>
                </>
              ) : null}
            </p>
          ) : null}
          <div className="border-t border-[var(--color-line)] px-2.5 py-2.5">
            <p className="pb-2 text-[12px] text-[var(--color-ink-faint)]">Appearance</p>
            <SegmentedControl value={appearance} options={APPEARANCES} onChange={setAppearance} className="w-full [&>button]:flex-1" />
          </div>
          <div className="border-t border-[var(--color-line)] pt-1.5">
            <button
              type="button"
              className={itemClass}
              onClick={() => {
                close();
                navigate('/settings/account');
              }}
            >
              <UserRound className="size-4" />
              Your account
            </button>
            <button
              type="button"
              className={cn(itemClass, 'md:hidden')}
              onClick={() => {
                close();
                navigate('/settings');
              }}
            >
              <Settings className="size-4" />
              Settings
            </button>
            <button
              type="button"
              className={itemClass}
              onClick={() => {
                close();
                onAbout();
              }}
            >
              <Info className="size-4" />
              About this deployment
            </button>
            <button
              type="button"
              className={itemClass}
              onClick={() => {
                close();
                void auth.signOut().then(() => navigate('/', { replace: true }));
              }}
            >
              <LogOut className="size-4" />
              {domains.length > 1 ? 'Sign out everywhere' : 'Sign out'}
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}

export function PageHeader({
  title,
  crumbs,
  subtitle,
  actions,
  meta,
  children,
}: {
  title: ReactNode;
  /** Where the page sits, above its title: the list it belongs to. */
  crumbs?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
}): ReactNode {
  return (
    <header className="border-b border-[var(--color-line)]">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-start justify-between gap-4 px-4 pt-5 pb-4 sm:px-6 md:pt-7">
        <div className="min-w-0">
          {crumbs ? <p className="mb-1 text-[13px] text-[var(--color-ink-muted)]">{crumbs}</p> : null}
          <h1 className="display truncate text-[24px] leading-tight font-semibold">{title}</h1>
          {subtitle ? <div className="mt-1 text-[13px] text-[var(--color-ink-muted)]">{subtitle}</div> : null}
          {meta ? <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}

export function PageBody({ children, className }: { children: ReactNode; className?: string }): ReactNode {
  return <div className={cn('mx-auto max-w-[1400px] px-4 py-6 sm:px-6', className)}>{children}</div>;
}

