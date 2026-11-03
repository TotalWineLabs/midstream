# 10 — Design language

The console's design language is **Current**. This document defines it: the principles every screen
answers to, the identity, colour, type, status, motion, numbers, writing, patterns and components.
Any change to the console's interface follows it. A change that needs something it doesn't cover
adds that here first.

Sources: `src/styles.css` (tokens, motion), `src/components/` (`Logo.tsx`, `Status.tsx`,
`motion/`, `ui/`), `src/lib/status.ts`, `src/lib/ticker.ts`, `design/mark/mark.py`.

## 10.1 Principles

Apple's eight design principles (Human Interface Guidelines, reintroduced June 2026) are the guide.
Midstream follows Apple's principles but not its look: no Liquid Glass, no SF Pro, no system
colours, no iOS patterns. Linear, ChatGPT, Claude and Robinhood show the method: one colour that
belongs to the product, a typographic voice, one signature interaction, a metaphor from the
product's own world, and restraint. Midstream's metaphor is water: a stream carried into a lake.

| Principle | Apple's words | What it means here |
|---|---|---|
| Purpose | "Make something meaningful." | Every screen answers the question people come with: is my data flowing, and what does it say? |
| Agency | "Let people do things their own way." | Reversible actions act at once and offer Undo. A plan comes first only where data or time is at stake. ⌘K reaches anything from anywhere. |
| Responsibility | "Act in people's best interest." | Protection is always in view. A delete names what it removes, table by table. The waterline says which rows other engines can read yet. |
| Familiarity | "Build on what people know." | Web patterns people use every day: a sidebar, a command menu, a properties column, popovers, a share dialog like a document's. |
| Flexibility | "Adapt to diverse contexts and needs." | Desktop and phone layouts, both themes, keyboard and touch, reduced motion, larger text. |
| Simplicity | "Be clear and direct." | One question per screen, answered in its first line. Six status states. How a number is measured goes behind (i). |
| Craft | "Care about every detail." | Three faces, each with one job. One signal colour with one meaning. Numbers that line up and roll as they change. |
| Delight | "Make it human." | Delight comes from calm and clarity, never decoration. Motion carries meaning: a number rolls the way it moved, a backlog shows when it ends. |

Rules that follow from them:

- **Lead with the answer.** The first line of a screen, panel or row says what matters for its state.
  Everything else is a click away.
- **One question per screen** (§10.5). What doesn't serve the screen's question moves to properties,
  a popover, an (i) or Settings.
- **Hide zero counts.** "0 failing" is noise. Say nothing, or say it once ("All flowing").
- **No method captions in view.** "Rows per second, measured per runtime member between its own
  heartbeats" goes behind an (i) beside the number.
- **Every number keeps its source.** Exactness isn't lost, only moved: the (i) says how it is
  measured, and Diagnostics shows the raw state.

## 10.2 Identity

**Concept: the waterline.** Midstream works between a moving stream (Kafka) and a settled lake
(Iceberg). Data above the line is live in the console within seconds. Data below it is committed and
readable by every engine. The identity takes its parts from there: deep-water neutrals, one aqua
signal for anything flowing or live, and a line between moving and settled data.

### The mark

One stream, drawn with a pen. It rises twice, the second rise lower, and settles into a line.

| Property | Value |
|---|---|
| Construction | A round nib swept along a centreline (`design/mark/mark.py::CENTRELINE`); the outline is the union of the nib's hull between samples |
| Pressure | Heavier on the way down, lighter on the way up (`light`), touching down a little light, easing off along the tail (`tail`); smoothed along the stroke so it never steps |
| Cuts | `display` for 48 px and up: full contrast. `text` for 32 px and under: radius ×1.22, upstrokes at 0.72 rather than 0.56, the tail to 0.24, so the thin strokes hold beside text and in a tab |
| Colour | One colour, flat. No gradients, glows, outlines, dots or ripples |
| App icon | Ink `#07090C` on a Current `#3EF0C5` tile, corner radius 15/64 (14/64 for the favicon) |
| In the interface | The mark alone, in `--color-current`, beside the wordmark |
| Clear space | Half the mark's height on every side |
| Smallest size | 16 px, always the text cut |

- **Generated, not drawn by hand.** Change `design/mark/mark.py` and run it. It writes
  `src/components/markPaths.ts`, `public/favicon.svg`, `public/icons/mark.svg`,
  `public/icons/mark-maskable.svg` and `design/mark/apple-touch-icon.svg`, and its docstring lists
  the PNG renders: `icon-192.png`, `icon-512.png`, `maskable-512.png` and `apple-touch-icon.png`.
- **Use `Mark` and `Lockup`** (`components/Logo.tsx`), never an `<img>` of the SVG: the component
  picks the cut, takes the text colour, and draws itself in.
- **Where no component can go**, the repository's README, the lockup is an image generated the same
  way: `design/mark/lockup.py` writes `design/mark/lockup-dark.svg` and `lockup-light.svg`, the
  `Lockup` scaled to a 64 px mark, the name outlined from the display face so the image needs no
  font. The README shows each in its theme (`<picture>`), as it does its screenshots.
- **Don't** recolour the tile, add effects, rotate or stretch the mark, set it in two colours, or put
  it on a busy background.

### The wordmark

"Midstream" in Bricolage Grotesque, weight 600, tracking −0.022em, beside the mark at a gap of a
third of the mark's size (`Lockup`). Always one word with a capital M.

### The web app

`index.html` and `public/manifest.webmanifest` make the console installable. Theme colours
`#07090C` (Deep) and `#EDF1F3` (Shallows), the maskable icon with the mark inside the safe circle,
and a square touch icon that iOS rounds itself.

## 10.3 Colour

Neutrals do the work, so the signal can speak. Tokens live in `src/styles.css`: Shallows (light) in
`@theme`, Deep (dark) under `.dark`. Use tokens, never literal colours.

### Neutrals

| Token | Name | Shallows | Deep | Use |
|---|---|---|---|---|
| `--color-abyss` / `--color-canvas` | Abyss | `#edf1f3` | `#07090c` | The page ground |
| `--color-surface` | Deep | `#fbfcfc` | `#0d1116` | Sidebar, bars |
| `--color-shelf` | Shelf | `#ffffff` | `#12171e` | Panels (`.panel`) |
| `--color-raised` | Ridge, low | `#f1f4f6` | `#141a21` | Hover, table headers, chips |
| `--color-ridge` | Ridge | `#e5ebee` | `#1a212a` | Stopped pill, quiet fills |
| `--color-pop` | Pop | `#ffffff` | `#161c24` | Menus, popovers, dialogs |
| `--color-line` / `--color-line-strong` | — | 8% / 15% ink | 10% / 18% mist | Borders, inputs |
| `--color-ink` | Foam | `#0a1218` | `#e7eef5` | Text |
| `--color-ink-muted` | Mist | `#46525e` | `#8e9bac` | Context |
| `--color-ink-faint` | Silt | `#5f6973` | `#7f8a97` | Labels, placeholders, nulls |

### The signal and the states

| Token | Name | Shallows | Deep | Means |
|---|---|---|---|---|
| `--color-current` | Current | `#009e76` | `#3ef0c5` | Flowing, live. Shapes and lines |
| `--color-current-ink` | Current, as text | `#007a5c` | `#4ff5ce` | Its words |
| `--color-dawn` / `-ink` | Dawn | `#6d5ae6` / `#5643d1` | `#a799ff` / `#b9aeff` | Starting, on its way |
| `--color-buoy` / `-ink` | Buoy | `#bf7c00` / `#9a5800` | `#ffb224` / `#ffc14d` | Needs attention |
| `--color-flare` / `-ink` | Flare | `#e5484d` / `#c2252b` | `#ff6369` / `#ff8086` | Failed |
| `--color-slate` | Slate | `#808c99` | `#6f7c8c` | Stopped |
| `--color-*-wash` | Wash | 11–13% of the colour | 12–14% | A state's pill, selection |
| `--color-veil` | Veil | 7% ink | 8% mist | A masked column: a fine 135° hatch behind its values (`.veil`), which are quieter and fixed-width |
| `--color-danger` / `--color-on-danger` | Danger | Flare's ink, white text | Flare, Abyss text | The danger button: what destroys data |
| `--color-on-flare`, `--color-on-buoy` | — | white, `#1a1300` | the same | The marks inside a state's shape: Flare's bar, Buoy's stroke |
| `--color-scrim` | Scrim | 25% Abyss | 55% black | The page dimmed behind a dialog or the command menu |
| `--shadow-float` | — | a soft drop | a deeper one | The one shadow: what floats (§10.5) |
| `--brand-tile` / `--brand-ink` | — | `#3ef0c5` / `#07090c` | the same | The app icon, the same in either theme (§10.2) |

Rules:

- **Current means flowing or live, and nothing else.** Not links, not buttons, not selection, not
  decoration. A link is ink with an underline (`.link`); the primary button is ink
  (`--color-primary`).
- **Status colour is for status.** A state's colour never paints a chart series, a heading or a button.
- **Never colour alone.** Every state has a shape and a word (§10.6).
- **Ink for words, base for shapes.** Text in a state's colour uses its `-ink` token. Glyphs and
  lines use the base token.
- **Contrast, measured** on canvas, surface, shelf, raised and pop in both themes: Foam 14.6:1 or
  more, Mist 6.1:1, Silt 4.9:1, each state's ink 4.7:1, and each state's ink on its own wash 4.7:1.
  Every shape colour reads at 3:1 or more (Current 3.0, Slate 3.0, Buoy 3.0, Flare 3.4, Dawn 4.3 in
  Shallows; far more in Deep). Ridge carries only Mist text. A new token passes the same test before
  it ships.
- The pre-Current names (`--color-accent`, `--color-phase-*`) are gone: every screen is in Current,
  and the design check refuses them (§10.13). What was the accent is ink; a state goes through
  `statusOf`, or `plainStatus` for one that is not a materialization's (a job under way, a failed
  sign-in), and `components/Status.tsx`.

### Themes

Deep (dark) and Shallows (light) are equally finished. The operating system chooses, unless the person
picks one in the account menu (`console.theme` in local storage: `system`, `light` or `dark`). The
choice is applied before first paint (`index.html`), and a change in the system's setting applies
at once while the console follows it. Dark variants use the `.dark` class
(`@custom-variant dark`).

## 10.4 Type

Three faces, each with one job, all open source and self-hosted (`@fontsource-variable`, imported in
`main.tsx`).

| Face | Token | Job |
|---|---|---|
| Bricolage Grotesque | `--font-display`, `.display` | The number that leads a screen, page titles, the wordmark. Optical size 96 at display sizes |
| Instrument Sans | `--font-sans` | The interface: everything else |
| Spline Sans Mono | `--font-mono`, `.ident` | Machine strings: table and column names, ids, SQL, code |

| Role | Size / weight | Notes |
|---|---|---|
| Readout number | 44–64 px / 600, display | Tracking −0.035em; tabular |
| Page title | 22–24 px / 600, display | One per page |
| Section title | 15 px / 600 | |
| Panel title | 13 px / 600 | |
| Body | 13–14 px / 400 | 14 px on phones |
| Secondary | 12 px / 400, Mist | |
| Label | 11–12 px / 500, Silt | Sentence case: no all-caps labels |

- **Numbers are tabular** (`.numeric`, or `font-variant-numeric: tabular-nums`) so they line up and
  don't jitter as they change. They stay in the interface or display face, never the code face.
- **Machine strings are mono** (`.ident`): `sales.orders`, `order_id`, `mat-0a26…`. Prose is never mono.
- **Sentence case** for every label, title and button.

## 10.5 Structure and layout

### One question per screen

| Screen | Its question | Leads with | Moves out |
|---|---|---|---|
| Overview | Is everything flowing? | The readout, what needs you, the river | Method captions, a stat card per counter |
| Materializations | Which one needs me? | Groups by state, one fact per row | Size and last change, into a row's properties |
| A materialization | Is it healthy, and what does it write? | Its state's number, one chart, its tables | Reconciliation, specification and runtime state, into properties and Diagnostics |
| A table | What's in it? | Rows, newest first, with the waterline | Snapshots and maintenance, into History |
| Explore | What does the data say? | The answer to the question asked: rows and their count under the composer, the lake's tables beside | Earlier questions, into History; a table's snapshots and maintenance, into its page |
| Datasets | What data is there, and who can use it? | Datasets, their tables, your access | Access management, into a Share popover |
| Settings | How should this domain behave? | A page per area, searchable | Provenance on unchanged values |

### The shell

- **Desktop:** a sidebar (mark and name, domain switcher, search, navigation, pinned items,
  Settings, account) beside the content. A page has a header with one title, its state and at most
  one primary action. Details live in a properties column on the right, which closes.
- **Phone (under 768 px):** the sidebar becomes a bottom bar of four places: Overview, Datasets,
  Activity, Search. Secondary actions wait in a ⋯ menu. The phone is for checking and acting: status,
  stop and resume, rows, search.
- **Width:** content is capped at 1400 px and centred. Explore alone takes the width (`PageHeader wide`): a workspace with a rail on either side of its rows.
- **Spacing:** a 4 px grid. Panels 20 px inside, 16 px on phones. Rows 40–48 px tall on desktop,
  48 px or more on touch.
- **Radius:** `--radius-control` 8 px for controls, `--radius-panel` 12 px for panels,
  `--radius-pill` for pills.
- **Elevation:** borders, not shadows. Only what floats (menus, popovers, dialogs, toasts, a chart's
  readout) gets a shadow, `--shadow-float`, on `--color-pop`; a dialog dims the page behind it with
  `--color-scrim`.

## 10.6 Status

Eleven lifecycle phases, four health levels and the drift between desired and observed read as
**six states**, each a shape, a colour and a word. One function decides (`lib/status.ts::statusOf`)
and one component draws it (`components/Status.tsx`), everywhere: lists, page headers, search,
the phone, the sidebar badge.

| State | Shape | Colour | From | Says with it |
|---|---|---|---|---|
| **Flowing** | A wave | Current | `running`, healthy, lag at its floor | Complete through 2:41 PM |
| **Catching up** | A filling ring | Current | `running`, healthy, a backlog above the floor clearly falling | 62% · 1 h 50 min left |
| **Starting** | A dotted ring, turning | Dawn | `requested`, `discovering`, `discovered`, `deploying` | Creating tables, 2 of 3 |
| **Needs attention** | A diamond | Buoy | `degraded`, or an unhealthy runtime | The control plane's own message |
| **Failed** | An octagon | Flare | `failed`: never clears on its own | What failed, and the way out |
| **Stopped** | A hollow square | Slate | `stopped`, `paused` | Who stopped it, and when |

- **Transitions are named by what is happening**, with the dotted ring in the colour of where they
  lead: **Starting**, **Updating** (a materialization that has run, taking a change; a first deploy
  gives a change's reasons, so one whose workers never reported is Starting), **Resuming** (Dawn),
  and **Stopping**, **Deleting** (Slate).
- **Reasons are words.** `reasonWords()` turns the control plane's reason codes into a short phrase
  ("Its workers keep restarting"). The control plane's message wins where there is one. Codes stay
  in Diagnostics.
- **The lag floor is normal.** Offsets commit only once their rows are in the table, so a caught-up
  runtime always trails its topics by what arrived in the last batch ceiling and commit interval
  (630 s). A lag at or under that floor is Flowing (`shared/lagTrend.ts`), so long as the workers
  have read all of it but what arrived in the last two minutes: a burst that landed within the floor
  but is still being read is a backlog, not the floor. Catching up appears only for a backlog clearly
  falling, with an end time that means something.
- **Groups**, for lists: Needs you (failed, needs attention), In progress (starting, catching up,
  stopping, deleting), Flowing, Stopped (`statusGroup`).
- **Components:** `StatusGlyph` (the shape, 12 px), `StatusLabel` (shape and word in the state's ink,
  optionally the reason), `StatusPill` (on its wash, for a header or readout).

## 10.7 Motion

Motion is never decoration. Each movement says something about the data: it changed, it's live,
something is under way. The models are Robinhood's numbers, which roll as they change, and the
shimmer Claude and ChatGPT put on text while they work.

| Movement | Means | Where | Timing | Use |
|---|---|---|---|---|
| **Roll** | A live number changed, and which way | Readouts, live counts, rates, lag | `--duration-roll` 520 ms, ease-out | `Ticker` |
| **Shimmer** | Work is under way | "Running…", "Creating tables", a pending step, a button's words while it works, and a `Skeleton` while its content loads | 2.2 s sweep, linear | `Shimmer`, `Button loading`, `.skeleton` |
| **Value flash** | A value changed that doesn't roll | Cells in a list | 1.2 s fade | `.value-flash` |
| **Row arrives** | A live row just came into a table's grid | The Data tab, streaming | 1.2 s, from a stronger Current to the live ground | `.row-arrive` |
| **Mark draws in** | The console opened | The sidebar mark, once a page load | `--duration-draw` 900 ms | `Mark` |
| **Mark flows** | The console itself is waiting | Sign-in, first load, a page waiting for the console's configuration or session | 1.8 s loop | `Mark working` |
| **Wave drifts** | This is flowing now | The one status a page is about, never a list; **Streaming** while rows stream in | 2.4 s loop, linear | `StatusGlyph animate` |
| **Ring turns** | On its way somewhere | Starting, Updating, Resuming, Stopping, Deleting | 8 s loop | `StatusGlyph` |
| **Ring fills** | How far a catch-up has come | Catching up | 900 ms | `StatusGlyph progress` |
| **Slide** | A panel came from the side | Properties column, sheets | `--duration-panel` 220 ms | `.slide-in-right` |
| **Fade up** | Content arrived | New surfaces | 180 ms | `.fade-in` |
| **Run ring** | A query is filling this panel | The grid a run streams into | 5 s lap | `.run-ring` |
| **The river** | Each materialization's throughput, as velocity | The Overview | Comets at 22–270 px/s by rate (on a river 1,100 px wide, scaled with its width); each trail 0.16 s of its travel. The lake's current at 8 px/s, and 4 more for each tenfold in rows arriving a second (28 at 100,000), seen in long exposure: each trail 2.2 s of its drift | `River` (§10.8) |

Rules:

- **A number rolls the way it moved.** Up as it grows, down as it shrinks, digits matched from the right
  (`lib/ticker.ts`). A digit or separator the number gains rises into place. Nothing rolls on first
  render.
- **One moving thing per region.** A list of drifting waves is noise, so lists are still.
- **Nothing loops at rest** except to say live or working, and those loops are slow and small.
- **Live is shown by what moves, not by a dot.** The river flows, numbers roll, rows stream in: a
  dot that only ever says "fine" is one more thing to read. A page has no live dot; the shell shows
  one only while the link to a control plane is down, and a domain its dot only when it needs
  saying.
- **A refresh never flickers.** What is on screen stays, at full strength, until what replaces it
  has arrived; only a new question may dim the old answer.
- **No bounce, no overshoot, no parallax.** Easing is `--ease-out` for arrivals, `--ease-in-out`
  for loops.
- **Reduced motion stops all of it** (`prefers-reduced-motion`; `usePrefersReducedMotion` for motion
  driven from script). Every state still reads: the words and shapes carry it, and a ticker shows
  the new number at once.

## 10.8 Numbers and charts

- **The readout leads a screen:** one large number (display face) with one line of context, then a
  line chart. The number is the state's own: rows a second when flowing, records behind and the end
  time when catching up, what failed when failed.
- **Live numbers roll** (`Ticker`). Static figures don't.
- **Not measured yet is said in words:** a readout without its number, as when the console has just
  started and its workers have not reported twice, reads *Measuring rows a second…*, shimmering,
  never a dash set large.
- **Formats** (`lib/format.ts`): `formatCount` compacts at 10,000 (`1.2M`); `formatExact` for
  anything someone compares or copies. Rates read "75,312 a second" in a readout and `/s` in dense
  rows. Bytes use `formatBytes` (SI).
- **A distribution over time is columns on a true time axis** — empty stretches left empty — binned
  as finely as the width allows, with the line above it reading out the whole or the column pointed
  at (a table's partitions, §11.10). What matters is emphasised by strength, not by a state's colour.
- **Charts are line-first:** a 2 px line, a faint area, no gridlines where the axis labels
  suffice, a crosshair to scrub any moment, the value first in the readout. Throughput and lag are
  Current. A state's colour never paints a series.
- **The waterline** sits wherever live and committed meet: between a table's live rows and its
  committed ones, and at zero on a backlog chart. In a table's grid (§11.8): live rows above it on
  Current's faintest ground, their row numbers in Current; on it, in Current, "Committed 2:41:12 PM" —
  the last commit, which every row below it is in, not "complete through", which a backfill can leave
  months behind its newest rows; committed rows below. It is a 26 px strip of its own, the line
  fading in at the left and out at the right, its label held in view as the grid scrolls sideways.
- **A backlog shows its end:** while catching up, the readout says when it will be done at the
  current pace (*Caught up around 4:30 PM · 62% there*), and its chart draws the rest as dots from
  the latest measurement to zero, on an axis that runs ahead of now by up to the window's length.
  What is measured is a line; what is expected is dotted (`TimeSeriesChart`'s `projection`).
- **The river** leads the Overview: each materialization a channel from Kafka, through the Midstream
  gate, into the lake. `riverEngine.ts` moves the channels' particles and draws their bed;
  `riverLake.ts` is the lake's own water; `riverWater.ts` draws every particle as a comet on the GPU
  (WebGL 2): a round head and a trail that tapers and fades, as long as its speed. Where WebGL 2 is
  unavailable the comets are plain strokes in 2D. Every visual property is a fact:

  | What you see | What it is |
  |---|---|
  | A channel's width | Its rows a second, against the fleet's busiest |
  | Its comets' speed, and the length of their trails | Its rows a second: a slow drift when barely anything flows, a rush at tens of thousands |
  | Faster in the middle of a channel than at its edges | Nothing more than water: a laminar profile, so it reads as a stream |
  | Grey mist turning Current exactly at the gate's line, brightest just past it, now and then a glint on the line | Records becoming rows |
  | Rows running on into the lake as they moved, under its surface, and slowing into its current, where every channel's rows combine and flow on | Rows reaching the lake's tables |
  | The lake's current: how fast it flows | Rows arriving a second, across the fleet |
  | The settled rows drifting in it, brightest near the surface | Rows the lake holds, on a log scale: an empty lake shows none |
  | Light moving along the surface | The waterline: rows there are committed, and every engine can read them |
  | A crowded channel | A backlog being worked through (catching up) |
  | Records piling at the gate, in Flare or Dawn | Failed, or starting: nothing becomes a row yet |
  | Amber after the gate, slower | Needs attention |
  | A still, dashed channel | Stopped |

  The gate is the river's middle, under *Midstream*. A comet's colour is chosen per pixel, so one
  crossing the gate is a record up to the line and a row from it. Channels meet the lake at a slope
  and thin out into it. The lake is the river's last reach, not a still pool: one broad current,
  fastest at its surface, its layers meandering a little, carrying every channel's rows on together
  and out of view. It is seen in long exposure, each trail the distance its row drifts in 2.2
  seconds, so slow water still shows how it moves; a row running in lengthens its trail only once
  it has levelled out of its dive. Its rows fade as they go, so the water is brightest where a
  channel runs in. Nothing splashes and nothing rings: the lake takes rows in quietly. Sizes and
  speeds follow the river's width, so a wide screen gets a bolder river, not a finer one.

  It runs only on screen, in a visible tab; under reduced motion it is one still frame, the same
  comets as if photographed: a new channel arrives as it would be after running a while, rows
  already in the lake. Pointing at a channel names it and its rate, and dims the others and the lake;
  clicking opens it; the same channels are links for a keyboard or a screen reader. In the dark
  theme the water adds up to light, each comet has a faint halo and a blurred copy glows beneath
  it; in the light theme comets lie over one another like ink, with a soft tint beneath.

## 10.9 Writing

Fewer, plainer words. Every sentence on screen asks for attention.

- **Say what it is, then what to do.** "Kafka has no topic payments. Resume or delete."
- **Plain status words** (§10.6), never phase names, reason codes or Kubernetes terms in view.
- **Act, then offer the way back:** "Inventory stopped. Nothing is lost. Undo", not a dialog
  that asks first.
- **Name consequences before they happen:** "This permanently deletes 2 tables and their data."
- **No zero counts, no method captions, no exclamation marks.** Sentence case everywhere.
- **Numbers before words** where a number is the answer.

The glossary: terms the console says differently from the system.

| The system says | The console says | Where |
|---|---|---|
| desired / observed phase | Target / Status | Together only while they differ |
| reconciling, deploying | Starting, Stopping, Updating | Named by what is happening |
| degraded | Needs attention | Always with the control plane's message |
| consumer lag | Behind | In records, or in time where it's known |
| valid_through | Complete through | Every record before that time is in the table |
| runtime, members, replicas | Workers | Kubernetes names stay in Diagnostics |
| committer | Commit worker | Properties only |
| compaction | Merge small files | Settings and History |
| snapshot expiry | Prune old versions | "Snapshot" stays in History and Connect, where Iceberg readers expect it |
| orphan cleanup | Remove unused files | |
| reprotect, purge | Mask existing rows, erase old versions | The consequence named before it runs |
| tombstones | Null records | |
| `_unmapped` | Overflow | Explained where it appears |
| KasprApp, binding, spec hash, generation | — | Diagnostics, for support |

"Materialization" stays: it is the product's term, in the API and the docs. The empty state defines it once.

## 10.10 Patterns

| Pattern | Use it for | Shape |
|---|---|---|
| **Undo, not "Are you sure?"** | Reversible actions: stop, resume, pin | Act at once; a toast with Undo |
| **A plan first** | Where data or time is at stake: create, edit, change topics, delete, reprotect | A card listing what will exist, change or go, by SQL names, what stays, and what it costs ("its workers stop for about two minutes"); Cancel and the action. Creating and editing a materialization are the model: the composer leads, the plan sits beside it, kept current as anything changes (`CreateMaterializationPage.tsx`, `EditMaterializationPage.tsx`). Deleting a materialization or a dataset shows the plan in the dialog that asks. The action says what it does — *Save, dropping 2 tables*, *Delete it and 2 tables* — as a danger button when data is destroyed, and what stops it is said beside it, once. Its parts: `components/Plan.tsx` |
| **Consequences named** | Destructive actions | The plan lists each table that goes, with its rows and size, under a heading that says it cannot be undone |
| **⌘K** | Going anywhere, doing anything | One field: places, tables, actions with their target named |
| **Properties column** | A selected thing's details | A right column, closable, keys in Silt, values in Foam; on a phone, a sheet. The materialization's properties, and a row of a table's Data tab (`RowProperties.tsx`), whose grid marks the open row with an ink bar |
| **(i)** | How a number is measured | A popover beside the number |
| **Activity** | Changes in flight and what just happened | Real steps with estimates; a refusal that arrives later lands here too |
| **History** | Asking the data | An exploration's questions, newest first, each with its answer in a few words — rows, time, or why it failed — beside the rows as a properties column (a sheet on a phone). Choosing one puts it back in the composer and shows its run again, or, once the run is gone, waits for Run; Run pressed again on the newest asks it again in its place rather than adding one (`features/explore/HistoryColumn.tsx`) |
| **Share** | Who can use a dataset | A popover like a document's, opened from **Share** in the header: a row to add someone with a role, the people and groups with their role as a choice, roles in one sentence each, what access doesn't cover (`SharePopover.tsx`) |
| **Search in place** | A page with many things to find: Settings | A box heading the page's navigation, focused with `/` (a page claims the key through `FOCUS_SEARCH_EVENT`; ⌘K stays the command menu's). What matches replaces the content, grouped by where it lives, each result the thing itself — a setting is changed right there |
| **Drafts** | Edits saved together: Settings | An edited row has a raised ground and an ink bar in its margin, *Unsaved* beside its name; its section has a dot; a bar at the foot counts the edits and offers Discard and Save |
| **Tabs keep their place** | The tabs of one page: a table's, Explore's explorations | Going back to a tab finds it as it was left until the page is left — its rows, what was asked of them, the row open, where it and the page were scrolled. Out of sight, a tab waits rather than works: no streaming, no reads on a timer, no keys; shown again, it catches up. Nothing says so: it is simply still there (`components/TabPanel.tsx`) |
| **Empty state** | Nothing here yet | What this is, in one sentence, and the one action that fills it |

## 10.11 Components

| Component | File | Use |
|---|---|---|
| `Mark`, `Lockup` | `components/Logo.tsx` | The mark, the mark with the name (§10.2) |
| `StatusGlyph`, `StatusLabel`, `StatusPill` | `components/Status.tsx` | Status, everywhere (§10.6) |
| `FactPill` | `components/Status.tsx` | A row's one fact in its state's tint |
| `Ticker` | `components/motion/Ticker.tsx` | A live number (§10.7) |
| `Shimmer` | `components/motion/Shimmer.tsx` | Words for work under way |
| `Readout` | `components/Readout.tsx` | The number that leads a screen: pills, the number, its unit in words, one line of context, its chart (§10.8) |
| `CommandMenu` | `components/CommandMenu.tsx` | ⌘K (§10.10) |
| `River` | `features/overview/River.tsx` | The fleet as strands from Kafka to the lake (§10.8) |
| `MaterializationRow` | `features/materializations/MaterializationRow.tsx` | A materialization in a list: glyph, name, state, one fact |
| `LiveIndicator` | `components/AppShell.tsx` | The link to a control plane, said only while it is down: a Buoy dot and the words |
| `Button` | `components/ui/primitives.tsx` | `primary` (ink, one per screen), `secondary`, `ghost`, `danger` |
| `Panel`, `PanelHeader`, `Badge`, `Input`, `Field`, `SegmentedControl`, `EmptyState`, `Skeleton`, `KeyValue` | `components/ui/primitives.tsx` | Building blocks |
| `Dialog`, `Popover`, `ToastProvider` | `components/ui/` | Floating surfaces; a popover keeps inside the screen |
| `PlanCard`, `PlanGroup`, `PlanTable`, `PlanItem`, `PlanChange`, `PlanRow`, `PlanNote`, `PlanBlocked` | `components/Plan.tsx` | A plan first (§10.10): the card, a group of what it does to a kind of thing, a table by its SQL name, a value from → to, what it costs, what stops it |
| `SharePopover` | `features/datasets/SharePopover.tsx` | Share (§10.10) |
| `SettingsSearchField`, `SettingsSearchResults` | `features/settings/SettingsSearch.tsx` | Search in place (§10.10), on the Settings pages |
| `TabPanel`, `useOpenedTabs`, `useTabShown` | `components/TabPanel.tsx` | Tabs keep their place (§10.10): a page's opened tabs, each kept mounted and hidden while another is shown; whether the tab something renders in is on screen |
| `ExplorationTabs`, `ExplorationsMenu` | `features/explore/ExplorationTabs.tsx` | Explore's open explorations as tabs (← →, F2 to rename, Delete to close; on a phone only the shown tab closes, its controls 44 px), and every exploration kept, to open, duplicate or delete with Undo |
| `TablesRail` | `features/explore/TablesRail.tsx` | The lake: domains, datasets and tables with their writers' glyphs, found with `/`; a table browsed, or its name put in the statement being written; a sheet on a phone |
| `TableChooser` | `features/explore/TableChooser.tsx` | **From**: the table a workbench in Explore is about, chosen by name |
| `HistoryColumn` | `features/explore/HistoryColumn.tsx` | History (§10.10) |
| `FoundName`, `CutName` | `features/explore/Names.tsx` | A table found by a search, its own name first and its place after in faint; a name too long for its row cut in the middle — its start and its last characters, where names that share a start differ — and read whole to a screen reader |
| `TimeSeriesChart`, `Sparkline` | `components/` | Charts (§10.8) |
| `DataGrid` | `components/DataGrid.tsx` | Rows |
| `Avatar`, `RelativeTime`, `Identifier`, `CopyButton` | `components/` | People, times, ids |

Building a component:

1. Generic goes in `components/` (or `components/ui/` for primitives). Feature-specific stays in its
   feature folder.
2. Tokens only. `text-[var(--color-ink-muted)]`, never `text-gray-500` or a hex value.
3. Compose classes with `cn()`, accept `className`, return `ReactNode`, forward refs for anything
   focusable.
4. Motion through the classes and components in §10.7, each stopped under reduced motion.
5. Check both themes, desktop and phone widths, keyboard use and reduced motion before it's done.

## 10.12 Accessibility

- **Contrast:** 4.5:1 for text and 3:1 for shapes, in both themes (§10.3).
- **Never colour alone:** a shape and a word with every state.
- **Keyboard first on desktop:** every action reachable, a visible focus ring (2 px ink), ⌘K,
  arrow keys in lists and charts.
- **Touch first on phones:** targets at least 44 px.
- **Screen readers:** a ticker announces the formatted number once (its rolling digits are hidden);
  the mark is decorative beside the name and labelled alone; status glyphs are hidden beside their
  word.
- **Reduced motion:** all motion stops, nothing is lost (§10.7).
- **Larger text:** layouts use rem and wrap; nothing truncates a status word.

## 10.13 Checklist

Before a change to the interface is done:

- [ ] The screen's question is answered in its first line, and nothing on it serves another question.
- [ ] Current appears only for flowing or live things. No new colours outside the tokens.
- [ ] Status goes through `statusOf` and `components/Status.tsx`.
- [ ] Live numbers roll; static ones don't. Nothing moves without a meaning in §10.7.
- [ ] Words follow §10.9: plain status, no codes, no zero counts, no method captions in view.
- [ ] Both themes, desktop and phone, keyboard only, and reduced motion, checked.
- [ ] Contrast measured for any new colour pairing.
- [ ] The design check passes (`src/design.test.ts`), and a baseline it says is too high is lowered.
- [ ] This document updated if the change adds a pattern, a component or a rule.

## 10.14 Keeping to it

Every session that changes the interface — a person's or an agent's — meets the design language in
three places, each doing what the others cannot:

| Where | What it carries | When |
|---|---|---|
| `AGENTS.md` | The rule, in a sentence, and where to start: the skill | Every session in the repository |
| The `console-design` skill (`.claude/skills/console-design/SKILL.md`) | How to apply this document, step by step, and what to look at before it is done | A task that touches the interface |
| The design check (`src/design.test.ts`, in `npm test` and CI) | The rules a script can check: no literal colours or palette classes, no pre-Current tokens, no motion outside §10.7, no all caps, no state colour on a badge, no live dot on a page | Every change, whoever made it |

This document stays the one source: the skill points into it rather than repeating it, and the check
encodes its mechanical rules. What only judgment can tell — one question per screen, plain words,
Current only for what flows — is the skill's checklist and review's.

Every screen keeps every rule: `src/design-baseline.json`, which counted the screens built before
Current per rule and file and only ever went down, is empty. A file may have no violation; a change
that would add one fails the check. Should the baseline hold counts again, a change that fixes one
lowers it (`DESIGN_BASELINE=lower node --test src/design.test.ts`, which lowers and never raises). A
deliberate exception is added by hand, where review sees it. A new rule a script can check joins
`DESIGN_RULES` with its own unit cases.
