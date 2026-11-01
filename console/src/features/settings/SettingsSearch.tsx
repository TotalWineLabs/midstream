import { ArrowRight, Search, X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { Button, EmptyState, FIELD_BASE, Panel } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { FOCUS_SEARCH_EVENT, type FocusSearchKey } from '@/lib/shortcuts';
import type { SettingView } from '@shared/types';

import { DeploymentSection } from './DeploymentSection';
import { SettingRowList } from './SettingRow';
import type { SettingsSearchResult } from './search';
import type { SettingsSection } from './sections';

/** The search box over a Settings page's sections; `/` focuses it, Escape clears it. */
export function SettingsSearchField({ value, onChange }: { value: string; onChange: (value: string) => void }): ReactNode {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focus = (event: Event): void => {
      // ⌘K stays the command menu's: it reaches beyond settings.
      if ((event as CustomEvent<FocusSearchKey>).detail !== '/') return;
      event.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener(FOCUS_SEARCH_EVENT, focus);
    return () => window.removeEventListener(FOCUS_SEARCH_EVENT, focus);
  }, []);

  return (
    <div className={cn(FIELD_BASE, 'flex h-9 items-center gap-2 px-2.5 focus-within:border-[var(--color-ink-muted)]')}>
      <Search className="size-4 shrink-0 text-[var(--color-ink-faint)]" aria-hidden />
      <input
        ref={input}
        type="text"
        role="searchbox"
        value={value}
        placeholder="Search settings"
        aria-label="Search settings"
        spellCheck={false}
        autoComplete="off"
        className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--color-ink-faint)]"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          if (value) onChange('');
          else input.current?.blur();
        }}
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onChange('');
            input.current?.focus();
          }}
          className="grid size-5 shrink-0 place-items-center rounded-[var(--radius-control)] text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
        >
          <X className="size-3.5" />
        </button>
      ) : (
        <kbd className="hidden rounded border border-[var(--color-line)] px-1.5 font-sans text-[11px] text-[var(--color-ink-faint)] md:block">/</kbd>
      )}
    </div>
  );
}

/**
 * What a search finds, in place of a section: each matching setting under its section, editable
 * here like there, with the same drafts and save bar; what only the deployment sets; and the
 * sections without settings, such as Users, whose name matches.
 */
export function SettingsSearchResults({
  query,
  result,
  base,
  deploymentLabel,
  renderRow,
  onClear,
}: {
  query: string;
  result: SettingsSearchResult;
  /** Where the page is: `/settings`, or a domain's `/d/<domain>/settings`. */
  base: string;
  deploymentLabel: string | null;
  renderRow: (setting: SettingView) => ReactNode;
  /** Ends the search: cleared, or a section opened from it. */
  onClear: () => void;
}): ReactNode {
  const quoted = `“${query.trim()}”`;
  if (result.count === 0 && result.sections.length === 0) {
    return (
      <Panel>
        <EmptyState
          icon={<Search className="size-5" />}
          title={`Nothing matches ${quoted}`}
          description="Search reads each setting’s name, description and environment variable, and each section’s name."
          action={
            <Button size="sm" onClick={onClear}>
              Clear search
            </Button>
          }
        />
      </Panel>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-[15px] font-semibold tracking-tight">
        {result.count > 0 ? `${result.count} ${result.count === 1 ? 'setting matches' : 'settings match'} ${quoted}` : `No setting matches ${quoted}`}
      </h2>

      {result.sections.length > 0 ? (
        <Panel>
          <ul className="divide-y divide-[var(--color-line)]">
            {result.sections.map((section) => (
              <li key={section.id}>
                <Link
                  to={`${base}/${section.id}`}
                  onClick={onClear}
                  className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-[var(--color-raised)]"
                >
                  <section.icon className="size-4 shrink-0 text-[var(--color-ink-muted)]" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium">{section.label}</span>
                    <span className="block text-[12px] text-[var(--color-ink-muted)]">{section.summary}</span>
                  </span>
                  <ArrowRight className="size-3.5 shrink-0 text-[var(--color-ink-faint)]" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {result.groups.map(({ section, settings }) => (
        <ResultGroup key={section.id} section={section} base={base} onOpen={onClear}>
          <SettingRowList>{settings.map(renderRow)}</SettingRowList>
        </ResultGroup>
      ))}

      {result.deployment.length > 0 && deploymentLabel ? (
        <section aria-label={deploymentLabel} className="space-y-2">
          <h3 className="flex items-baseline gap-2 text-[13px]">
            <Link to={`${base}/deployment`} onClick={onClear} className="font-medium hover:underline">
              {deploymentLabel}
            </Link>
            <span className="text-[12px] text-[var(--color-ink-faint)]">Fixed when deployed</span>
          </h3>
          <DeploymentSection entries={result.deployment} />
        </section>
      ) : null}
    </div>
  );
}

function ResultGroup({
  section,
  base,
  onOpen,
  children,
}: {
  section: SettingsSection;
  base: string;
  onOpen: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <section aria-label={section.label} className="space-y-2">
      <h3 className="text-[13px]">
        <Link to={`${base}/${section.id}`} onClick={onOpen} className="inline-flex items-center gap-2 font-medium hover:underline">
          <section.icon className="size-4 text-[var(--color-ink-muted)]" aria-hidden />
          {section.label}
        </Link>
      </h3>
      <Panel>{children}</Panel>
    </section>
  );
}
