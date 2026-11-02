---
name: console-design
description: Build, change or review anything in the Midstream console's interface in its design language, Current — a page, tab, panel, component, chart, empty state, toast, dialog, label or piece of wording. Use whenever a task touches console/src (any .tsx, styles.css, a string people read), adds a screen, a state or a chart, chooses a colour, icon, motion or words, or reviews a console UI change before a PR.
---

# Building in Current, the console's design language

The source of truth is `console/docs/10-design-system.md`; the § numbers below are its sections.
This skill is how to apply it, step by step. Read the section a step names when the step applies:
the document has the tokens, tables and reasons this skill leaves out. What a script can check,
`console/src/design.test.ts` enforces (§7 below); everything else is judgment, and this is the list
to judge by.

## 0. Start from the screen's question

- Every screen answers **one question** (§10.5's table: the Overview *Is everything flowing?*, a
  table *What's in it?*). Write the question down before building. Lead with its answer — the
  readout, the state, the rows — and move everything else out: to a properties column, a tab,
  History, or Diagnostics.
- **Reuse before building.** The patterns (§10.10: undo not "are you sure?", a plan first,
  consequences named, ⌘K, empty states) and the components (§10.11: `Readout`, `StatusPill`,
  `StatusLabel`, `Ticker`, `Shimmer`, `DataGrid`, `Panel`, `SegmentedControl`, `EmptyState`,
  `CopyButton`, …) cover most needs. A new component goes in `components/` when generic, in its
  feature folder otherwise, and into §10.11.

## 1. Colour (§10.3)

- **Tokens only**: `text-[var(--color-ink-muted)]`, never `text-gray-500`, `bg-white` or a hex.
  Tokens live in `src/styles.css`, each defined for both themes.
- **Neutrals do the work.** Ink, ink-muted and ink-faint carry text; line and line-strong carry
  borders; surface, shelf, raised and pop carry grounds.
- **Current (aqua) means flowing or live, and nothing else** — not links, buttons, selection,
  success or decoration. A link is ink with an underline; the primary button is ink.
- **A state's colour is for that state.** Dawn is starting, Buoy needs attention, Flare failed,
  Slate stopped: never a chart series, a heading, a button or a label. To emphasise something that
  is not a state, use ink strength — ink against ink-muted against faint.
- Text in a state's colour uses its `-ink` token; shapes use the base token.
- A new colour pairing is measured — 4.5:1 for text, 3:1 for shapes — in both themes before it ships.
- The pre-Current names (`--color-accent`, `--color-phase-*`) are gone, and the check refuses them.
  What was the accent is ink. What floats takes `--shadow-float`, and a dialog's backdrop
  `--color-scrim`; the danger button `--color-danger`.

## 2. Status (§10.6)

- One function decides — `lib/status.ts::statusOf` (`itemStatus` for a fleet item) — and one
  component draws it: `components/Status.tsx` (`StatusGlyph`, `StatusLabel`, `StatusPill`,
  `FactPill`). Six states, each a shape, a colour and a word.
- Never a `Badge` in a state's tone, never a phase name, reason code or Kubernetes term in view:
  `reasonWords()` turns codes into words; codes stay in Diagnostics.

## 3. Type and words (§10.4, §10.9)

- **Faces**: display (`.display`) for the number that leads a screen and the page title; the
  interface face for everything else; mono (`.ident`) for machine strings only — `sales.orders`,
  `order_id`, ids, SQL. Numbers are tabular (`.numeric`).
- **Sentence case** for every label, title and button. No all caps.
- **Words**: what it is, then what to do ("Kafka has no topic payments. Resume or delete."). Plain
  status words. Act, then offer the way back. Name consequences before they happen. No zero counts,
  no method captions, no exclamation marks. Numbers before words where a number is the answer.
- **The glossary** (§10.9): Workers, not replicas; Complete through, not valid_through; Needs
  attention, not degraded; Behind, not consumer lag; and the rest.

## 4. Motion (§10.7)

- Only the movements in §10.7, each with its meaning: numbers roll (`Ticker`), work under way
  shimmers (`Shimmer`), a state's glyph drifts or turns (`StatusGlyph`), loading is a `Skeleton`, a
  changed value flashes (`.value-flash`), a streaming row settles in (`.row-arrive`). Never
  `animate-pulse`, `-spin`, `-ping` or `-bounce` directly.
- **Live is shown by what moves, not by a dot.** A page has no live dot. `LiveIndicator` is the
  shell's, and only while the link to a control plane is down.
- **A refresh never flickers.** What is on screen stays, at full strength, until its replacement has
  arrived: keep the previous data while the next read lands (React Query's `placeholderData`), key
  rows by their identity, never swap to a skeleton or a spinner for an automatic refresh. Only a new
  question may dim the old answer.
- **One moving thing per region**; nothing loops at rest except to say live or working.
- **Reduced motion stops all of it**: CSS animations are listed in `styles.css`'s reduced-motion
  block; motion driven from script checks `usePrefersReducedMotion`.

## 5. Layout, charts, states (§10.5, §10.8)

- **A header**: one title, its state, at most one primary action. Details in a properties column.
- **Borders, not shadows**: only what floats (menus, popovers, dialogs, toasts) gets a shadow. The
  radius tokens; a 4 px grid; content capped at 1400 px.
- **The phone** (under 768 px) is for checking and acting. Nothing scrolls sideways but data; touch
  targets are 44 px or more.
- **Charts**: a time series is a 2 px line with a faint area, value first in its readout, scrubbable.
  A distribution over time is columns on a true time axis with a readout line above. A state's
  colour never paints a series. The numbers are reachable without hovering (a list, a table).
- **Empty states** say what this is in one sentence and offer the one action that fills it.
  **Errors** say what happened and the way out.

## 6. Accessibility (§10.12)

- Every action reachable by keyboard, with a visible focus ring; arrow keys in lists and charts.
- Never colour alone: a shape and a word with every state.
- Status glyphs are hidden beside their word; a ticker announces its number once.

## 7. The design check

`console/src/design.test.ts` runs with `npm test` and in CI. It fails on a literal colour, a
Tailwind palette class, a pre-Current token, motion outside §10.7, all caps, a state's colour on a
badge, and a live dot on a page. A failure prints the rule, what to use instead, and each line.

```bash
cd console && node --test src/design.test.ts
```

- **Fix the code.** Never raise the baseline (`src/design-baseline.json`) to make the check pass.
- The baseline is empty: every screen keeps every rule, so any violation fails the check. (It once
  counted the screens built before Current; it only goes down, and reached zero. Should it ever
  hold counts again, `DESIGN_BASELINE=lower node --test src/design.test.ts` lowers it after a fix,
  and never raises it.)
- A deliberate exception is added to the baseline by hand, and the PR says why.
- A rule the document gains that a script can check is added to `DESIGN_RULES`, with unit cases.

## 8. Verify by looking

The check proves the mechanical rules; only looking proves the screen. Before it is done (§10.13):

- Run it against real data: a local console against a control plane (`console/README.md`), or a
  deployment.
- Look at it — screenshots taken with Playwright are fine — in **both themes**, at **desktop and
  phone** width (390 px), with **reduced motion**, and **keyboard only**. Look for clipping,
  overflow, labels that do not fit, colour where it does not belong, and anything that flickers
  while live data refreshes.
- `cd console && npm run typecheck && npm test && npm run build`.

## 9. Documentation

- A new pattern, component or rule goes into `console/docs/10-design-system.md` in the same change.
- What a screen shows and does: `console/docs/11-feature-reference.md`.
- A new file: the map in `console/docs/09-client-architecture.md`.
