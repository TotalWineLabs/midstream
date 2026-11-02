# Midstream Explore specification

**Status:** design specification, for review; not yet built. §1 records the decisions it follows,
§15 the decisions left for review. Once built, console handbook 11 (§11.14 Explore) and 09
supersede this document where they differ.

Written 2026-11-02 against `feature/table-tab-continuity` at b2c2d2e (1.2.0 plus PR #28, which
Explore depends on for kept tabs). Every claim about current behaviour was checked against the code
and the handbook sections named beside it.

**Audience:** the implementer and the reviewers. The owner's decisions are recorded in full so the
build can proceed without coming back to them.

---

## 1. Purpose and the decisions this specification follows

Explore is a page in the console's main navigation where a person works with the data of any table,
in any dataset and any domain, the way a table's Data tab lets them work with one: browse a table's
rows with a time range, an order and filters, or write SQL over any tables, joined across datasets and
domains, with the same first-page-at-once, exact-count, streaming-tail behaviour. Several
**explorations** can be open at once, each with its own question, answer and history, and each is
the document a later release saves to the person's account and shares.

| Decision | Choice |
| --- | --- |
| The shape of a session | An **exploration**: a worksheet — the Data view's composer (a table with filters, or a statement) with one answer on screen — plus its **history** of the questions it asked, each re-openable while its run lasts. Several open at once, as tabs (decided 2026-11-02; the alternatives were a ChatGPT-like thread of statements and answers, and worksheets without history) |
| Persistence in this release | **In the browser**, like pins and the theme: explorations and their history survive reloads per browser profile. The client reads and writes an `ExplorationStore` interface; the account-backed store slots in next release with a migration of what the browser holds (decided 2026-11-02) |
| Where it lives | A console-level page, `/explore`, like Search: explorations are the person's, not a domain's, and a statement may join domains. The sidebar shows it under *All domains* and inside a domain; inside a domain the Tables rail opens on that domain |
| What it shares with a table's Data tab | One **workbench** component, extracted from `DataTab.tsx`, with two hosts: the table page (a fixed table, the view in the address bar) and an exploration (any table, the view in the exploration). What differs between the hosts is a scope object and a host interface (§6.1), so each can evolve without forking the other |
| Running a query not tied to a materialization | A console-level `POST /api/runs`, resolving every table a request names in its own domain. The per-materialization route stays as an alias (§7.1) |
| Permissions | No new permission. Explore is reachable by anyone holding `data.query` on at least one dataset in some domain; every table is checked on its dataset, in its domain, on every request, as today (§8) |
| Names | SQL names tables `<domain>.<dataset>.<table>`, always with the domain (handbook 20 §20.9); the Tables rail and the chooser show the same names |
| Phone | Explore is for the desktop. On a phone it opens an exploration's answer and its filters; the Tables rail, History and the editor are sheets; the bottom bar keeps its four places |
| Compatibility | Additive: the Data tab keeps its behaviour and address bar; the run API's existing routes keep their shapes; `RunSnapshot` gains a phase and two nullable fields (§7.4) |

## 2. Terms

| Term | Meaning |
| --- | --- |
| Explore | The page: `/explore`. Its question is *what does the data say?* |
| Exploration | One worksheet: a source table or none, a view (time range, order, filters, or a statement), the answer on screen, and its history. The document a later release saves and shares. Identified by a client-made UUID |
| Question | One press of Run — a run (console 07 §07.5), as the person sees it in the history. The server's unit is unchanged: a run |
| Source | The table an exploration is about: what it browses, and what a statement started from. `null` for a statement over the lake with no table chosen |
| Table reference (`TableRef`) | `{ domain, dataset, table }`: how a request names a table, wherever it is |
| Workbench | The component both hosts render: the composer (toolbar), status line, grid, pager, column rail, row properties, SQL panel, streaming |
| Host | What a workbench renders in: the table page's Data tab, or an exploration on the Explore page |
| Tables rail | The Explore page's navigator: domains, datasets, tables and their columns, searchable |
| History | An exploration's questions, newest first, in a column beside the answer |
| The lake | Every materialization's tables, in every domain (AGENTS.md) |

## 3. What exists today, and what Explore needs of it

| Today | Where | Explore needs |
| --- | --- | --- |
| A table's Data tab: one way to ask — range, filters or SQL, Run — the opening view from the manifests, pages read ahead, exact counts, streaming, the waterline, row properties, exports | `console/src/features/data/DataTab.tsx` (1,129 lines, owning every piece of state) and its parts; console 11 §11.8 | The same behaviour over any table: the state machine extracted into one component with two hosts (§6.1) |
| Runs: the only unit of query work; pinned to a snapshot per table; the tail per table from its own domain; admission `CONSOLE_RUN_CONCURRENCY` | `console/server/runs/` (console 07 §07.5) | Unchanged engine; a way to start a run from a table reference or a statement alone (§6.2) |
| Statements already name tables across domains, each resolved in its domain through that domain's fleet, the caller resolved there, `data.query` checked per dataset per domain | `server/routes/data.ts::resolveStatement`, `server/runs/names.ts` (handbook 20 §20.9) | The same resolver, lifted out of the per-materialization route and used for browse runs, validation and estimates too |
| A run belongs to its starter as its domain knows them; runs are addressed by id at `/api/runs/*` | `routes/data.ts::ownerIn`, `runs/store.ts::getRun` | Unchanged; a run naming no table belongs to the person in the settings home (§6.2) |
| Tabs keep their place: each opened tab mounted and hidden, paused while hidden | `components/TabPanel.tsx` (PR #28; console 09 §9.6) | Each open exploration is a kept tab |
| The merged fleet, live, across domains; each domain's datasets as the person; search over both | `lib/fleet.ts::useFleet`, `features/datasets/useDatasets.ts`, `routes/search.ts` | The Tables rail is built from these; no new read path (§6.3) |
| Permissions per dataset, checked in the route and again by the control plane; `useCan`, `forDomain().can()` | `auth/guard.ts`, `shared/access.ts`, `lib/auth.tsx` (console 12) | Unchanged rules on every new route and control (§8) |
| The design language's Query screen and *Query thread* pattern | console 10 §10.5, §10.10 | Explore is that screen; the thread becomes the exploration's History (§10) |

## 4. The screen

### 4.1 The question, and what leads

Explore answers *what does the data say?* An exploration leads with the answer to the question it
asked — the rows, with their exact count on the status line — under the composer that asked it,
exactly as a table's Data tab does. Everything else stands aside: the tables to choose from in a rail
on the left, the questions asked before in a column on the right, both closable.

### 4.2 Layout (desktop, ≥ 768 px)

```
┌ sidebar ┬──────────────────────────────────────────────────────────────────────────────┐
│ Overview│ Explore                                                                      │
│ Materia…│ ┌ sales.orders · Last 7 days ×┐┌ payments by status ×┐┌ New exploration ×┐ +  ⌄│
│ Datasets│ ├──────────┬────────────────────────────────────────────────────┬────────────┤
│ Explore │ │ Tables   │ From ▾ domain_a.sales.orders  Columns  Last 7 days ▾  Newest ▾ │ History    │
│         │ │ 🔍 /     │ status = cancelled ×  + Filter        〰 Streaming  SQL  Run  ⋮ │ ● now      │
│ pinned… │ │ ▾ Domain A│ ✓ 1,204,331 rows · Last 7 days                                 │   orders · │
│         │ │   ▾ sales │ ┌────────────────────────────────────────────────────────────┐ │   7 days   │
│ Settings│ │     orders│ │ #  _kafka_timestamp   order_id  status   customer.email …  │ │ ○ 2 min ago│
│ account │ │     ▸ cols│ │ 1  2026-11-02 14:41…  O-9981   cancelled  a…@example.com   │ │   SELECT … │
│         │ │   ▸ finance│ │ ── Committed 2:41:12 PM ──────────────────────────────────  │ │ ○ 9 min ago│
│         │ │ ▸ Domain B│ │ 2  …                                                       │ │   orders · │
│         │ │           │ └────────────────────────────────────────────────────────────┘ │   All time │
│         │ │           │ ‹ 1 2 3 … 12,044 ›  100 rows                                   │            │
└─────────┴─┴──────────┴────────────────────────────────────────────────────┴────────────┘
```

| Region | What it is |
| --- | --- |
| Header | The page title, **Explore**, and the open explorations as a tab strip under it (`role="tablist"`, like a table page's tabs): each tab its title and a close ×, then **+** (new) and **⌄** (every exploration kept in this browser, recent first, to open or delete). Tabs scroll sideways when they overflow; the shown one is underlined in ink |
| Tables rail | The navigator (§4.3): a search box, then domains › datasets › tables › columns. Closable (**Tables** in the toolbar, like **Columns**), resizable (264–480 px), remembered per browser (`console.explore.tablesOpen`, `console.explore.tablesWidth`). Open by default |
| Composer | The workbench's toolbar (console 11 §11.8 *Toolbar*), with one addition at its left in this host: **From ▾**, the source chooser (§4.4). In SQL mode the chooser reads the statement's tables instead and is not a control |
| Answer | The status line, the grid with the waterline, the pager, the column rail and the row properties column: console 11 §11.8, unchanged |
| History | The exploration's questions (§4.6), a right column like the properties column (console 10 §10.10), toggled by **History** in the toolbar's ⋮; a row opened in the grid takes its place while the row is open and gives it back on close |

Width: the page uses the full content width (no 1,400 px cap: rows are the scarce resource, as the
Data tab already argues by collapsing the sidebar). The workbench panel keeps its
`calc(100dvh - …)` height so the grid, not the page, scrolls.

### 4.3 The Tables rail

Domains, in the registry's order; under each, its datasets by name (locked ones too, with a lock:
names are not secret, console 11 §11.11); under each dataset, its tables by name with the state
glyph of the materialization writing it (`itemStatus`, console 10 §10.6) or **Kept** for a retired
table; under a table, on expand, its columns by logical name with their types, the metadata columns
folded under *Kafka metadata*, a shield on a masked column.

| Element | Behaviour |
| --- | --- |
| Search | A box heading the rail, focused with `/` (the page claims `FOCUS_SEARCH_EVENT`, as Settings does; ⌘K stays the command menu's). Matches datasets and tables by name and `<domain>.<dataset>.<table>`, ranked as the field search ranks (`fieldSearch.ts`: exact, prefix, segment, substring), matches emphasised; the tree shows only matching branches while a query is typed. ↑ ↓ move, ↵ acts on the row, Esc clears |
| A dataset row | Its name, its description in a tooltip, how many tables; a lock when locked to the person, its tooltip saying whom to ask (the Datasets page's words). Expanded by default for the domain the page was opened in (`useScopeDomainId`), and for a dataset holding the shown exploration's source |
| A table row | `dataset.table` (the dataset quieter, as the table page's title), the state glyph, its topic in a tooltip. **Click** (or ↵): in browse mode, browse it in the shown exploration — its question goes to History first, so nothing is lost; in SQL mode, insert its full name at the cursor. **On hover / ⋯**: *Browse in a new exploration*, *Insert name* (SQL mode), *Copy name*, *Open table page*. A locked table's click explains and offers nothing |
| A table's columns | Loaded on expand through the table's schema (`GET …/tables/:table/schema`, `dataset.view_schema`), cached per domain client. Click inserts the quoted column name at the cursor in SQL mode; in browse mode, opens the filter builder on that field |
| A domain row | Its name, its dot only when it needs saying (unreachable, not usable: `DomainDot`); unreachable, its tables stay from the last snapshot, the row's tooltip saying so; `sign_in_required` or `forbidden` offers **Sign in** where that would help, as the Datasets page does |
| Empty | No table anywhere the person may query: *Nothing to explore yet. Ask a dataset's owner for a role on it*, with **Datasets** |

The rail reads nothing new (§6.3): the merged fleet the shell already streams, and each domain's
datasets read as the person, kept 15 s (`useDatasets`). Columns are the only lazy read.

### 4.4 The composer's source: **From ▾**

A new exploration's toolbar begins **From ▾ Choose a table**. It opens a popover with the same ranked
search over every table the person may query, each with its domain chip when the console serves
several domains and its state glyph; choosing one sets the exploration's source and runs its opening
view at once — every committed row, newest first, with its exact count, from the manifests
(console 11 §11.8 *Opening the tab*), so the first answer is on screen at any table size. The control
then reads the source's full name, `domain_a.sales.orders`, in the code face.

The source decides what the rest of the toolbar is about: the time picker's figures are its
estimates; **Streaming** follows its tail; **Peek** peeks at its topic; the summary and the
waterline are its. Changing the source is a new question: the one on screen goes to History.

In SQL mode the statement names its tables. The control shows them (*domain_a.sales.orders,
domain_b.finance.payments*), read from the draft with the same name rules the server uses
(`namedTables`, moved to `shared/`), and is not a chooser; the time picker's figures sum the named
tables' estimates (*≤1.2M rows across 2 tables*, §7.3). A statement started from a table keeps that
table as the source for Streaming's sake, as the Data tab does (handbook 20 §20.9); a statement in
an exploration with no source has no streaming, no peek and no summary, and says so in the status
line's muted words only when asked (**Streaming** is simply absent).

### 4.5 Asking, and what happens

Everything in console 11 §11.8 holds, in every exploration: a small question runs as it is asked
(the auto-run rule over the source's estimate), a bigger one waits for Run and says what it would
read; a statement always waits; ⌘↵ runs the shown exploration's question only; Run cancels the
exploration's previous run if it is still working; Streaming refreshes every 1.5 s while the
exploration is shown, the page visible, the first page on screen and no row open; Auto re-run for a
statement; the waterline; **Peek**; **Export…** once a run has succeeded, for someone who may export
from every dataset it read, in each one's domain.

What Explore adds:

| Behaviour | Rule |
| --- | --- |
| Several explorations at once | Each open exploration is a kept tab (`TabPanel`): hidden, it streams nothing, reads nothing on a timer, takes no keys, and keeps following the run it started, so a long count finishes out of sight. Shown again, it catches up. At most **8 open** at once (§15); the 9th asks to close one |
| A person's runs | One run at a time per exploration (Run cancels its predecessor), several across explorations. The server admits at most `runConcurrencyPerPerson` (2) of one person's runs to the scanning phase at once (§6.2); a run waiting says **Waiting for your other queries** on its status line (phase `queued`) |
| The history | Every question asked is recorded in the exploration's history as Run is pressed, and its outcome when the run ends (§4.6) |
| The title | An exploration without a name takes one from its last question: `sales.orders · Last 7 days`, with `· 2 filters` when filtered, or a statement's first meaningful line cut to 40 characters; before any, **New exploration**. Double-clicking the tab, or ⋮ › **Rename**, names it for good |
| Closing | Closing a tab keeps the exploration in the browser (**⌄** reopens it); ⋮ › **Delete** removes it, acting at once with **Undo** in the toast (console 10 §10.10) |
| Share | ⋮ › **Share** copies a link that reopens the question for whoever may read its tables: `/explore/new?source=domain_a.sales.orders&t=-7d&f=…` (§5.4) — the Data tab's view in the query string, plus the source. The recipient gets a new exploration of their own |
| Open in Explore | A table page's ⋮ gains **Open in Explore**, which carries its Data tab's current view (and run) into a new exploration; ⌘K offers **Explore `<table>`** on a table result and **New exploration** as a place |

### 4.6 History

A column at the right (`.slide-in-right`, 300 px), **History** as its title, the exploration's
questions newest first. Each row: when (`RelativeTime`), a glyph for its kind (a table for browse, a
code mark for SQL), its label — the table and range (`sales.orders · Last 7 days · 2 filters`) or
the statement's first line in the code face — and its outcome: `1,204,331 rows · 2.1 s`,
**Failed** (the message in a tooltip), **Cancelled**, or nothing while it runs. The question on
screen carries an ink bar in the margin, as the open row of a grid does.

Clicking a row (↑ ↓ ↵ too) puts the question back in the composer — source, range as it was chosen
(*Last 7 days*, not the instants), filters or statement, order — and shows its answer: the run is
re-attached when it still exists, exactly as a reload re-attaches (console 11 §11.8 *Sharing and
refreshing*); when it has expired (runs idle 30 min are discarded) the composer shows the question
with Run ringed and the status line says **Changes not run yet**, so pressing Run asks it again.
Nothing is ever lost by clicking: the question that was on screen is itself in the history.

A history holds at most 50 questions; the oldest go first. It is the exploration's, kept in the
browser with it (§5), and is what a later release saves to the account: *the query thread* of the
redesign proposal, kept per exploration rather than per day (§10).

### 4.7 Empty states, loading, errors

| State | Shows |
| --- | --- |
| A new exploration | The composer with **From ▾ Choose a table**, and in place of the grid: *Pick a table to browse its rows, or write SQL over any tables you may read* with **Choose a table** and **Write SQL**. The Tables rail is open |
| The Data explorer off (`dataAccessEnabled: false`) | *The Data explorer is off*, with the setting's name; **Settings** for someone with `settings.manage` in the settings home |
| Nothing to explore (no `data.query` anywhere) | Not reached: the page needs it (§8); a guest is sent to sign in, a person told who could change that (`AccessDenied`) |
| A source whose domain cannot be reached | The status line: *Domain B cannot be reached right now, so domain_b.finance.payments cannot be read. Try again in a moment* (the server's `503 domain_unreachable`); the rail marks the domain |
| A source's table no longer readable to the person | The run is refused (`403`, naming the dataset with its domain); the status line says it needs *Query data* on `domain_b.finance`; the rail shows the lock |
| A run that expired while nobody looked | As the Data tab: the view runs again (`404 resource: run` on refresh) |
| The browser store full | The oldest closed explorations are removed to make room, said once in a toast: *Older explorations were removed to make room* |
| Loading | The workbench's skeletons; the rail's rows shimmer only on first load, never on a refresh |

### 4.8 Phone (< 768 px)

Explore is reached from search and links, not the bottom bar (its four places stay). An exploration
opens on its answer: a compact toolbar (From, the time range, Run, ⋮), the status line, the grid,
the pager; the Tables rail, History, the column list and the row's properties are sheets; the SQL
editor opens as a sheet too and works, but composing is the desktop's. The tab strip scrolls.

### 4.9 Keyboard

| Keys | Does |
| --- | --- |
| `⌘↵` / `Ctrl+↵` | Run the shown exploration's question (the editor handles its own and marks the event) |
| `/` | Focus the Tables rail's search (the page claims `FOCUS_SEARCH_EVENT`); ⌘K opens the command menu as everywhere |
| `↑` `↓` `↵` `Esc` in the rail and in History | Move, act, clear or close |
| `↑` `↓` `j` `k` `Esc` | A row's properties, as today |
| Tab strip | The ARIA tabs pattern: `←` `→` between explorations, `Delete`/`Backspace` closes the focused tab |

## 5. An exploration

### 5.1 The document

```ts
/** The saved form of an exploration: the format a store keeps and a later release moves to the account. */
interface Exploration {
  id: string;                       // UUID v4, made by the client; stable across stores
  version: 1;                       // the document's format, for migrations
  title: string | null;             // chosen by the person; null: derived by titleOf()
  createdAt: string; updatedAt: string;   // ISO-8601 UTC
  source: TableRef | null;          // { domain, dataset, table }
  view: ExplorationView;            // what the composer holds
  history: Question[];              // newest first, at most 50
  /** Ephemeral but saved, so a reload re-attaches: the run on screen and its page. */
  runId: string | null;
  page: number;
}

interface ExplorationView {
  range: TimeRangeSpec;             // as chosen: a preset, relative, or instants (timeRange.ts)
  filters: BrowseFilter[];
  order: RunOrder;
  sql: string | null;               // the statement, when the view is one
  pageSize: number;
  visibleColumns: string[] | null;
  pinnedColumn: string | null;
  live: boolean;                    // Streaming, on unless turned off
}

interface Question {
  id: string;                       // UUID
  askedAt: string;
  source: TableRef | null;
  request: StoredRequest;           // kind, range spec and its resolved instants and label, filters, order, sql
  runId: string | null;             // the run it started; expires server-side
  outcome: { state: 'succeeded' | 'failed' | 'cancelled'; rows: number | null; elapsedMs: number | null; message: string | null } | null;
}
```

`features/explore/explorations.ts` holds the model and its pure rules, without React, unit-tested:
`newExploration(source?, view?)`, `titleOf`, `recordQuestion` (capping the history), `settle`
(the outcome from a `RunSnapshot`), `fromShareLink`/`toShareLink` (§5.4), `migrate(document)` by
`version`. The document holds **no data**: names, a range, filters and statements — a bookmark, as the
address bar is today. A statement's literals are the person's own text and stay in their browser.

### 5.2 The store

```ts
interface ExplorationStore {
  list(): ExplorationSummary[];                    // id, title, updatedAt, source — for the ⌄ menu
  load(id: string): Exploration | null;
  save(exploration: Exploration): void;            // whole document; the caller debounces view edits
  remove(id: string): void;
  subscribe(listener: () => void): () => void;     // another tab changed something
}
```

**This release: `BrowserExplorationStore`.** `localStorage['console.explore.v1']` holds every
exploration by id; the `storage` event notifies other tabs (as `lib/pins.ts` does); every read and
write is wrapped in `try`/`catch`, so a browser that blocks storage gets working explorations for
the page's life, just not remembered ones. Quota: at most **100 explorations**; past that, or on a
`QuotaExceededError`, the oldest closed ones go, said once (§4.7). Which explorations are **open**,
and which is **shown**, are this browser tab's own (`sessionStorage['console.explore.tabs']`): two
browser tabs share the documents but not their tab strips, so closing a tab in one never closes it
in the other. A reload restores the strip; a new browser tab opens on the most recently updated
exploration, or a new one.

The hook `useExplorations()` (`useSyncExternalStore` over the store) gives the page its open
explorations, and `useExploration(id)` one document with `update(patch)`: view edits saved 300 ms
after the last keystroke, a question or a title at once.

**Next release: `AccountExplorationStore`** (§6.6): the same interface over
`GET`/`PUT`/`DELETE /api/explorations[/:id]`, which the console passes to the settings home's control
plane, where a new table keeps each person's explorations (handbook 15 §15.9's `user:<id>` idea,
as its own record kind, written through an intake agent as settings and the directory are). The
document's `version` and ids are kept; the browser store becomes the offline draft, and a one-time
banner offers to move what the browser holds.

### 5.3 Its life

| Event | What happens |
| --- | --- |
| **+**, ⌘K › New exploration, `/explore` with no exploration open | A new document (no source, the default view); the tab strip shows **New exploration**, shown; the rail is open |
| A table chosen, a table clicked in the rail | `source` set; the opening view runs; the question recorded |
| Run | The question recorded as asked (the composer's view, the range resolved), `runId` kept; the outcome written when the run ends; the title derived if unnamed |
| A view edit | Saved, debounced; the exploration's `updatedAt` moves |
| A history row opened | The composer takes the question; `runId` attached if alive |
| Close (×) | Leaves the strip; stays in the store |
| ⌄ › Open | Joins the strip (the 9th asks to close one) |
| ⋮ › Delete | Removed from the store, at once; the toast's **Undo** puts it back for 10 s |
| Reload, or `/explore/<id>` | The strip restored from the tab's session; the shown exploration re-attaches to its `runId` when the run still exists, else runs its view again — unless it has no source and no statement |
| Sign-out everywhere | Nothing: the documents are the browser's, as pins are. A shared computer is the person's to clear (⌄ › **Delete** each, or the browser's site data); the account store changes this (§6.6) |

### 5.4 Share links

A link reopens a question for whoever may read its tables, with no server storage: the Data tab's
view in the query string (`viewState.ts`), plus the source as a full name.

```
/explore/new?source=domain_a.sales.orders&t=-7d&f=[{"column":"status","operator":"eq","value":"cancelled"}]&order=newest&run=0d9e…
/explore/new?sql=SELECT+…&t=-30d
```

Opening it makes a new exploration for the opener, named as the question is, and runs it (the `run`
is attached only for the person who started it, as today; anyone else runs the question anew). A
link from a table page's **Open in Explore** is the same link. When the account store arrives,
`/explore/<id>` becomes shareable for an exploration its owner shared; `new?…` links keep working.

## 6. Architecture

### 6.1 One workbench, two hosts

`DataTab.tsx` becomes two things: `features/data/Workbench.tsx`, the component, and
`features/data/DataTab.tsx`, a thin host of it on the table page. Explore adds the second host,
`features/explore/Exploration.tsx`.

```
                       ┌──────────────────────────────┐          ┌──────────────────────────────┐
                       │ DataTab (a table's page)     │          │ Exploration (Explore)        │
  the host:            │ scope: table, fixed source   │          │ scope: lake, source chosen   │
  where the view       │ view ⇄ the address bar       │          │ view ⇄ the exploration doc   │
  lives, what it adds  │ detail: the page's stream    │          │ detail: its own stream        │
                       │ share: the address           │          │ share: /explore/new?…         │
                       └──────────────┬───────────────┘          │ + From ▾, History, onQuestion│
                                      │                          └──────────────┬───────────────┘
                                      ▼                                         ▼
                       ┌────────────────────────────────────────────────────────────────────────┐
  the workbench:       │ Workbench({ scope, view, onView, detail, onQuestion?, leading? })        │
  everything console   │ useWorkbench (range, filters, order, statement, page, columns, the run,  │
  11 §11.8 describes   │ auto-run, validation) · useStreaming (liveHold, refresh, auto re-run)   │
                       │ toolbar · StatusBar · ColumnRail · FilterChips · TimeRangePicker ·      │
                       │ SqlPanel/QueryEditor · DataGrid · Pager · RowProperties · HeadPeek ·    │
                       │ MoreActions/ExportOptions · live.ts · autoRun.ts · columns.ts           │
                       └──────────────┬─────────────────────────────────────────────────────────┘
                                      │ api.startRun(request)  ·  api.run/rows/refresh/cancel/profile/export
                                      ▼
                       ┌────────────────────────────────────────────────────────────────────────┐
  the server:          │ POST /api/runs → resolveTableRefs → requireOnDatasets per domain →      │
                       │ startRun (catalogs per table, tails per domain) → RunSnapshot, SSE      │
                       └────────────────────────────────────────────────────────────────────────┘
```

```ts
/** What the workbench is over, and what its host allows. */
interface WorkbenchScope {
  kind: 'table' | 'lake';
  /** The table the view is of, with where it is; null for a statement with no table chosen. */
  source: TableSource | null;   // TableRef + datasetId + materializationId
  /** Lake scope: let the person choose another source (the From control); absent on a table's page. */
  onChooseSource?: (source: TableSource | null) => void;
  /** Tables a statement may name, for completion: the lake (every table the person may query) or the materialization's own plus names. */
  completions: TableCompletions;
}

/** The view, without the source: what both hosts keep, each in its own place. */
type WorkbenchView = ExplorationView & { page: number; runId: string | null };

interface WorkbenchProps {
  scope: WorkbenchScope;
  view: WorkbenchView;
  onView: (next: WorkbenchView) => void;          // every change; the host decides where it goes
  /** The source's materialization, live, for schemas, the created tables, topic lag and the tail switch; null without a source. */
  detail: DetailSnapshot | null;
  /** Explore: each question as it is asked and as it ends. */
  onQuestion?: (event: { kind: 'asked'; question: Question } | { kind: 'ended'; runId: string; run: RunSnapshot }) => void;
  /** Explore: the From control, at the toolbar's left. */
  leading?: ReactNode;
  /** Explore: what ⋮ › Share copies. */
  shareLink?: () => string;
  /** Table page: Open in Explore. */
  exploreLink?: string;
}
```

| Concern | Table page (`DataTab`) | Exploration |
| --- | --- | --- |
| The source | The page's table, fixed; the host passes `scope.source` from the dataset's entry and the detail | The document's `source`; **From ▾** and the rail set it |
| Where the view lives | The address bar, mirrored while shown (`viewState.ts`, as today) | The exploration document (`useExploration().update`), debounced; the address bar names only the exploration |
| The materialization's stream | The page's `useDetailStream`, passed down | The exploration's own `useDetailStream(source.materializationId)`, null without a source |
| The domain's API (`useApi`) | The page's `DomainScope` | The exploration wraps the workbench in `DomainProvider` for the source's domain; without a source, the settings home's |
| Starting runs | `api.startRun({ ...request, source: ref })` — the console-level route (§7.1) | the same |
| Completion | The materialization's tables with their columns, every other table by name (as today) | Every table the person may query, by name; columns of the tables the rail has loaded or the exploration has browsed |
| Share | The address (as today) | `toShareLink(exploration)` |
| ⋮ | Peek, Share, Export…, **Open in Explore** | Peek, Share, Export…, History, Rename, Delete |
| Empty before a source | Never: the page has a table | *Pick a table…* (§4.7) |
| Keys | Gated by `useTabShown()` (the page's tabs) | Gated by `useTabShown()` (the explorations' tabs) |

Moving the state machine out of `DataTab` is a refactor with no behaviour change on the table page;
the continuity probes of PR #28 (console 13 §13.8n) are the regression check. Hooks the workbench
gains, each tested without React where it can be (`hooks.test.ts`, `live.test.ts`, `autoRun.test.ts`
as today): `useWorkbench` (the view state, `viewKey`, dirtiness, execute, validation, auto-run,
columns, the opening run and re-attach), `useStreaming` (the Live timers and Auto re-run, from
`DataTab` lines 539–578 today).

`useRun` loses its `materializationId` argument: it starts runs through the console's API and
attaches any run the person owns; the host decides whether a re-attached run is about its source
(`run.tables` names each table's domain, dataset and materialization).

### 6.2 Runs not tied to a materialization

Today a run starts at `POST /api/d/<domain>/materializations/:id/runs`: `materializationTables`
lists the materialization's tables, `pickTable` picks the one the request names, and
`resolveStatement` finds the tables a statement names, each in its domain (`routes/data.ts`). The
change lifts the resolver out of the route and lets a request name its table directly.

| Piece | Change |
| --- | --- |
| `resolveTableRefs(request, refs)` (`routes/data.ts`, from `resolveStatement`) | Each `TableRef` → its domain (`domains().require`), `503 domain_unreachable` when unreachable; the materialization in that domain's live fleet whose tables include `<dataset>.<table>`, else `400` listing what the dataset holds; `materializationTables` for its location; `authInResolving(request, domain)` so the caller is known there; `tailAccess` for its tail through that domain's tail app. `resolveStatement` becomes `namedTables(sql) → resolveTableRefs`. The unqualified-name check runs over every served domain's fleet and names the fix for each domain holding the table (*write domain_a.sales.orders or domain_b.sales.orders for sales.orders*) |
| `POST /api/runs` (§7.1) | `permitInSomeDomain('data.query')`; body validated; a browse run's `source` resolved; a statement's named tables resolved, its `source` too when given; `requireOnRunDatasets(request, 'data.query', …)` for every table in its domain; `startRun` |
| `startRun` (`runs/store.ts`) | Takes `primary: ResolvedTable | null` instead of the materialization's `tables` + a name: a browse run's table, or a statement's source when given, else the first table it names, else none. The per-materialization route computes `primary` with `pickTable` as before. `tableNames` for error messages: the names a statement named, plus the primary's |
| A run with no table | A statement naming no table (`SELECT 1`, `SELECT now()`) gets an empty catalog (`data/catalog.ts::emptyCatalog()`: no snapshot, no schema, no objects, `loadedAt` now), `domain` = the settings home, `materializationId: null`, `tableName: null`, `datasets: []`; `StatementRun` already runs with no sources. Its owner is `ownerIn(request, home)`, so `getRun` finds it for the same person |
| `Run`, `RunSnapshot` | `materializationId` and `table` become nullable; `snapshot()` reads them from the catalog as today. `tableReads()` for a browse run uses the primary's place |
| `refreshRun` | Re-resolves the run's primary by reference (kept on the run as `source`) and a statement's tables as today, so a replacement reads them as they are now |
| Admission per person | `admit(signal, ownerId)`: at most `config.runConcurrencyPerPerson` of one owner's runs scanning at once, queued FIFO behind the global `runConcurrency`; a queued run reports `phase: 'queued'` so the status line can say so. The console setting **Scans per person** (`CONSOLE_RUN_CONCURRENCY_PER_PERSON`, default 2, 0 for no limit, at most `runConcurrency`), Settings › Data explorer, through the adding-settings checklist |
| Validation and estimates | `POST /api/data/validate` and `POST /api/data/estimate` at console level (§7.2, §7.3), the per-materialization ones delegating |

Nothing in the engine beneath `startRun` changes: catalogs per table at their current snapshot,
tails per table from each domain's tail app with the person's session there, the sandbox allowed
exactly the run's files and the secrets of the profiles that serve them, results as local Parquet,
pages by position, admission, retention (console 07, handbook 20 §20.9).

### 6.3 The Tables rail's data

No new endpoint. `features/explore/useLake.ts` composes, in the browser:

| From | Gives | Access |
| --- | --- | --- |
| `useFleet()` — every domain's fleet, merged, live (`lib/fleet.ts`) | Each materialization's `tables` (`dataset.table`, kept ones included), its state (`itemStatus`), its topics; each domain's `access` (`ok`, `sign_in_required`, `forbidden`, `unavailable`) | `materializations.view` in the domain |
| `useDatasets()` per domain, inside a `DomainProvider` (as the all-domains Datasets page does) | Each dataset's name, description, `locked`, the person's `permissions` on it, its table names, its owners | `datasets.view` in the domain |
| `domainApi.schema(materializationId, table)` on expand | A table's columns, as the Schema tab names them | `dataset.view_schema` on the dataset |

The tree: a dataset node per dataset the domain lists; a table node per name the fleet or the
dataset names (a kept table has no running materialization but is in the dataset); per table,
`queryable = forDomain(domain).can('data.query', datasetId)`. A domain the person may not see lists
nothing, with the reason and **Sign in** where it helps. The composition is a pure function,
`lakeTree(fleet, datasetsByDomain, auth)`, unit-tested; the hook only wires the reads. Search over
it reuses `lib/nameSearch.ts`.

### 6.4 Client modules and state

```
src/features/data/                         The workbench (was: the Data tab and its parts)
  Workbench.tsx                            The composer, status line, rails, grid, pager, row properties: one question at a time
  useWorkbench.ts                          Its state machine: the view, dirtiness, execute, validation, auto-run, columns, re-attach
  useStreaming.ts                          Live's timers and Auto re-run (from DataTab)
  scope.ts                                 WorkbenchScope, TableSource, TableCompletions; what each scope allows (no React; tested)
  viewState.ts                             + `source` as a full name, for Explore's links
  DataTab.tsx                              The table page's host: the view in the address bar
  … ColumnRail, FilterChips, TimeRangePicker, SqlPanel, QueryEditor, StatusBar, Pager, RowProperties,
    HeadPeek, MoreActions, ExportOptions, ResizeHandle, live.ts, autoRun.ts, columns.ts, timeRange.ts,
    fieldSearch.ts, jsonShape.ts, useRun.ts — unchanged in role
src/features/explore/
  ExplorePage.tsx                          Header, the tab strip, the Tables rail, each open exploration in a TabPanel
  ExplorationTabs.tsx                      The strip: titles, close, new, the ⌄ menu; the ARIA tabs pattern
  Exploration.tsx                          One exploration: DomainProvider for its source, its detail stream, the Workbench, History
  TablesRail.tsx                           Domains › datasets › tables › columns, with search; row actions
  TableChooser.tsx                         From ▾: the same search in a popover
  HistoryColumn.tsx                        The exploration's questions
  useLake.ts / lake.ts                     The tree from the fleet and each domain's datasets (lake.ts: no React; tested)
  explorations.ts                          The document, titles, questions, limits, share links, migrations (no React; tested)
  store.ts                                 ExplorationStore, BrowserExplorationStore (tested with a fake storage)
  useExplorations.ts                       The store as React state; the tab strip's session state; autosave
shared/
  statementNames.ts                        namedTables, unqualifiedReferences, canonicalName, nativeCatalog (from server/runs/names.ts),
                                           with stripStringsAndComments: the client reads a draft's tables with the server's rules
```

| State | Owner | Persistence |
| --- | --- | --- |
| Every exploration (document) | `BrowserExplorationStore` | `localStorage['console.explore.v1']`; cross-tab through `storage` |
| Which explorations are open, which is shown | `useExplorations` | `sessionStorage['console.explore.tabs']`: this browser tab's |
| An exploration's view, source, history, run id, page | The document, through `useExploration(id).update` | With the document |
| The run on screen, its pages, streaming | The workbench instance in its `TabPanel` | Kept while the exploration is open; the run itself lives on the server until idle 30 min |
| The Tables rail: open, width, expanded nodes, the query | `ExplorePage` | `localStorage['console.explore.tablesOpen'`/`tablesWidth']`; expanded nodes and the query for the page's life |
| Column rail width and open, SQL height, JSON layout | The workbench | The Data tab's keys, shared by both hosts |
| Table schemas for the rail and completion | TanStack Query per domain client (`['schema', id, table]`) | In memory, 5 min |

### 6.5 Routing and the shell

| Where | Change |
| --- | --- |
| `App.tsx` | `/explore`, `/explore/new`, `/explore/:explorationId` → `ExplorePage`, inside `RequireDatasetPermission permission="data.query"` (below) |
| `lib/paths.ts` | `ShellSection` gains `'explore'`; `sectionOf` maps `/explore…`; `sectionPath('explore', domain)` is `/explore` for every scope, as search is |
| `AppShell.tsx` | `NAV_ITEMS` gains **Explore** (icon: `Compass`), between Datasets and the pins, shown when `consoleAuth.overall.canAnywhere('data.query')`; inside a domain the same test across the console, since explorations span domains. Not in the phone's bottom bar |
| `CommandMenu.tsx` | Places: **Explore**, **New exploration**; on a table result, the action **Explore `<domain>.<dataset>.<table>`** (needs `data.query` on its dataset in its domain) |
| `features/auth/AccessGate.tsx` | `RequireDatasetPermission`: like `RequirePermission` with `canAnywhere`, across every domain for a console page; a guest goes to `/sign-in`, a person without it sees *You do not have access to exploring data* |
| A table page's Data tab | ⋮ › **Open in Explore** → `toShareLink` of its view with the page's table as the source |

### 6.6 Persistence, now and next

```
  now                                            next release
  ┌──────────────┐  save/load   ┌──────────────┐  ┌──────────────┐  GET/PUT   ┌───────────────┐  intake   ┌──────────────────┐
  │ Exploration  │ ───────────► │ Browser store│  │ Account store│ ─────────► │ /api/explor-  │ ────────► │ settings home:   │
  │ (document)   │ ◄─────────── │ localStorage │  │ (same iface) │ ◄───────── │ ations[/:id]  │ ◄──────── │ explorations tbl │
  └──────────────┘              └──────────────┘  └──────────────┘            └───────────────┘           └──────────────────┘
        ▲ the same document, by id and version; a one-time move from the browser store
```

The account store is a control-plane change in the settings home (the domain that stores the
console's own settings, handbook 20 §20.1): a WebView authorizing its caller (`signedIn`), an
`explorations-requests` topic and intake agent writing an `explorations` table keyed by the
person's id — the shape settings and the directory already take (handbook 17, 18) — never a
WebView writing a table directly. Sharing follows the dataset Share popover: an exploration carries
`sharedWith: [{ principal, role: 'viewer' | 'editor' }]`, `/explore/<id>` opens for them, and every
run they start is still checked on each table's dataset in its domain: sharing an exploration never
shares data. Both are out of this release's scope; this release's document shape, ids, versioning
and store interface are what make them a drop-in.

## 7. Contracts

### 7.1 `POST /api/runs`

Start a run from a table reference or a statement alone. Console-level (handbook 20 §20.5).
`201` with a `RunSnapshot`; progress on `GET /api/stream/runs/:runId` as today.

```json
{ "kind": "browse",
  "source": { "domain": "domain_a", "dataset": "sales", "table": "orders" },
  "range": { "from": 1759100000000, "to": null }, "rangeLabel": "Last 7 days",
  "filters": [{ "column": "status", "operator": "eq", "value": "cancelled" }],
  "order": "newest", "liveTail": true }
```

```json
{ "kind": "sql",
  "sql": "SELECT o.status, count(*) FROM domain_a.sales.orders o JOIN domain_b.finance.payments p ON p.order_id = o.order_id GROUP BY 1",
  "range": { "from": null, "to": null }, "rangeLabel": "All time",
  "source": null }
```

| Field | Rules |
| --- | --- |
| `source` | A `TableRef`: `domain` as `shared/tableNames.ts::domainIdProblem` allows, `dataset` as `datasetNameProblem`, `table` as a table name; required for `browse`; optional for `sql` (the table the run is about: `asOf`, its tail, the status line's commit). A domain the console does not serve is `404 unknown_domain`; one it cannot reach `503 domain_unreachable`; a table no materialization there has `400` listing the dataset's tables |
| `range`, `rangeLabel`, `filters`, `order`, `sql`, `asOf`, `liveTail` | As `POST …/materializations/:id/runs` (console 08 §8.16) |
| Permission | `data.query` on every table's dataset, each in its domain, after `permitInSomeDomain('data.query')`; a refusal names `<domain>.<dataset>` (`details.domain`, `details.dataset`, `details.permission`) |
| A statement naming no table | Allowed: a run with `tables: []`, `table: null`, `materializationId: null`, `domain` the settings home |

`POST /api/d/<domain>/materializations/:id/runs` stays, answering as before: its `table` (a name)
becomes `source` with the materialization's domain and the table's dataset. The console's clients
use `/api/runs`.

### 7.2 `POST /api/data/validate`

`{ "sql": "…" }` → `{ "ok": true }`, or `400 query_failed` with `details.position` as today; the
statement's tables resolved across domains, `data.query` on each; a name without its domain refused
with the fix per domain that holds it. The per-materialization route delegates.

### 7.3 `POST /api/data/estimate`

`{ "tables": [TableRef, …], "ranges": [{ from, to }, …] }` (1–8 tables, 1–32 ranges) →
`{ "asOf", "estimates": ScopeEstimate[] }`, each range's `objects`, `bytes` and `rows` summed over
the tables, `rowsExact` only when every table's is; `data.query` on each table's dataset. The time
picker uses it with one table (the source) or a statement's named tables.

### 7.4 `RunSnapshot`, `RunRequest`, settings, config

| Where | Change |
| --- | --- |
| `RunRequest` | `source?: TableRef \| null`, echoed back; `table` stays (the name, filled from `source`) |
| `RunSnapshot` | `materializationId: string \| null`, `table: string \| null` (null for a statement naming no table); `phase` gains `queued`. Everything else unchanged; `tables[]` already names each table's domain, dataset and materialization |
| `RunPhase` | `'planning' \| 'queued' \| 'preparing' \| 'scanning' \| 'counting' \| 'done'` |
| Settings › Data explorer | **Scans per person**, `runConcurrencyPerPerson` ← `CONSOLE_RUN_CONCURRENCY_PER_PERSON` (default 2, 0–`runConcurrency`); `effect`: *the next run someone starts* |
| `GET /api/config` | Nothing new: `dataAccessEnabled`, the row limits and `autoRunMaxBytes` already serve Explore |
| Errors | Existing codes: `unknown_domain`, `domain_unreachable`, `storage_not_configured`, `query_failed`, `forbidden`/`unauthenticated` with `details.dataset`; `invalid_request` for a malformed `source` naming the field |

## 8. Permissions and security

| Surface | Rule | Where enforced |
| --- | --- | --- |
| The page | `data.query` held on at least one dataset in some domain; a guest is sent to sign in; a person without it is told who could change that | `RequireDatasetPermission` (UI), and every route beneath |
| The sidebar item, ⌘K places | The same test; hidden otherwise — a courtesy, never a control | `AppShell`, `CommandMenu` |
| The Tables rail | Datasets of domains where `datasets.view`; tables' states where `materializations.view`; locked datasets shown with a lock and no action; columns only with `dataset.view_schema` (the schema route refuses otherwise); browse and insert only where `data.query` on the dataset | The client from the session; the routes it reads from check again (console 12 §12.2) |
| `POST /api/runs`, `/api/data/validate`, `/api/data/estimate` | `permitInSomeDomain('data.query')`, then `requireOnDatasets` on every table named, each in its own domain, with the caller resolved there (`authInResolving`); a refusal names the dataset with its domain | `routes/data.ts` |
| A run's rows, stream, profile, refresh | As today: the owner only (`getRun`, `404` for anyone else), `data.query` on every dataset it read, re-checked on every request; streams re-check every 30 s | `ownRun`, `watchAccess` |
| Export | `data.export` on every dataset the run read, in each domain | `ownRun(request, 'data.export')` |
| Live tail | Each table's tail asked of its own domain's tail app with the person's session there, which checks `data.query` itself (handbook 19 §19.10) | `tailAccess` per resolved table |
| Statements | The sandbox: only the run's files and the secrets of the profiles serving them; the guard; the limits (console 12 §12.4); hashed columns join across domains only with the same protection key (handbook 20 §20.9, said in the editor's help) | Unchanged |
| The browser store | Holds names, ranges, filters and statements — never rows. Kept like pins, per browser profile; a shared computer keeps them until deleted. No secret is stored (console 12 §12.9) | Client |
| Share links | Carry the question, not the answer: the opener runs it under their own access; a `run` id in the link attaches only for its owner | Server |
| Cross-domain joins | Each domain checks its own tables; a domain the person is a guest in refuses with `401` naming `<domain>.<dataset>`; nothing one domain answers is shown as another's (query clients per domain) | Unchanged (handbook 20) |

Threats Explore adds: none new in kind. More runs per person is the one new load (admission per
person); the browser store is a new place a statement's text lives, which is the address bar's
situation today.

## 9. Performance

The Data tab's criteria hold for every exploration, because the engine and the component are the
same:

| Criterion | How Explore keeps it |
| --- | --- |
| The opening view at once, at any size | Choosing a source runs the manifests-only view: no read but the first page |
| Pages at once; the next read ahead; page 40,000 as cheap as page 1 | `useRunPage`, unchanged |
| Exact counts and progress | Unchanged |
| Streaming at 1.5 s without flicker | Only the shown exploration streams (`useTabShown`, `liveHold visible`); the carried run, keyed rows and `row-arrive` as today |
| A statement bounded by the range; the sandbox | Unchanged |
| Cold scans overlapped (48 files), footers warmed | Unchanged |
| The grid virtualized; CodeMirror lazy | Unchanged; one editor instance per open exploration in SQL mode |

What Explore adds, and its budget:

| Cost | Bound |
| --- | --- |
| Several explorations' runs | One at a time per exploration; `runConcurrencyPerPerson` (2) scanning at once per person, within the global 4; the rest queued and said so |
| Kept explorations in the DOM | At most 8 open; hidden ones are not painted (`content-visibility: hidden`) and do not re-render for the page's updates (`TabPanel` memo) |
| The Tables rail | Built from data the page already holds (the fleet stream, datasets 15 s per domain); columns on expand only; datasets collapsed by default but the scope's. Plain DOM; virtualized if a deployment lists thousands of tables (a measured decision, console 16) |
| The time picker's figures | One estimate per table per range set, cached 30 s (`['scope-estimate', ref, rangeLabel, asOf]`); a statement's summed over at most 8 named tables |
| Each exploration's detail stream | One `useDetailStream` per shown exploration with a source: the store's 1.5 s detail cadence for that materialization, as a table page costs; a hidden exploration's stream stays open but its page does nothing with the frames (as a hidden Data tab today) |
| The browser store | Writes debounced 300 ms; documents under ~2 KB each without history, ~50 KB with a full one; 100 documents fit a 5 MB quota with room |

Measured targets (the Data tab's, console 07 §07.6, on a test cluster): the opening view's first
page under 200 ms warm; a filter's first page in about a second cold; a record produced seen within
about a second with Streaming. Explore reports the same figures in its validation (§12.3).

## 10. Design language

Following console 10 and the `console-design` skill; the document is updated in the same change.

| Rule | Explore |
| --- | --- |
| One question per screen (§10.5) | *What does the data say?* The answer leads: rows and their count under the composer. The table rows' row in §10.5 is joined by **Explore** replacing **Query**: *leads with the answer to the question asked, the composer above it, the tables beside; moves out: earlier questions into History, a table's snapshots and maintenance into its page* |
| Colour (§10.3) | Nothing new. Current only for **Streaming**; a locked table is a lock and words; the shown tab is ink; a queued run shimmers its words |
| Status (§10.6) | The rail's glyphs through `itemStatus` and `StatusGlyph`; **Kept** as the table page says it; never a `Badge` in a state's tone |
| Type (§10.4) | Table and column names, statements and the From control's name in the code face (`.ident`); titles in the interface face; the page title in display |
| Motion (§10.7) | The run ring, shimmer, `row-arrive`, the History column's `.slide-in-right`, the wave on Streaming; nothing new. A tab change moves nothing |
| Writing (§10.9) | **Explore**, **New exploration**, **Choose a table**, **Tables**, **History**, **Run again**, **Open in Explore**, **Waiting for your other queries**, **Link copied · It reopens this question for anyone who may read its tables**. Never "session", "worksheet", "catalog", "schema browser" in view |
| Patterns (§10.10) | *Tabs keep their place* (the explorations), *Properties column* (History beside the row's), *Undo, not "Are you sure?"* (delete), *Search in place* (the rail's `/`), *Empty state*, *⌘K*. **Query thread** becomes **History**: *each question and its answer in turn, in the exploration, kept in the browser* |
| Components (§10.11) | New, feature-specific: `ExplorationTabs`, `TablesRail`, `TableChooser`, `HistoryColumn`. Nothing generic is added; `ResizeHandle` and `Popover` serve the rail and the chooser |
| Accessibility (§10.12) | The strip is the ARIA tabs pattern; the rail a `tree` with `aria-expanded`; History a `listbox`; every action reachable by keyboard; glyphs hidden beside their words; reduced motion stops the slide and the wave |
| Phone (§10.5) | Checking and acting: the answer and its filters; composing stays on the desktop; 44 px targets; sheets for the rails |

Checklist (§10.13) before it is done: both themes, desktop and phone, keyboard only, reduced
motion, the design check (`src/design.test.ts`) passing, console 10 updated.

## 11. Failure modes

| Failure | Behaviour |
| --- | --- |
| A domain unreachable | Its row in the rail says so; its tables stay from the last snapshot; a run naming one of them fails at once with `503 domain_unreachable` on the status line; the other explorations are unaffected |
| A domain the person is not signed in to | Its datasets are not listed, the row offers **Sign in**; a statement naming its table is `401` naming `<domain>.<dataset>` |
| The source's materialization deleted, or the table dropped | The fleet no longer lists the table: the rail drops it; the next run is `400 there is no table …`; the exploration keeps its question in History and says why on the status line |
| A run expired | A refresh's `404` runs the view again; a History row whose run is gone asks for Run |
| Data access turned off while explorations are open | The next run is `503 unavailable`; the page shows the off state on its next config read (every minute) |
| The tail app down, or a table backlogged | As the Data tab: committed rows, the status line's words, **Peek** where it helps |
| The control plane of the settings home down | Explore works: the browser store needs no server; a run naming no table is owned in the home but needs no call there |
| `localStorage` blocked or full | Explorations live for the page's life; full, the oldest closed go, said once |
| Two browser tabs editing one exploration | Last write wins per document (`updatedAt`); the other tab sees the change through `storage` and keeps its own run |
| A console replica restart | Runs are lost (as today, console 16 §16.3); each open exploration runs its view again on its next refresh |

## 12. Test plan

### 12.1 Unit (every CI run)

| File | Covers |
| --- | --- |
| `server/routes/runs.test.ts` (new) | `POST /api/runs`: a browse run by reference; a statement over two domains; `SELECT 1`; a name without its domain refused with the fix per domain; a table no domain holds; `data.query` missing on one dataset refused naming `<domain>.<dataset>`; a guest `401`; an unreachable domain `503`; the per-materialization route answering as before; `queued` while another of the person's runs scans; `runConcurrencyPerPerson: 0` |
| `server/routes/sql.test.ts` | Extended: validation at console level, the unqualified-name fix across domains |
| `server/routes/data.test.ts` | `POST /api/data/estimate` over several tables, summed, `rowsExact` |
| `server/settings/catalog.test.ts` | The new setting described and bounded |
| `shared/statementNames.test.ts` | The parser moved from `server/runs/names.ts`, same cases |
| `src/features/explore/explorations.test.ts` | The document: `titleOf`, `recordQuestion` and its cap, `settle`, share links both ways (filters, SQL, the run id), `migrate` of an older version |
| `src/features/explore/store.test.ts` | The browser store with a fake storage: save/load/list/remove, the quota rule, cross-tab notification, a blocked storage |
| `src/features/explore/lake.test.ts` | The tree from a fleet and datasets: locked datasets, kept tables, a domain not signed in, `queryable` per table, search ranking |
| `src/features/data/hooks.test.ts`, `live.test.ts`, `autoRun.test.ts` | Unchanged behaviour after the extraction; `useWorkbench`'s view key and dirtiness |
| `src/features/tables/keptTabs.test.ts` | Extended to `features/explore`: a key listener on the document asks `useTabShown()` first |
| `src/design.test.ts` | Passes with the baseline at zero |

### 12.2 Static

`npm run typecheck` (both projects), `npm run build` (QueryEditor still a chunk), `npm audit` (0).

### 12.3 Browser (Playwright, a local console against a test cluster's domains; recorded in console 14 §14.4)

| Flow | Checks |
| --- | --- |
| A | `/explore` as a Dataset Reader on one domain: the item in the sidebar, a new exploration, the rail listing that domain's datasets, the other domain offering **Sign in** |
| B | Choose a table: the opening view's exact count at once; filters auto-run under the threshold; a large range waits with its size |
| C | SQL joining `domain_a.…` and `domain_b.…`: validation underlines a name without its domain and the fix; the run; the status line naming the domains; export needing `data.export` in both |
| D | Three explorations: Streaming only in the shown one (the `liveHold` probe of PR #28), a count finishing while hidden, ⌘↵ acting on the shown one only, the 9th open refused |
| E | History: five questions, re-opening the third re-attaches; after the run expires (retention lowered), Run ringed and **Changes not run yet** |
| F | Reload on `/explore/<id>`: the strip restored, the run re-attached, the page kept; a second browser tab sharing documents but not the strip |
| G | Share link opened as another person: a new exploration, the question run under their access; a table they may not query refused naming the dataset |
| H | Permissions: a guest sent to sign in; a Viewer without `data.query` denied; a locked dataset's table with a lock and no action; columns hidden without `dataset.view_schema` |
| I | **Open in Explore** from a table page carries the view and the run |
| J | Per-person admission: three heavy statements, the third **Waiting for your other queries**, then running |
| K | A domain made unreachable: the rail's row, a run's `503`, recovery |
| L | Both themes, phone width (390 px): the sheets, the bottom bar unchanged; reduced motion; keyboard only through A–E |

## 13. Delivery plan

| Phase | Builds | Tests and docs | Depends on |
| --- | --- | --- | --- |
| 1 — Runs by reference | `resolveTableRefs`; `POST /api/runs`, `/api/data/validate`, `/api/data/estimate`; `startRun` taking a primary; a run with no table; `queued`; admission per person and its setting; the per-materialization routes as aliases; `shared/statementNames.ts` | §12.1 server rows; console 08 (§8.0, §8.1, new §8.16a–c), 03 and 12 | — |
| 2 — The workbench | `Workbench.tsx`, `useWorkbench`, `useStreaming`, `scope.ts`; `DataTab` as a host; `useRun` without a materialization; **Open in Explore** stub | The data tests unchanged and passing; PR #28's continuity probes re-run; console 09 §9.6–9.7 | Phase 1; PR #28 merged |
| 3 — Explore | The model, store and hooks; the page, strip, rail, chooser, History; routing, the sidebar, ⌘K, `RequireDatasetPermission`; share links; the phone layout | §12.1 client rows; console 11 §11.14, 10 (§10.5, §10.10, §10.11), 09 (the map, the state table), 16 (what is deliberately missing: the account store), AGENTS.md's map, handbook 14 §14.15 | Phase 2 |
| 4 — Validation and release | The browser flows A–L on a test cluster through a local console; the design checklist; the PR | Console 14 §14.4 entry; handbook 13 §13.8 | Phase 3 |

Each phase is one PR, opened at the owner's request; phases 1 and 2 change nothing a person sees.

## 14. Sources

Console handbook 01, 07, 08, 09, 10, 11 (§11.1, §11.4a, §11.8, §11.11–11.13), 12, 15, 16, 17 §17.3;
handbook 14 §14.15, 18 §18.3, 20; `.claude/skills/console-design/SKILL.md`; the code named in §3,
§6 and §7, read at b2c2d2e; the redesign proposal's decisions (query history in the browser first;
small questions may auto-run; the phone for checking and acting).

## 15. Decisions for review

| # | Decision proposed | Alternative |
| --- | --- | --- |
| 1 | **Explore is console-level only** (`/explore`), the rail opening on the domain the sidebar was in | A per-domain `/d/<domain>/explore` whose rail shows that domain alone; explorations would still be the person's |
| 2 | **At most 8 explorations open**; the rest in ⌄ | A higher cap; or closing the least recently shown automatically |
| 3 | **Admission per person: 2 scans**, a console setting | No per-person limit (today's behaviour), or a fixed constant without a setting |
| 4 | **A statement naming no table runs** (`SELECT 1`), owned in the settings home | Refuse it with *Name at least one table* |
| 5 | **Explorations stay in the browser after sign-out**, like pins | Clear them on *Sign out everywhere*; or key the store by the person's email |
| 6 | **The rail lists locked datasets' tables with a lock** (names are not secret, as the Datasets page holds) | List only what the person may query |
| 7 | **Clicking a table in the rail browses it in the shown exploration** (its question kept in History); a new exploration is the hover action | The reverse: a click always opens a new exploration |
| 8 | **The phone opens an exploration's answer** with sheets for the rest, not in the bottom bar | Explore hidden on phones; or a fifth place in the bar |
| 9 | **The table page's Data tab starts runs through `POST /api/runs`** too, one path for both hosts | The Data tab keeps the per-materialization route, two paths |
| 10 | **The spec lives at `docs/design/explore.md`** beside the other design specifications, listed in the handbook's README | Not kept in the repository once built |
