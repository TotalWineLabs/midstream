import { Code2, Table2, X } from 'lucide-react';
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { fullName, questionParts, type Question } from './explorations';
import { CutName } from './Names';
import { useSheet } from './useSheet';
import { RelativeTime } from '@/components/Inline';
import { Shimmer } from '@/components/motion/Shimmer';
import { StatusLabel } from '@/components/Status';
import { Button } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { formatDuration, formatExact } from '@/lib/format';
import { plainStatus } from '@/lib/status';

/**
 * An exploration's questions, newest first (docs/design/explore.md §4.6): what each asked and what it
 * came to. Choosing one puts it back in the composer and shows its answer, while its run lasts. A
 * column beside the answer, as a row's properties are (§10.10); a sheet over it on a phone.
 */
export function HistoryColumn({
  history,
  onScreen,
  running,
  onOpen,
  onClose,
  sheet = false,
  slide = false,
}: {
  history: readonly Question[];
  /** The question on screen. */
  onScreen: string | null;
  /** The question on screen is still being answered. */
  running: boolean;
  onOpen: (question: Question) => void;
  onClose: () => void;
  sheet?: boolean;
  /** History was opened just now: the column slides in, once. Not when an exploration opens beside it. */
  slide?: boolean;
}): ReactNode {
  const list = useRef<HTMLOListElement>(null);
  const slides = useRef(slide).current;
  const sheetRef = useRef<HTMLElement>(null);
  useSheet(sheetRef, sheet, onClose);

  // ↑ and ↓ move between questions, as in any list; ↵ opens the one with focus.
  const onKeyDown = (event: KeyboardEvent<HTMLOListElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('button[data-question]') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[Math.max(0, Math.min(buttons.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

  const body = (
    <>
      <header className="flex items-center gap-2 border-b border-[var(--color-line)] py-2.5 pr-2 pl-4">
        <h2 className="min-w-0 flex-1 text-[13px] font-semibold">History</h2>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close history" title="Close history" className="px-1.5 max-md:size-11">
          <X className="size-4" />
        </Button>
      </header>
      {history.length === 0 ? (
        <p className="px-4 py-6 text-[12px] leading-relaxed text-[var(--color-ink-muted)]">The questions this exploration asks are kept here, newest first, to go back to.</p>
      ) : (
        <ol ref={list} aria-label="Questions asked" onKeyDown={onKeyDown} className="min-h-0 flex-1 overflow-y-auto py-1">
          {history.map((question) => {
            const current = question.id === onScreen;
            const Icon = question.kind === 'sql' ? Code2 : Table2;
            const { asked, statement, about } = questionParts(question);
            return (
              <li key={question.id}>
                <button
                  type="button"
                  data-question={question.id}
                  aria-current={current ? 'true' : undefined}
                  onClick={() => onOpen(question)}
                  title={question.kind === 'sql' ? (question.sql ?? '') : question.source ? fullName(question.source) : undefined}
                  className={cn(
                    // The focus ring inside the row: the list scrolls, and would clip one drawn outside it.
                    'flex w-full flex-col gap-0.5 px-4 py-2 text-left transition-colors hover:bg-[var(--color-raised)] focus-visible:outline-offset-[-2px]',
                    // The question on screen carries an ink bar, as an open row does.
                    current && 'bg-[var(--color-raised)] shadow-[inset_2px_0_0_var(--color-ink)]',
                  )}
                >
                  <span className="flex min-w-0 items-baseline gap-2">
                    <Icon className="size-3.5 shrink-0 self-center text-[var(--color-ink-faint)]" aria-hidden />
                    {/* What was asked leads; the table, the same for most of an exploration's questions, gives way. */}
                    <span className={cn('max-w-full shrink-0 truncate text-[12.5px] text-[var(--color-ink)]', statement && 'ident')}>{asked}</span>
                    {about ? (
                      <span className="ident flex min-w-0 text-[11px] text-[var(--color-ink-faint)]">
                        <CutName text={about} />
                      </span>
                    ) : null}
                  </span>
                  <span className="numeric flex min-w-0 items-center gap-1.5 pl-[22px] text-[11px] text-[var(--color-ink-muted)]">
                    <RelativeTime value={question.askedAt} />
                    <Outcome question={question} running={current && running} />
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );

  if (sheet) {
    return createPortal(
      <aside ref={sheetRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="History" className="slide-in-right fixed inset-0 z-50 flex flex-col bg-[var(--color-surface)] outline-none">
        {body}
      </aside>,
      document.body,
    );
  }
  return (
    <aside aria-label="History" className={cn('flex w-[300px] shrink-0 flex-col border-l border-[var(--color-line)] bg-[var(--color-surface)]', slides && 'slide-in-right')}>
      {body}
    </aside>
  );
}

/** What a question came to, in a few words: its rows and time, or that it failed or was cancelled. */
function Outcome({ question, running }: { question: Question; running: boolean }): ReactNode {
  const outcome = question.outcome;
  if (running || !outcome) {
    return running ? (
      <>
        <span aria-hidden>·</span>
        <Shimmer>Running</Shimmer>
      </>
    ) : null;
  }
  if (outcome.state === 'failed') {
    return (
      <>
        <span aria-hidden>·</span>
        <span className="min-w-0" title={outcome.message ?? undefined}>
          <StatusLabel status={plainStatus('failed', 'Failed')} className="font-normal" />
        </span>
      </>
    );
  }
  if (outcome.state === 'cancelled') {
    return (
      <>
        <span aria-hidden>·</span>
        <span>Cancelled</span>
      </>
    );
  }
  return (
    <>
      <span aria-hidden>·</span>
      <span className="truncate">
        {outcome.rows === null ? '' : `${formatExact(outcome.rows)} ${outcome.rows === 1 ? 'row' : 'rows'}`}
        {outcome.elapsedMs === null ? '' : ` · ${formatDuration(outcome.elapsedMs)}`}
      </span>
    </>
  );
}
