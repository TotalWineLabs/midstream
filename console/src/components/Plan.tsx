import { Info } from 'lucide-react';
import type { ReactNode } from 'react';

import { Panel } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';

/**
 * A plan, before anything consequential runs (docs/10-design-system.md §10.10): what will exist,
 * change or go, by the names SQL uses, what stays, and what it costs — then Cancel and the action.
 * Creating and editing a materialization show it beside the composer; deleting one, or a dataset,
 * shows it in the dialog that asks.
 */
export function PlanCard({ title = 'The plan', children, action, className }: { title?: string; children: ReactNode; action?: ReactNode; className?: string }): ReactNode {
  return (
    <Panel className={cn('p-5', className)}>
      <h2 className="text-[13px] font-semibold">{title}</h2>
      <div className="mt-3 space-y-4">{children}</div>
      {action ? <div className="mt-5 space-y-2">{action}</div> : null}
    </Panel>
  );
}

/** What the plan does to a kind of thing — *Adds*, *Drops, with its data*, *Stays* — and the things. */
export function PlanGroup({ title, children }: { title: ReactNode; children: ReactNode }): ReactNode {
  return (
    <section className="min-w-0">
      <h3 className="text-[12px] text-[var(--color-ink-faint)]">{title}</h3>
      <ul className="mt-1.5 space-y-2">{children}</ul>
    </section>
  );
}

/** A table as SQL reads it, `sales.orders`, its dataset quieter, and one line about it. */
export function PlanTable({ dataset, name, detail }: { dataset: string; name: string; detail?: ReactNode }): ReactNode {
  return (
    <li className="min-w-0">
      {/* Wrapped, never cut: a plan names exactly what it touches. */}
      <p className="ident text-[13px] [overflow-wrap:anywhere]">
        <span className="text-[var(--color-ink-muted)]">{dataset}.</span>
        {name}
      </p>
      {detail ? <p className="text-[12px] text-[var(--color-ink-faint)] [overflow-wrap:anywhere]">{detail}</p> : null}
    </li>
  );
}

/** Any other thing in a group: a topic, a setting. */
export function PlanItem({ children, detail }: { children: ReactNode; detail?: ReactNode }): ReactNode {
  return (
    <li className="min-w-0">
      <p className="text-[13px] [overflow-wrap:anywhere]">{children}</p>
      {detail ? <p className="text-[12px] text-[var(--color-ink-faint)]">{detail}</p> : null}
    </li>
  );
}

/** A value the plan changes, from what it is to what it becomes. */
export function PlanChange({ label, from, to }: { label: string; from: ReactNode; to: ReactNode }): ReactNode {
  return (
    <li className="flex min-w-0 items-baseline justify-between gap-3 text-[13px]">
      <span className="shrink-0 text-[var(--color-ink-muted)]">{label}</span>
      <span className="min-w-0 text-right [overflow-wrap:anywhere]">
        <span className="text-[var(--color-ink-faint)] line-through decoration-[var(--color-line-strong)]">{from}</span>
        <span className="px-1.5 text-[var(--color-ink-faint)]" aria-label="to">
          →
        </span>
        {to}
      </span>
    </li>
  );
}

/** A setting the plan holds, by name and value. */
export function PlanRow({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[13px]">
      <dt className="shrink-0 text-[var(--color-ink-faint)]">{label}</dt>
      <dd className="min-w-0 truncate text-right" title={typeof children === 'string' ? children : undefined}>
        {children}
      </dd>
    </div>
  );
}

/** What it costs and what happens next, in a sentence or two. */
export function PlanNote({ children }: { children: ReactNode }): ReactNode {
  return <p className="text-[12px] leading-relaxed text-[var(--color-ink-muted)]">{children}</p>;
}

/** Why the action cannot run yet, said where the action is: the one thing to do first. */
export function PlanBlocked({ children }: { children: ReactNode }): ReactNode {
  return (
    <p role="status" className="flex items-start gap-1.5 text-[12px] leading-relaxed text-[var(--color-ink)]">
      <Info className="mt-0.5 size-3.5 shrink-0 text-[var(--color-ink-muted)]" aria-hidden />
      <span>{children}</span>
    </p>
  );
}
