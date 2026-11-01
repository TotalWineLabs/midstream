import { AlertTriangle, Lock, RotateCcw, Undo2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { RelativeTime } from '@/components/Inline';
import { FIELD_BASE, Select } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import type { SettingView } from '@shared/types';

import { ProtectionControl } from '../protection/ProtectionControl';
import {
  choiceMapOf,
  choiceMapText,
  draftChanges,
  draftError,
  fallbackSource,
  fallbackValue,
  formatNumber,
  formatValue,
  initialInput,
  inputHint,
  unitLabel,
  type Draft,
} from './values';

/** On/off control for boolean settings. */
export function Switch({
  checked,
  disabled,
  onChange,
  label,
  danger = false,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  label: string;
  danger?: boolean;
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-40',
        checked
          ? danger
            ? 'border-transparent bg-[var(--color-flare-ink)] dark:bg-[var(--color-flare)]'
            : 'border-transparent bg-[var(--color-primary)]'
          : 'border-[var(--color-line-strong)] bg-[var(--color-raised)]',
      )}
    >
      <span
        className={cn(
          'inline-block size-3.5 rounded-full shadow-sm transition-transform',
          checked ? 'bg-[var(--color-on-primary)]' : 'bg-[var(--color-shelf)] dark:bg-[var(--color-ink-muted)]',
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
        )}
      />
    </button>
  );
}

/**
 * One setting: what it is, the control that changes it, and where its value comes from.
 *
 * Edits are drafts until the page is saved. A reset returns the setting to the value the
 * deployment sets, or to the built-in default when the deployment sets none.
 */
export function SettingRow({
  setting,
  draft,
  readOnly,
  serverError,
  onDraft,
  lockedReason = null,
}: {
  setting: SettingView;
  draft: Draft | undefined;
  readOnly: boolean;
  /** A problem the server reported with this setting on the last save. */
  serverError: string | null;
  onDraft: (draft: Draft | undefined) => void;
  /** Why this one setting cannot be changed by this person, when the rest can (its own permission). */
  lockedReason?: string | null;
}): ReactNode {
  const input = draft && !draft.reset ? draft.input : initialInput(setting);
  const pendingReset = draft?.reset === true;
  const changed = draftChanges(setting, draft);
  const error = draftError(setting, draft) ?? serverError;
  const hint = pendingReset ? null : inputHint(setting, input);
  const unit = unitLabel(setting);
  const id = `setting-${setting.scope}-${setting.key}`;

  const control = (() => {
    if (setting.kind === 'choice_map') {
      const options = (setting.choiceOptions ?? []).map((option) => ({ ...option }));
      const text = pendingReset ? String(fallbackValue(setting) ?? '') : String(input);
      return (
        <ProtectionControl
          idPrefix={id}
          options={options}
          labels={setting.choiceLabels ?? null}
          value={choiceMapOf(text)}
          disabled={readOnly}
          onChange={(map) => {
            const next = choiceMapText(map, options);
            onDraft(next === String(setting.value ?? '') ? undefined : { reset: false, input: next });
          }}
        />
      );
    }
    if (setting.kind === 'boolean') {
      const checked = pendingReset ? fallbackValue(setting) === true : input === true;
      return (
        <Switch
          checked={checked}
          disabled={readOnly}
          danger={setting.danger}
          label={setting.label}
          onChange={(value) => onDraft(value === setting.value ? undefined : { reset: false, input: value })}
        />
      );
    }
    if (setting.kind === 'enum') {
      const value = pendingReset ? String(fallbackValue(setting) ?? '') : String(input);
      return (
        <Select
          id={id}
          value={value}
          disabled={readOnly}
          className="h-8 w-44 text-[13px]"
          onChange={(event) =>
            onDraft(event.target.value === setting.value ? undefined : { reset: false, input: event.target.value })
          }
        >
          {(setting.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      );
    }
    const text = pendingReset ? formatInputValue(fallbackValue(setting)) : String(input);
    const wide = setting.kind === 'destination_uri' || setting.kind === 'string' || setting.kind === 'domain_list';
    return (
      <div
        className={cn(
          FIELD_BASE,
          'flex h-8 items-center gap-2 pr-2.5 focus-within:border-[var(--color-ink-muted)]',
          wide ? 'w-full md:w-72' : 'w-44',
          error && 'border-[var(--color-flare)] focus-within:border-[var(--color-flare)]',
          readOnly && 'opacity-50',
        )}
      >
        <input
          id={id}
          value={text}
          disabled={readOnly}
          inputMode={setting.kind === 'integer' ? 'numeric' : undefined}
          spellCheck={false}
          placeholder={setting.kind === 'destination_uri' ? 'None' : setting.kind === 'domain_list' ? 'Any: example.com, corp.example.org' : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-meta`}
          className={cn(
            'min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--color-ink-faint)]',
            setting.kind !== 'string' && 'numeric',
          )}
          onChange={(event) => onDraft({ reset: false, input: event.target.value })}
        />
        {unit ? <span className="shrink-0 text-[12px] text-[var(--color-ink-faint)]">{unit}</span> : null}
      </div>
    );
  })();

  const wideControl = setting.kind === 'choice_map';
  return (
    <div
      className={cn(
        'relative grid gap-3 px-5 py-4',
        !wideControl && 'md:grid-cols-[minmax(0,1fr)_auto] md:gap-8',
        changed && 'bg-[var(--color-raised)]',
      )}
    >
      {/* An edit not saved yet is marked the way a document marks a change: a bar in the margin. */}
      {changed ? <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-[var(--color-ink)]" /> : null}
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <label htmlFor={setting.kind === 'boolean' ? undefined : id} className="text-[13px] font-medium">
            {setting.label}
          </label>
          {setting.danger ? (
            <span className="inline-flex items-center gap-1 self-center text-[12px] text-[var(--color-ink-muted)]">
              <AlertTriangle className="size-3" aria-hidden />
              Can remove data
            </span>
          ) : null}
          {changed ? <span className="text-[12px] text-[var(--color-ink-muted)]">Unsaved</span> : null}
        </div>
        {setting.description ? (
          <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-[var(--color-ink-muted)] [overflow-wrap:anywhere]">{setting.description}</p>
        ) : null}
        {lockedReason ? (
          <p className="mt-1 flex items-start gap-1.5 text-[12px] text-[var(--color-ink-muted)]">
            <Lock className="mt-0.5 size-3 shrink-0" aria-hidden />
            {lockedReason}
          </p>
        ) : null}
        <SettingMeta
          id={`${id}-meta`}
          setting={setting}
          pendingReset={pendingReset}
          readOnly={readOnly}
          onReset={() => onDraft(setting.source === 'override' ? { reset: true } : undefined)}
          onUndo={() => onDraft(undefined)}
          hasDraft={draft !== undefined}
        />
      </div>
      <div className={cn('flex flex-col items-start gap-1', !wideControl && 'md:items-end')}>
        {control}
        {error ? (
          <span role="alert" className="text-[12px] text-[var(--color-flare-ink)]">
            {error}
          </span>
        ) : hint ? (
          <span className="numeric text-[12px] text-[var(--color-ink-faint)]">= {hint}</span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Where a changed value comes from, and the way back; quiet while a setting holds its default. What
 * a change applies to is said while one is being made.
 */
function SettingMeta({
  id,
  setting,
  pendingReset,
  readOnly,
  hasDraft,
  onReset,
  onUndo,
}: {
  id: string;
  setting: SettingView;
  pendingReset: boolean;
  readOnly: boolean;
  hasDraft: boolean;
  onReset: () => void;
  onUndo: () => void;
}): ReactNode {
  const fallback = formatValue(setting, fallbackValue(setting));
  const fallbackFrom = fallbackSource(setting) === 'deployment' ? 'deployment value' : 'default';
  const source = pendingReset ? (
    <span className="text-[var(--color-ink)]">
      Returns to the {fallbackFrom}, {fallback}, when saved
    </span>
  ) : setting.source === 'override' ? (
    <span>
      Changed
      {setting.updatedBy ? ` by ${setting.updatedBy}` : ''}
      {setting.updatedAt ? (
        <>
          {' · '}
          <RelativeTime value={setting.updatedAt} />
        </>
      ) : null}
      {' · '}
      {fallbackFrom} {fallback}
    </span>
  ) : setting.source === 'deployment' ? (
    <span title={setting.envVar ? `Set by ${setting.envVar}` : undefined}>Set by the deployment</span>
  ) : null;
  const effect = hasDraft && setting.effect ? <span>Applies to {setting.effect}</span> : null;
  const action = hasDraft ? (
    <button
      type="button"
      onClick={onUndo}
      className="inline-flex items-center gap-1 text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
    >
      <Undo2 className="size-3" />
      Undo
    </button>
  ) : setting.source === 'override' && !readOnly ? (
    <button
      type="button"
      onClick={onReset}
      className="inline-flex items-center gap-1 text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
      title={`Return to the ${fallbackFrom}: ${fallback}`}
    >
      <RotateCcw className="size-3" />
      Reset
    </button>
  ) : null;
  if (!source && !effect && !action) return null;
  return (
    <div id={id} className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--color-ink-faint)]">
      {source}
      {effect}
      {action}
    </div>
  );
}

function formatInputValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'number' ? formatNumber(value) : String(value);
}

export function SettingRowList({ children }: { children: ReactNode }): ReactNode {
  return <div className="divide-y divide-[var(--color-line)]">{children}</div>;
}

/** A setting value written out for history and summaries. */
export function ValueText({ setting, value }: { setting: Pick<SettingView, 'kind' | 'unit'>; value: unknown }): ReactNode {
  return <span className="numeric">{formatValue(setting, value as never)}</span>;
}
