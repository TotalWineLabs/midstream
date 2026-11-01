# 11 — Feature Reference

Exactly what every screen shows, where each value comes from, and what every control does.

## 11.1 App shell

Persistent around every page (`components/AppShell.tsx`), in the design language of
[10](./10-design-system.md).

| Element | Behaviour |
|---------|-----------|
| Sidebar (≥ 768 px) | The mark and **Midstream** (to the overview); the domain switcher; **Search or jump to… ⌘K**; **Overview**, **Materializations**, **Datasets**; pinned items; **Settings** and the account at the foot, and the live indicator there only when the console's link to its control planes is down. In a domain the items are that domain's; under **All domains** every domain's. Items a person may not open are left out. Collapses to icons, remembered in `console.sidebar.collapsed` |
| Needs-you count | Beside **Materializations**: how many failed or need attention, in Buoy (Flare when one failed). Nothing at all when none do |
| Pinned | Materializations and datasets a person pinned (the pin on a materialization's page, or ⌘K), each with its state's glyph; kept in the browser (`console.pins`, `lib/pins.ts`); unpinned with the × on hover. No heading when nothing is pinned |
| Domain switcher | Where the console serves several domains: **All domains**, then each domain. A domain's dot shows only when it needs saying — unreachable, reconnecting, not usable. Choosing one keeps the section open: the overview, the lists, settings |
| Content panel | The page sits in an inset panel on the canvas, beside the sidebar |
| Phone (< 768 px) | A top bar with the mark, search and the account (and the live indicator while the link is down); a bottom bar with **Overview**, **Materializations**, **Datasets** and **Search** |
| ⌘K, Ctrl+K or / | The command menu (§11.1a) from anywhere; on the search page, focuses its field |
| Account menu | The person's name and email, the domains they are signed in to (and **sign in to more**), **Appearance** (**System**, **Light**, **Dark**: `console.theme`, applied before first paint), **Your account**, **About this deployment**, **Sign out everywhere**. Signed in nowhere: **Sign in** |
| Domain banners | Above the page, one per domain that is misconfigured (its control plane says it is another domain) or runs a release this console does not work with, saying which |
| About this deployment | The console's version and every domain's control plane's; a warning when the domains sign access tokens with different federation keys |

### 11.1a The command menu

One field to go anywhere or do anything (`components/CommandMenu.tsx`):

| Before typing | After |
|---|---|
| **Go to**: Overview, Materializations, Datasets, Settings, Your account (those the person may open); five materializations, the ones that need someone first | Places and materializations by name, id or topic, ranked and highlighted; **Actions** on the first three found: **Stop** (running), **Resume** (stopped), **Pin** or **Unpin**, each only with the permission in its domain; **Tables** and **Datasets** as search answers; **See every result** for the search page |

↑↓ move, ↵ opens or acts, Esc closes. A stop acts at once; its toast offers **Undo**.

### Signing in (`/sign-in`, `/sign-in/:domain`)

**Sign in to Midstream.** Where the console is registered with providers, a button for each —
**Sign in with Microsoft**, **GitHub**, **Google**, or the OpenID Connect provider's own label — signs
in to **every domain that admits the person** at once (handbook 20 §20.7). Below, **or with a
password**: a password signs in to one domain, chosen in a **Domain** field where the console serves
several (`/sign-in/<domain>` names it, and the page that sent the person here preselects its own);
each domain has its own accounts. A wrong email and a wrong password read the same — "Email or
password is incorrect." — and a locked-out or deactivated account says so, as does a domain whose
password sign-in is off for all but administrators. "Forgot your password? Ask an administrator of
<domain> to set a new one." Accounts are made by each domain's administrators, or — under the `open`
policy — at someone's first sign-in through a provider.

Back from a provider, a toast says where the sign-in started a session and where not, and why
(*Signed in to Domain A · Domain B: no account there*); when no domain admitted the person, the sign-in
page shows each domain's answer. After signing in, the page returns to wherever the person was going.
A guest who opens a page that needs more is sent here first; a signed-in person without the permission
sees **Access denied** naming what the page needs, in which domain.

**A password someone else chose** — a new account, an administrator's reset, the bootstrap
administrator — must be replaced before anything else, in the domain that set it: the console shows
only **Change password** for that domain (current password, new password, confirm), with its minimum
length, and **Sign out of <domain>**. Once it is changed, the person is signed straight back in and
carries on. A session started through a provider is never held back by it.

A session that ends elsewhere — signed out by an administrator, deactivated, expired — turns the
page into that domain's guest's at the next request, and open streams close within 30 seconds.

### `LiveIndicator`

Liveness is said by what moves — the river, numbers rolling, rows streaming in — so the shell shows
this only when the console's link to its control planes is not live (§10.7). Pages carry no dot of
their own.

| Condition | Display |
|-----------|---------|
| `status === 'live'` and no error | Nothing |
| `status === 'connecting'` | A Buoy dot and **Connecting…**, shimmering |
| Reconnecting or control-plane error | A Buoy dot and the error, e.g. `control plane at http://… is unreachable` |

`compact` keeps only the dot, with the words in its tooltip: the collapsed sidebar, the phone's top
bar.

---

## 11.2 Overview (`/`)

Is everything flowing? Data: `useFleet()`, from the shell's one fleet stream.

| Part | Content |
|------|---------|
| Readout | Pills: **N need you** (Buoy, or Flare when one failed) and **All N on track** or **N on track**. Then the fleet's rows a second, set large, rolling as it changes (`Ticker`, `formatReadoutRate`), and **into N tables · N rows committed** |
| The river | Every materialization as a channel from **Kafka · N topics** through the **Midstream · N** gate, the river's middle, into the **Lake · N rows** (`features/overview/River.tsx`, `riverEngine.ts`, `riverWater.ts`): its width and its comets' speed by its rows a second, the middle of the channel faster than its edges; records grey up to the gate's line, rows in Current from it, running on into the lake under its surface and into its current, which carries every channel's rows on together, flows faster the more rows arrive, and holds as many settled rows as the lake holds rows (log scale); a backlog crowding its channel, records piling at the gate when failed (Flare) or starting (Dawn), amber after the gate when it needs attention, a still dashed channel when stopped; problems on top. Pointing at a channel names it with its rate; a click opens it; a hidden list of links serves keyboards and screen readers. Drawn with WebGL 2, or in 2D without it; sized by the river's width; pauses off screen; one still frame under reduced motion; at most 3,200 particles in the channels and 600 settled in the lake |
| Needs you | One line for each materialization that failed or needs attention: its name, state and reason, and **Open**. Gone when nothing needs anyone |
| Materializations | The first eight, the ones that need someone first (`MaterializationRow`): the state's glyph, the name, the state's word and reason, and one fact (§11.3). **See all** past eight |
| Domains | Under **All domains** with several: each domain's materializations, rows a second and rows |

With nothing to show: **Nothing is flowing yet**, what a materialization is in one sentence, and
**New materialization**. Skeletons render until the first frame arrives.

---

## 11.3 Materializations (`/materializations`)

Which one needs me? Data: `useFleet()`.

### Groups

Materializations grouped by what someone does about them (`lib/status.ts::statusGroup`), each group
only when it has any: **Needs you** (failed, needs attention), **In progress** (starting, updating,
resuming, catching up, stopping, deleting), **Flowing**, **Stopped**; by name within a group. A
group's heading carries its count.

### Rows

`features/materializations/MaterializationRow.tsx`: the state's glyph (§10.6), the name and its
domain under **All domains**, the state's word and reason, on wide screens the source topics `→` the
datasets, and one fact in the state's tint (`rowFact`):

| State | Fact |
|---|---|
| Flowing | Rows a second, `0.1/s`, `6,240/s` |
| Catching up | How far it has come and the time left, `62% · 1h 50m left` (`catchUp`, `lagEtaMs` from `shared/lagTrend.ts`: from the backlog's peak, or by rows when the history began mid-backlog) |
| Stopped | Rows committed |
| Others | None: the reason beside the word says it |

↑↓ or j k move between rows; ↵ opens one.

### Search

**Find by name, topic, dataset or table**: case-insensitive, across `materialization_id`, the label,
the domain, every source topic, dataset and table (`sales.orders`). Wrapped in `useDeferredValue`.

### Recently deleted

**Recently deleted · N**, shown only when some were, lists them with when they went, until the
control plane's retention drops them.

Empty states: **No materializations yet** (with **New materialization**), **Nothing matches** (with
**Clear**).

### Creating one (`/d/<domain>/materializations/new`)

A page, not a dialog (`features/materializations/CreateMaterializationPage.tsx`): **New
materialization** opens it, and ⌘K's **New materialization**; on a page of every domain it asks which
domain first. It needs `materializations.create`.

**The composer**, on the left:

| Part | Notes |
|------|-------|
| *Which topics should flow into the lake?* | One or more of the cluster's topics, up to the control plane's `max_materialization_topics` (20); see [Topic picker](#topic-picker). Each becomes a table, in the dataset chosen on its row (see [Tables](#tables-dataset-and-name)). Focused when the page opens. Fixed once created |
| Name | Optional, for people: free text, at most 128 characters, changeable later with **Edit**. Without one it goes by its id |
| Data protection | The policy in a line, opening into a row per kind with **Off**, **Hashed**, **Partial** and **Withheld** (only the masks a kind allows), pre-set from the domain's *Protected by default*; **Use the default** returns to it. Choosing otherwise needs *Choose data protection* on every dataset the tables go in: without it the control is locked, naming the datasets, and a changed choice blocks **Create**. A choice that hashes in a domain with no protection key says the control plane will refuse it (control-plane handbook [22](../../docs/handbook/22-data-protection.md)) |
| **Options** | Folded, its summary the choices in a line: *by day · 1 worker, more when behind · null records kept*. Opens on its own when the control plane refuses one of its fields. **Partitioned** (by day, the default from `default_partition_granularity`; by hour, by month, or not: *By the Kafka timestamp. Fixed once created.*), **Workers** (the replicas; checked against the control plane's maximum), **Add workers when far behind** (autoscaling, on; *Up to 16, back once caught up*, or that it is off for every materialization; sent only when off; absent before 4.4), **Ignore null records** (tombstones; off: each is a row with its key) and **Labels** (`key=value`, comma separated) |

**The plan**, beside it (below on a phone), says exactly what will exist before anything runs:
each table as SQL will read it, `sales.orders`, with the topic it comes from; how it is partitioned,
its workers, how many kinds it masks (each one in the tooltip) and its null records; and *About a
minute: its names are claimed, its topics sampled, its tables created, then its workers start. You
can leave; it carries on.* Then **Create**, or **Create 3 tables**. On success the page opens the new
materialization, which shows **Starting** with what it is doing, and a toast says *Creating Orders —
You can leave: it carries on.*

The destination, the runtime's namespace and name, and its storage are the deployment's since 4.0
(handbook 04 §4.5.2): the page has no field for them. While the control plane reports no destination,
the plan says *No storage is set up for tables yet*, pointing to Settings, and **Create** is disabled.
The defaults come with the console's config, kept for a minute.

### Topic picker

The source topics are chosen from every topic in the cluster (`GET /api/topics`), searched in the
browser so typing never waits on the network. Choosing a topic adds it and keeps the list open for
the next; choosing a chosen one removes it.

| Behaviour | Detail |
|-----------|--------|
| Search | Every whitespace-separated term must appear in the name. Exact name first, then names that start with a term, then terms that start a word (after `.` `-` `_` `/` `:`), then substrings; ties go to the shorter name. Matches are emphasised |
| Internal topics | Topics with a `category` are hidden behind **Show internal topics (N)**. A search that matches only hidden topics says so and offers to show them. Shown ones carry an **Internal** badge whose tooltip names the category |
| Chosen topics | Listed under the field in the order chosen — the order of the tables — each with a remove button and its table's row: the dataset and the table's name (below) |
| Already materialized | A topic read by a live materialization carries **Materialized** (or **Materialized ×N**), in the list and among the chosen; the tooltip names them. Each materialization reads a topic independently, with a consumer group of its own |
| Partitions | One column, with replication factor in the tooltip. Under the field: one topic's partitions and replication factor, or for several the partitions in all and how many runtime members they can keep busy — topics with as many partitions share members (`assignableMembers`, the control plane's `scale.py`) |
| The limit | At `max_materialization_topics`, unchosen topics are disabled and the hint says so |
| Long names | Truncated in the middle, so the end, where versions and suffixes differ, stays visible |
| Keyboard | Typing on the closed field opens the search with that character. `↑` `↓` `PageUp` `PageDown` move, `Enter` chooses, `Esc` closes the list without closing the dialog |
| Unlisted names | A typed name that is not listed can be used through **Use "name"**. The field then warns that the name is not in the cluster's topic list. On **Create** the control plane asks Kafka again, and refuses a topic it still does not list (below) |
| Freshness | **Updated N ago** in the footer; the reload button asks Kafka again. A stale list says Kafka is unreachable |
| No topic list | If the list cannot load, the picker says why and still accepts a typed name, marked as unchecked |

Only the rows in view are rendered, so tens of thousands of topics scroll and filter like a dozen:
on 25,000 topics, results render about 17 ms after each keystroke.

### Tables: dataset and name

Each chosen topic's row reads `→ [dataset] . [table]`, as SQL will read it
(`features/datasets/TableDraftRow.tsx`, the logic in `tableDrafts.ts`):

| Part | Behaviour |
|---|---|
| Dataset | A searchable list of every dataset (`DatasetPicker.tsx`): name, description and how many tables it holds; those the person may add tables to first. A dataset they cannot write is listed locked, *no write access*, and cannot be chosen. A new row starts with the dataset chosen last, or the only one the person may write. With `datasets.create`, **New dataset** at the foot creates one in place — a name, fixed once made, and an optional description; *You become its owner, and everyone signed in can read it* — and chooses it once the directory has applied it |
| Table name | Derived from the topic as the control plane derives it (`payments.v2` → `payments_v2`; `tableNamesForTopics`, `_2`, `_3` for names two rows would share) and following the topic until typed over |
| Checks, as typed | A dataset chosen, and one the person may write; a name SQL can read (a lowercase letter first, then lowercase letters, digits and underscores, at most 63 characters, not a reserved word); no two rows with one name; not a name the dataset already holds — *sales.orders is taken; choose another name*. *Choose the dataset its table goes in* waits for a submit |

**Create** stays disabled until a topic is chosen, every row is clean, the label is valid, and a
destination is available (given, or the default). Labels are parsed client-side;
a malformed pair raises an "Invalid labels" toast naming the offending pair and does not submit.
Submitting waits until the tables' names are claimed (08 §8.6), so a name someone else claimed first
is said on its row — *sales.orders is taken* — and the dialog stays open, the dataset list refreshed.
A topic Kafka does not list — missing, or hidden from the deployment's Kafka user — is refused the
same way, on its row: *Kafka has no topic ghost, or the deployment's Kafka user may not describe it.*
(handbook 04 §4.5). That row keeps **Create** enabled: nothing on the row can fix it, and once the
topic exists, or the user may read it, sending again succeeds.
On success: a toast (*…is being discovered and deployed*, or that its names are still being claimed
when the directory had not answered in 10 seconds), the form resets, the dialog closes, and the app
navigates to the new detail page. Any other failure: an error toast, and `ApiError.details.field`
highlights the offending input.

---

## 11.4 Detail (`/materializations/:id[/:tab]`)

Data: `useDetailStream(id)`. The stream subscription switches the whole store to the 1.5-second
detail cadence while the page is open.

### Header

**Materializations** above the title, which is the label (`name`) or the id. On every tab but the
Overview, whose readout says it, the state as a pill (§10.6). Actions on the
right: **Pin** (to the sidebar), **Edit**, **Resume** or **Stop**, and **⋯** with **Delete…**.

### Actions

Each action also needs its permission (`materializations.resume`, `.stop`, `.edit`, `.delete`); a
person without it does not see the button.

| Button | Shown when | Behaviour |
|--------|-----------|-----------|
| Resume | the desired phase is `stopped` (also while it is still stopping) | Acts at once: *Payments is resuming*; scales back to the replica count |
| Stop | the desired phase is `running` and the materialization has a runtime | Acts at once, no dialog: *Payments is stopping. Nothing is lost: its tables stay readable, and Resume picks up where it left off.*, with **Undo**, which resumes it |
| Edit | it has a runtime and is not being deleted | Opens the edit page (below) |
| Delete | `observed_phase ∉ { deleting, deleted }` | In **⋯**: opens the delete plan, naming every table it removes (below) |

A stop loses nothing and duplicates nothing: rows still being batched are read again on resume, since
the committed offsets only cover rows in the table (handbook [10 §10.7](../../docs/handbook/10-runtime-internals.md)).
While stopping the state reads **Stopping**; once the KasprApp has no members, **Stopped**.

### Edit page

`/materializations/<id>/edit` (`features/materializations/EditMaterializationPage.tsx`; the plan of a
change of topics in `topicChange.ts`) changes what can change after creation: the **Name**, the
**Topics**, the **Workers**, **Add workers when far behind** and **Data protection**. Like the create
page, it is a composer beside its plan (10 §10.10): the fields on the left, and on the right — below
them on a phone — what saving would do, kept current as anything changes. A materialization that
cannot be edited (no runtime, or being deleted) sends the page back to its own.

**Which topics does it read?** is the create page's topic picker, filled with the topics read now.
Each chosen topic shows the table it writes: its own, `sales.orders`, fixed, for a topic already read;
the kept table, *kept table, written again*, for a kept table's topic; and for any other a new row, a
dataset and a name, as on create, the name apart from every name the materialization has — kept
tables' and dropped ones' included. Topics already read keep their order, so reordering alone restarts
nothing (`keepOrder`). A topic the change starts reading that Kafka does not list is refused as on
create: on its row, or under the topics for a kept table's topic, which has no row of its own. While an
earlier change's new tables are still being claimed, the composer says so — *Adding
sales.order_refunds: their names are being claimed* — and the topics cannot change until it is done.

| When the topics change | The page |
|---|---|
| A topic is removed | Under the topics, for each removed topic's table, a choice: **Keep read-only** or **Drop with its data**. Saving waits until each has one |
| The materialization has kept tables whose topics stay removed | **Kept tables**: a checkbox each, *Drop finance.payments and its data · topic payments* |
| A table it would add, write again, keep or drop is in a dataset the person cannot write | Its row carries a lock, and beside **Save** the plan names the tables and their datasets: *ask one of its owners for write access* |

**Name** is the label, as on create; changing it alone touches nothing else, and needs no access to
any dataset.

**Workers** starts at the current count, and must be a whole number from 1 to the control plane's
maximum. The hint gives the current count and the chosen topics' partitions, and warns when workers
would outnumber what the topics can keep busy — topics with as many partitions share workers, so 32,
32 and 8 partitions keep at most 40 busy ("2 would have none to read"); on a stopped materialization
it says the count applies on resume.

**Add workers when far behind** is the autoscale checkbox, as on create; changing it alone is a valid
change, and leaves the runtime as it is unless it takes workers away. Its hint says what it does now:
*Running 12 workers while it catches up. Turned off, it goes back to 4 at once.* while scaled up, or
that it is off for every materialization when the deployment turned it off.

**Data protection** is the create page's block, starting from the policy in force (*· current*;
**Keep the current protection** returns to it). It needs *Choose data protection* on every dataset the
materialization writes into, those of topics the edit adds or writes again included; otherwise the
block is locked, naming them. A protection-only edit restarts nothing and leaves the materialization
**Running**. With a changed policy, someone who may also run table maintenance sees **Also mask rows
already written** (off), and under it **Purge the plain text now** (on): the edit's
`protection.reprotect`, rewriting the files written before once each table records the change
(§11.10a). Below, read-only: the id, storage per worker and the destination — fixed when the
materialization was created.

**The plan** lists, by the names SQL reads:

| Group | What it holds |
|---|---|
| Adds a table / Adds N tables | Each new table, `sales.refunds`, with its topic |
| Writes again | Kept tables whose topics are read again |
| Keeps, read-only | Removed topics' tables kept |
| Drops, with their data — this cannot be undone | Removed topics' tables dropped, and kept tables checked, each with its rows and size |
| Changes | Name, Workers and More when behind, each from the current value, struck through, to the new |
| Masks | What the protection change does to each kind: *Phone numbers: hashed → partial*, applied to records written from now on, rows already written keeping their values unless masked again |

Then what it costs, as it will happen: new tables' names claimed first, then their topics sampled and
their tables created; with a change of topics, its workers stopping until their consumer group has
emptied — about two minutes — then starting with the new topics, each table where it left off; a new
count of workers re-applied; protection within seconds, without a restart; or, stopped, that it runs
with the changes once resumed. Until something changes the plan says *Change something, and what it
does shows here.*

**Save changes** — **Save, dropping 2 tables** when the plan drops any, as a danger button — is
enabled once something changes and nothing blocks it; the first thing that does is said beside it, in
the plan: a topic still to choose, a removed table still to decide, a new table still to name, an
earlier change of topics still applying, a dataset the person cannot write, workers out of range, or
protection the person may not choose. **Cancel** returns to the materialization. A change adding tables
waits for their names to be claimed, as a create does. The toast says what the control plane planned —
*Shop: adding sales.refunds; keeping finance.payments read-only.* — and the page returns to the
materialization; a refusal shows under the field it names, a name taken on its row. Dropping only kept
tables restarts nothing; any other change of topics shows the materialization **Updating** —
*Changing its topics* — for about two minutes (handbook
[07 §7.9a](../../docs/handbook/07-control-plane-workflows.md)).

### Delete plan

**Delete…** opens a dialog that is a plan (10 §10.10): *Delete Payments?*, then **Deletes its 2
tables, with their data — this cannot be undone**, every table it removes by its SQL name, kept ones
and ones being dropped included, each with its rows and size; **Stays**: its topics, which Kafka keeps;
and a note that its workers stop, then its tables leave their datasets — queries on them stop working
and their names are free again — and that where the control plane keeps deleted tables' files they
stay in storage. The runtime, its Kafka topics and its consumer group go too. Deleting needs write
access to every one of those datasets; without it a table carries a lock, the plan names the datasets —
*ask their owners* — and the button stays disabled. The button says what it does: **Delete it and 2
tables**, in danger red.

If the control plane is unreachable and no detail has ever been fetched, the page renders a
"Cannot reach the control plane" panel with the error instead of an empty shell.

### Tabs

**Overview**, **Protection**, **Diagnostics**. URL segments: `` (Overview), `protection`, `runtime`.
A materialization is about the pipeline; each table it writes has a page of its own for its rows,
schema and history (§11.4a). The tabs it had for them redirect there: `data`, `schema` and `table`
(with `?table=`, the first table when absent) open that table's Data, Schema and History, a Data
address keeping its view (`run=`, filters, range). Every tab needs `materializations.view_details`;
beyond it, **Protection** needs `dataset.view_schema` on at least one of the tables' datasets. A tab
someone may not open is not shown, and a link to it opens the Overview. The rule is the server's
(12 §12.2): the console only follows it.

---

## 11.4a A table (`/d/<domain>/datasets/<dataset>/tables/<table>[/:tab]`)

What is in it? (`features/tables/TablePage.tsx`) A table lives in its dataset, which names it; the
materialization that writes it feeds every tab (`useDetailStream`), found through the dataset
(`GET /datasets/:dataset`). An address in another case redirects to the table's own spelling.

**Header** — **Datasets / sales** above the title, `sales.orders` with its dataset quieter: the name
SQL reads it by. Below: its state — its materialization's while it writes the table (§10.6), else
**Kept** (read-only, no longer written), **Starting** (being created) or **Being dropped**; then
*complete through 2:41 PM* (every record with a Kafka timestamp before then is in it),
its rows and size from the control plane's record, and *from Orders*, a link to the materialization.
**Pin** keeps it in the sidebar, under its SQL name with its materialization's state.

| Tab | Address | Answers | Needs, on its dataset |
|---|---|---|---|
| **Data** | the page itself | What rows does it hold? The Data tab (§11.8) on this table, live rows above the waterline | `data.query` |
| **Schema** | `/schema` | What fields, and how did they change? (§11.7) | `dataset.view_schema` |
| **History** | `/history` | How did it get here? Its figures, snapshots and maintenance (§11.10) | — |
| **Connect** | `/connect` | How does another engine read it? Its snippets, files by partition and properties (§11.10) | — (the snippets `catalog.read`) |

A tab the person may not open is not shown; an address naming one opens the first they may. A
dataset locked to them shows the name and a note, never its schema or data; so does a person who
may not see materializations' details. A table the dataset does not hold (dropped, or never written
there) says so, with a link to the dataset's tables.

---

## 11.5 Detail → Overview

Is it healthy, and what does it write? (`features/detail/MaterializationOverview.tsx`) The state
leads; everything about how it runs is in Diagnostics (§11.6).

**The readout**, by state (§10.6):

| State | Leads with | Context | Chart |
|---|---|---|---|
| Flowing | Rows a second, rolling as it changes | **Complete through** the earliest of the tables' `validThrough`, or the last commit | Rows a second, the last 30 minutes |
| Catching up | Records behind | *Caught up around 4:30 PM · 62% there · falling 5,914 a second*: the drain's end at its current pace; how far it has come — from the backlog's peak when the console's lag history saw the backlog begin, otherwise rows committed out of rows committed and records behind (`backlogProgress`), so a console started mid-backfill does not mistake the lag it first saw for the start; and the rate | Records behind over **15m / 1h / 6h**, on an axis fitted to the values |
| Stopped | *Stopped 5 minutes ago* | *Its tables stay readable, and Resume picks up where it left off.* (Stopping: *Shutting down its workers*, shimmering; Deleting: *Removing its runtime and tables*) | **Resume**, with the permission |
| Starting, Updating, Resuming | What it is doing, shimmering: *Waiting for its workers* | — | — |
| Needs attention, Failed | The reason in words, or the control plane's message | The message, where it says more | **Open Diagnostics** |

**Four facts** — **Rows committed** (rolling as commits land) and **Size**, from each table's
current snapshot (`GET …/data/summary`, every 15 s; the workers' own counts stand in, labelled, while
the tables cannot be read); **Behind** — **Caught up** at the lag floor, else the records behind, with
the time to go or *and growing*; **Workers** — how many run, *scaled up from 2* while autoscaling has
it scaled up, *none while stopped*.

**Tables** — one row per table, in the order of its topics, then the kept tables, then any being
dropped: the table as SQL reads it, `sales.orders` — its dataset a link to the dataset's page, its
name a link to the table's page (§11.4a) — on its rows when the person may query it, else its
history — or a lock naming the dataset — above its topic, its rows, size and files from the control
plane's record, its topic's lag, its schema id, its last commit, and its state — **not created yet**
until the control plane has sampled its topic and created it, **kept · read-only**, **dropping**,
**dropped · files kept**, its last error in red, what runs on it (files pending, a maintenance job),
or **Written**. The heading counts them, and the kept ones beside (`features/detail/TablesPanel.tsx`).

**Properties**, in a column beside (below on a phone): the state with its reason, the **Target** while
it differs, what it **Reads**, what it **Writes** (datasets and how many tables), **Workers**,
**Partitioned by**, **Null records** (kept as rows or ignored), **Protection** (the kinds in force as
chips, and how far the policy has reached: **In force · revision 2**, **Applying revision 3**,
**Applies on resume**, **No member reporting**), **Created** and by whom, the **Location**, the copyable
**Id**, the **Workers' version**, and **Diagnostics**.

---

## 11.6 Detail → Diagnostics

Everything the control plane knows about how it runs, for whoever needs to look closely
(`DiagnosticsPanels` in `features/detail/OverviewTab.tsx`, then `RuntimeTab.tsx`).

**Reconciliation** — one line, *Desired running, observed running* with the `phase_reason` code
beside it, and `phase_message` under it; then when it last sent a heartbeat, was observed and changed,
its last commit, its tables (`N of M created` until every table exists) and the workers' version;
`last_error` in Flare when present. While autoscaling has it scaled up, *Scaled up to 16 members 5
minutes ago: … Back to 1 once caught up.* With two or more workers, a summary of their states and
**Show N members**: each one's state (*loading the table* while it reads its pointer), its own rows a
second, when it last reported, and a **committer** badge on the one that commits. The panels carry no
method captions; Kubernetes names are expected here, for support. Conditions show True or False
neutrally, but for Ready false.

**Consumer lag** — how far the tables trail their source topics, all together. It is measured from the runtime
consumer group's committed offsets, and a runtime commits an offset only once its row is in the
table, so lag counts records not yet committed: a caught-up materialization of a busy topic shows up
to a batch per partition plus a commit interval, and its lag falls in steps as commits land
(control-plane handbook [10 §10.7](../../docs/handbook/10-runtime-internals.md)):

| Part | Content |
|------|---------|
| Headline | The latest measured lag, records behind |
| Trend | **Caught up** at the floor — a lag no larger than what arrived on the source topics in the last 630 s (the batch ceiling and a commit interval), counted from the topics' end offsets at each measurement — however it wobbles as batches commit. Above it, **Catching up** with the drain rate and the time left at that pace (`−5,914/s · about 4h 38m to go`), **Falling behind** with the growth rate, or **Holding steady**: the least-squares slope of the last ten minutes of measurements, where under half a record a second, a single record, or 0.1% of the lag is no trend. **Not measured lately** once ten minutes pass without a measurement (`shared/lagTrend.ts`) |
| Chart | One point per measurement over **15m / 1h / 6h**, on an axis fitted to the values, so a large backlog falling slowly is a slope rather than a flat line at the top of a zero-based chart |
| Partitions | `N of M partitions behind`, and **Show M partitions** for each partition's lag with a bar against the largest; with several topics each is named `<topic> P<n>`, and each topic's own lag is in the Tables panel |
| Footer | When it was last measured and how often measurements arrive |

**Specification** — the **Source topics**, the tables' **Location** (the directory each table's own
sits under), **Replicas** (with "none running while stopped" when stopped, or "16 while catching up"
while autoscaling has it scaled up), **Autoscaling** (**On · up to 16**, **Off**, or **Off for every
materialization**; absent before 4.4), storage per replica, `namespace`, `runtime_mode`,
`resolved_runtime_name`, `resource_profile`, `spec_version` and **Data protection**, then label and
annotation chips when non-empty. Its datasets, tables, partitioning, null records and creation are in
the Overview's properties.

**Throughput** — the last ~20 minutes as a chart with a value axis, clock times and a hover (or
arrow-key) readout; **Rows / Bytes** switches the series.

**Skipped records** — when any were: each reason with its count and where its latest is on the
source topic.


**Kubernetes resource** — `kaspr_app_name`, `namespace`, `resource_exists`, `available_members`,
`metadata_generation / observed_generation`, rollout state, `rebalance_required`,
`rebalancing_members`, and the observation timestamp. Below: two condition cards (Ready,
Progressing) each showing status badge, humanized reason, message, and when it last changed.

**Managed agents** — one row per entry in `managed_agent_states`, with a state dot coloured by
`running` / `paused` / `stopped` / `failed`. The header summarises
`R running · P paused · U unknown of T`.

**Runtime binding** — `kaspr_app_name`, `namespace`, `runtime_mode`, `template_version`,
**Schema when applied**, applied-at, the copyable `last_applied_spec_hash`, and the managed agent names
as badges. Empty state explains the binding is written when `apply_runtime` completes.

---

## 11.7 Table → Schema

A table's schema, as the control plane projects it (06 §6.3), on its page (§11.4a). Each table has
a schema of its own that evolves on its own. Two columns: a rail of every schema the table has had
and the selected one.

### Versions rail

"Every schema the table has had, by its data." One entry per schema id, newest first, with `current`
on the table's own and what it changed — `3 added · 1 forked` — and when its data begins, read from
the table (06 §6.3, *When the data had each field*):

- **Schema 0** reads *Initial · sampled*: discovery sampled it from both ends of the topic, so it
  can hold shapes from any part of the topic's history. Its tooltip says so, with when it was
  committed.
- **A later schema** reads *data from Apr 15, 2025*: the earliest first value among the fields it
  added, forked or collapsed, in UTC, as precise as the table's partitions — `Apr 1 – 30, 2025` for a
  month table. A version is numbered by when the runtime met its shape, which a backfill or the
  sampled schema 0 can put out of the data's order; the date says when the records had it.
- Until the table can answer (not created, nothing committed, data access off) it falls back to
  *committed 2 days ago*, the control plane's `since`.

The selected schema's description reads `19 fields · data from Apr 15, 2025 UTC · committed Oct 23,
2026, 11:18:49 AM`. Selecting one shows it; the current one comes from the live snapshot with no
extra request.

### Callouts

Above the current schema, when they apply:

| Callout | When |
|---|---|
| *N fields are kept as JSON text: their values changed type too often, or their objects grew too wide, for columns of their own.* | a family collapsed (handbook 09) |
| *The schema is at its field limit: new fields are not added, and their values go to `_unmapped`.* | a change was rejected at `max_schema_fields`; it points to Settings › Schema evolution |
| *Values went to `_unmapped` in the last hour (N in all, last …).* | the runtime reported unmapped values recently |

### Fields

Payload fields first, in schema order with each fork family together, then the Kafka metadata.

| Column | Content |
|--------|---------|
| Field | Its logical name, ancestors dimmed (`customer.` + **email**); below it, for a fork or a renamed key, `written to total__v2`, `since schema 3` for a field newer than schema 0, `first seen Sep 1, 2025` for a field that was not in the table's first records, and `last seen Feb 9, 2026` for one superseded or no longer arriving (its last value a day or more before the table's last record). Dates are UTC |
| Type | The Iceberg type as a chip (`long`, `struct`, `list<string>`); a JSON field reads `json` |
| Required | `required` when the field is |
| State | `current`, `superseded` (a newer fork took over), `collapsed` |
| Id | The Iceberg field id |

A protected field carries a shield beside its name, its tooltip saying its kind, its mask and the
schema it was protected from (*Masked · Email addresses · hashed since schema 0*).

**Tree** nests the same fields by path. A filter matches name or type; **Hide superseded** hides the
older members of each family, rendered at 55% opacity otherwise.

### Timeline

**Timeline** lists the table's changes by the day the data had them, newest first, whatever schema
version holds each: a field's first value (*first value*, with its type), a type change (*changed
type from string to struct · its string values run until Aug 31, 2025*), a family kept as JSON from
then on, a field's last value when it stopped arriving, and values first going to `_unmapped`. A
field that arrived inside a struct or list added the same day is folded into it, so a new object is
one entry. Each day is headed by the span its entries' files cover — `Apr 15, 2025` in a day table,
`Apr 1 – 30, 2025` in a month table — and the panel says how precise that is for the table's
partitioning. The table's first records are one group, collapsed behind **Show**: *first records: 5
fields held values from the start*. Clicking a field name shows it in the Fields view.

### Changes

**Changes** diffs the selected schema against an earlier one (06 §6.4): each entry with its kind —
added, forked, collapsed, type widened, required changed, superseded — its field and type, and for a
changed field what changed. A short hint explains each kind; a fork, for example, says the older
field keeps the values written before it.

---

## 11.8 Table → Data

A table's rows, on its page (§11.4a). One way to ask a question: choose a time range, add filters or write SQL, press **Run**. Everything
on the tab — the opening view, paging, profiles, exports — reads from the run that produced what is
on screen. How a run executes is the server's business; there are no modes, previews, or jobs to
choose between (see [07](./07-data-access-and-duckdb.md)).

### Opening the tab

The tab runs the table's preview at once — every committed row of its current snapshot, newest first, with its **exact** row count — `✓ 26,060,201 rows · All time` — and the first page. The
manifests know every file's row count, so this reads nothing but the page itself and is on screen at
any table size. When the URL
names a run (after a refresh, say), the tab re-attaches to it instead, progress and all.

| Outcome | Rendering |
|---|---|
| Loading | Skeletons |
| Nothing committed yet | "No data to query yet" + *Rows appear here once the first records are saved* + **Check again** — unless live tail is on: the tab then runs at once, its rows from the tail until the first commit |
| The table cannot be read | *<table> is not readable* + why — *no storage is configured for …* when no storage profile covers its location, else what storage answered — + **Retry** |

With the live tail on — every materialization has one — every run also holds the records past its
snapshot that the runtime has not committed yet, from the tail app ([07 §07.9](./07-data-access-and-duckdb.md)): the
newest of all, first in newest-first order.

### Toolbar

| Control | Behaviour |
|---|---|
| **Columns** | Opens or closes the column rail, saying how many of the table's columns the grid leaves out (*6 hidden*). Closed until someone opens it, then as they last left it (`console.data.columnsOpen`), so the rows get the room |
| **Time range** | Splunk-style picker (below). Choosing a range does not run anything |
| **Newest first / Oldest first** | Row order of the structured view |
| Filters | Chips, and **Filter** to add one: find the field, then choose an operator and a value, with value suggestions from the run on screen |
| **SQL** | Opens the editor with a statement for the current filters |
| **Streaming** | On a running materialization — every one has a live tail — in a console and control plane with it on, in the structured view: on by default. The toggle goes at once when the materialization is stopped, and within two minutes when the deployment's switch is (the tab reads the console's config every minute); turned back on, it returns and streaming picks the tail up by itself. While it is on, the tab is seen, the run has succeeded, the first page is on screen (newest first) and no row is open, the run takes in what arrived every `liveTailRefreshMs` (1.5 s); a commit replaces the run with one pinned to the new snapshot. Its word and the flowing wave are in Current; the wave drifts while it streams and rests while it waits, its tooltip saying the status line has why. Off, both are quiet. Off is remembered in the address bar (`live=0`) |
| **Run** / **Stop** | The tab's only Run. While a run works it is **Stop**. `⌘↵` / `Ctrl+↵` anywhere on the tab |
| **More actions** (⋮) | Right of **Run**: **Peek**, **Share** and **Export…** (below) |

Changing the time range, a filter, the order or the statement **does not run anything**. The Run
button gains a ring and the status line says **Changes not run yet**, so the screen never disagrees
with the controls silently.

### Time range

Presets in three columns, like Splunk's:

| Relative | Last | Other |
|---|---|---|
| Today, Week to date, Month to date, Year to date, Yesterday, Previous week, Previous month, Previous year | 15 minutes, 60 minutes, 4 hours, 24 hours, 7 days, 30 days | All time |

Below them, collapsible: **Relative** (last *N* minutes/hours/days/weeks), **Date range** (whole
local days, both ends included) and **Date & time range** (local, end exclusive).

Every preset shows how many rows it covers, from the manifests — `≤1.2M` when files only overlap
the range, an exact figure when they lie wholly inside — so a narrower, faster question is visible
before it is asked. The footer says where the data sits on the time axis, and how many rows have no
timestamp (those appear only under All time).

Ranges filter on each record's **Kafka timestamp**, the `_kafka_timestamp` column, in the browser's
time zone, which the picker names (`America/New_York`); weeks start on Sunday. A relative range is
resolved when Run is pressed, so a run is pinned to the window the user meant. The table in SQL
is bounded by the same range.

### Status line

The status line is a row of its own at the top of the table, between the toolbar and the grid. It
says what the run is doing or what it found, in a few plain words, and nothing the reader has to decode: not the range, which the toolbar shows, nor files, bytes or snapshots. Every
run reads the table as it is now; the Data tab offers no older snapshot (the runs API still takes
`asOf`, 08 §8.16).

| State | Shows |
|---|---|
| Running, structured view | `Scanning · 1,460,000 of 3,120,000 rows · 46% · 51,230 matched so far`, elapsed, `~3 s left`, a progress bar; the toolbar's **Stop** ends it |
| Running, statement | `Preparing · 26%`, then `Running · 45%` (or indeterminate), then `Counting rows` when it outgrew what is kept |
| Succeeded | `✓ 1,234,567 rows` (how long it took in its tooltip) |
| Failed | The error; a statement's is also marked in the editor |
| Cancelled | How long it ran and how many rows it had found |

**More actions** (⋮), right of **Run**, lists **Peek**, **Share** and **Export…**, always all three:
one that does not apply is disabled, the reason in its tooltip — Peek *Available while this table is
catching up*, Export until the run has succeeded, without `data.export`, or with nothing to export.
**Export…** opens its formats in the same menu, with a way back.

With live tail, every run holds the records past its snapshot. What the tab says of them is in plain
words — how far behind the view is, never which part of the system is. Nothing while it simply
streams: **Streaming**'s drifting wave says so. How far behind the newest records the view is, or why
streaming stopped, is at the status line's right, in amber — an hourglass beside a count, turning
every 3 s (still when the system asks for reduced motion). It stays while a run started at a commit
works. A backlog's count is the
table's topic lag as the Overview measures it, once a minute, so it moves at the Overview's pace
whether or not streaming refreshes the run; until a measurement is in, the tail's own count. Anything
else is a few muted words on the status line.

| Tail | Shows |
|---|---|
| Following | Nothing beyond **Streaming**'s drifting wave |
| Streaming off, or a statement | Nothing |
| Paused while hidden, past page 1, or with a row open | *Streaming paused while this tab is hidden* (… *past the first page*, … *while a row is open*) |
| Short of the head (`truncated`) | *4,000 records behind* — the records not shown — in amber at the status line's right |
| Backlogged | *2,500,000 records behind* — the topic's measured lag — in amber at the status line's right; **Peek** is enabled |
| Waiting for a schema change | *2 rows have new fields* — their new fields are under `_unmapped` until the table adds them |
| Behind the topic | *Streaming is 7 s behind* |
| Warming up, not followed yet | *Streaming is starting*; asked again each refresh |
| Moving between members | *Streaming is reconnecting* |
| Unavailable | *Streaming is unavailable* in amber at the status line's right, the reason in its tooltip; the run shows the rows saved so far |
| The range has ended | *This time range has ended* — and Live asks nothing |
| Session refused | *Streaming stopped: sign in again to follow new records*, in amber at the status line's right |
| Switched off while followed | *Streaming is off*, the reason in its tooltip, until the toggle goes |

**Peek** opens a panel over the grid, *Newest incoming records*, with the newest
200 records on the topic, saved or not, in the table's columns, labelled *not in the table yet*; it
reads again every `liveTailRefreshMs` while open and seen, quietly — its spinner shows on the first
read only — and closes itself once the table has caught up. It is never part of the run, its export
or its profiles.

The figures for the structured view are exact: rows of the files counted so far over rows of every
file in range, both from the manifests, so the bar moves at the rate work is actually done. When the
table has a newer snapshot than the one a result read, **Newer data available** offers to run again.

The row count is always shown when a run finishes. A statement's result larger than
`CONSOLE_RESULT_ROW_LIMIT` keeps its first rows for paging and export — `first 1,000,000 kept` — but
its total is still counted exactly.

### Grid and paging

Rows stream in as a run counts: the first page appears as soon as the newest files are counted,
long before the total is final. While a filter has matched nothing yet the grid says **No matching
rows yet** rather than showing placeholder rows. The footer offers first, previous, a page box
(`Page 2 of 31,201`, with `+` while counting), next and last, and rows per page (50–1,000); the
exact count is the status line's, at the top.

Any page is one direct read of one file's rows, so page 2 and page 40,000 cost the same, and the
next page is read ahead — on the server and in the browser — so turning pages does not wait. The
toolbar's order: **Newest first** means files holding the latest Kafka timestamps first, latest
offsets first within each; a global sort is a statement's `ORDER BY`.

**The waterline** (§10.8). Browsing, the rows past the table's last commit — the live tail's,
which no engine but the console reads yet — have Current's faintest ground, their row numbers in
Current. Where they meet the committed rows a line runs across the grid: *Committed 2:41:12 PM*, the
last commit, which every row on its other side is in; its tooltip says so. Newest first it sits
below the live rows, at the top of the first page when nothing has arrived since; oldest first,
after the last committed row. The server marks both on every page (`RunPage.live`,
`RunPage.waterline`), so the line is exact whatever the filters. A statement's result has neither.

**Streaming never flickers.** The rows on screen stay as they are, at full strength, until their
replacement is read: a refresh that takes in the tail's newest records, and the new run a commit
starts, both keep showing the page's rows meanwhile — only another page, or another question,
dims them. The run a commit starts works out of sight: the status line, the pager, the ring and
**Run** describe the run it replaced until it is counted. Rows that arrive settle in with a
moment's stronger Current (`row-arrive`, 1.2 s, none under reduced motion). Rows are keyed by
their record — Kafka partition and offset — so at the top of the grid the new rows come into view,
and scrolled into it the row being read stays where it is while the new ones arrive above.

Column headers do not sort. Clicking a cell copies it; the row gutter opens the row drawer (below).
`null` renders as italic `null`.

Timestamps with a time zone — `_kafka_timestamp`, and any `TIMESTAMP WITH TIME ZONE` a statement
returns — render in the reader's time zone as `2026-10-04 19:59:59.685`, the zone named in the
column header (`ET`) and the UTC value in the tooltip, so a row inside "Today" reads as today.
Copying, filtering and exporting use the stored UTC value. Payload strings that happen to hold a
time are shown as written.

### Filter builder

**Filter** opens a builder in two steps, starting fresh each time.

1. **Find a field.** A search box over every column — fields first, then the Kafka metadata — with
   the best matches first: every typed term must appear, and an exact name, a name starting with a
   term, or a term starting a path segment (`email` in `customer.email_hash`) ranks ahead of a plain
   substring. Matches are emphasised. `↑` `↓` `PageUp` `PageDown` move, `Enter` chooses, `Esc`
   closes. It replaces a select of every column, which on a wide schema was a long scroll.
2. **Say what it should be.** The chosen field heads the step with **Change** to go back; then the
   operator — ordering comparisons only for numbers and times — and the value, with the field's
   most frequent values in the run on screen offered as one-click choices. That list has four
   distinct states — loading, values, none, and failed — because a single spinner cannot tell
   "still working" from "this will never resolve"; it says **Partial** when the range was too wide to
   summarise in time.

### Column rail

**Fields** and **Kafka metadata**, grouped, searchable, with visibility checkboxes, **only**, and a
pin that freezes a column beside the row numbers. By default the grid shows the record's timestamp
first, then the fields; the other metadata is a click away. Fields follow schema order and carry
their logical names; a forked field appears once with its whole history folded in. Only the
runtime's own columns count as Kafka metadata (`_kafka_*`, `_materialized_at`, `_unmapped`), so a
field such as `_id` stays with the fields. A column's type reads compactly — `STRUCT`, `MAP`, `LIST`
— before the scalar types. A masked column carries a shield, its tooltip saying its kind and mask,
read from the table's own `materializer.protection` (06), so it is right whatever the materialization's
policy says now.

Expanding a column profiles it over the run's rows — distinct count, null share, top values, range —
under the 8-second stats budget, labelled `partial` when it ran out of time. A top value filters to it.

Drag the divider to widen the rail (264–720 px); the width is remembered per browser. The rail is
closed until **Columns** opens it (Toolbar).

### SQL

**SQL** opens the editor above the grid with a statement for the current filters on the chosen
table — `SELECT * FROM sales.orders WHERE … LIMIT 1000`. Every table of the materialization the
person may query, kept ones included, is there by its canonical name, `<dataset>.<table>` — the name
an engine on the catalog uses — so a statement can read any of them and join them, across datasets
(`… FROM sales.orders o JOIN finance.payments_v2 p ON p.order_id = o.order_id`); the header names
them and says they hold the rows of the chosen time range. Completion offers those tables, the
columns of the one being typed after, and `iceberg.<dataset>.<table>` for each — the same rows with
the native columns, structs and lists as an external engine sees them. A name that is none of the
tables, a bare `orders` included, fails with the list of those that are; one in a dataset the person
may not query is refused, naming the dataset (08 §8.1). Columns carry their logical
names, quoted: `"status"`, `"customer.email"`. A statement runs in a sandbox that can read nothing
but the snapshot's files (07 §07.6). **Back to filters** leaves SQL.

The statement is checked half a second after typing stops — bound, never run — and an error is
underlined in the editor at the token the engine pointed at. A failed run marks the same way. CodeMirror
loads only when the editor first opens.

With the live tail on, a statement reads each table's tail once, when it runs, and
the panel offers **Auto re-run**, off by default: a new run five seconds after the last one
succeeded, never while one runs, and not while the editor holds another statement than the one on
screen.

### Export

Appears only once a run has succeeded, for someone who may export from every dataset it read. It
downloads that run's result — every row, in the order
shown — as CSV, JSON, JSON Lines or Parquet, and says how many rows that is. It never re-runs the
query and never exports just the page on screen. Text formats stream, so the download starts at once.

**JSON layout** chooses how JSON and JSON Lines lay out a row, and is remembered per browser:

| Layout | A row reads |
|---|---|
| Nested (default) | `{"customer": {"email": …}, "items": [{"sku": …, "qty": …}]}` — the record rebuilt from the column paths, `json` fields decoded |
| Flat | `{"customer.email": …, "items[].sku": [ … ]}` — one key per column, as the grid shows it |

CSV and Parquet are always flat.

### Sharing and refreshing

The address bar is the view: time range, filters, order, statement, page, page size, visible and
pinned columns, Live (`live=0` when off), and the run on screen. **Share**, under More actions, copies it. A link made
before snapshots left the Data tab (`asof=`) opens on the latest data. A link made before columns dropped the
`payload.` root still opens: its filters, columns and pin are rewritten to the current names once
the run's columns are known. Reloading the page re-attaches to the
same run if it still exists — a long query keeps going and the status picks up where it was — and
otherwise runs the view again.

### Row drawer

Every field of one row on one vertical axis, grouped like the rail and including hidden columns, with
per-field copy, filter-to-this-value, whole-row JSON copy (in the JSON layout chosen under
**Export…**), and `↑`/`↓` (or `j`/`k`) to step rows. A masked field carries the rail's shield. A timestamp shows its local time with the UTC
value beneath it.

---

## 11.8a Versions

The sidebar footer carries the console's version; clicking it opens **About this deployment**,
listing the console and the control plane side by side. They are deployed independently, so the
dialog says plainly that they can differ.

A materialization's **runtime** version appears on its Overview, in the Reconciliation panel beside
Schema — a runtime keeps the build it was created with until its spec is re-applied, so
this is the one that answers "what code is actually processing my data". It is blank until that
runtime has reported status at least once.

See [handbook 16 — Versioning](../../docs/handbook/16-versioning.md) for what each number means.

---

## 11.8b Settings (`/settings/:section`, `/d/<domain>/settings/:section`)

Where an administrator changes how the console, each domain's control plane and its runtimes behave,
without a redeploy. `features/settings/`. Two pages share one layout (handbook 17 §17.8):

- **The console's** (`/settings`, under **All domains**): the console's own settings, stored in the
  settings home, the **Domains** in its registry, **Your account** in each domain, and every domain's
  **Change history** merged.
- **A domain's** (`/d/<domain>/settings`): its control plane's and runtimes' settings, its directory
  — users, groups, roles, the audit log — and **Sign-in**.

### Layout

**Search settings** heads the section list (above the picker under 768 px); `/` focuses it from
anywhere on the page, ⌘K staying the command menu's (*Search*, below). Below it, the sections, in
groups. Each section shows only to people with its permission — on the console's page, in the settings
home; on a domain's, in that domain:

| Page | Group | Sections | Needs |
|------|-------|----------|-------|
| Console | Account | Your account | signed in to any domain |
| Console | Console | Live updates, Data explorer, Live tail, Security, Topics & Kafka, Diagnostics | `settings.view` in the settings home |
| Console | System | Domains | signed in |
| Console | System | Deployment | `settings.view` in the settings home |
| Console | System | Change history | `settings.view` in any domain |
| Domain | Access | Users, Groups, Roles, Security, Sign-in, Audit log | `users.view`, `groups.view`, `roles.view`, `settings.view`, `settings.view`, `audit.view` |
| Domain | Platform | Materializations, Data protection, Deletion & retention, Schema evolution, Runtimes, Commits, Live tail, Compaction & retention, Iceberg catalog, Background jobs | `settings.view` |
| Domain | System | Topics & Kafka, Diagnostics, Deployment, Change history | `settings.view` |

Without `settings.manage` the settings sections are read-only: no save bar, no Reset. A domain's
Security holds its session, password, lockout and audit settings; the console's Security its two
(session check interval, sign-in attempts per minute). **Sign-in** turns each provider on or off in
the domain, sets what a first sign-in does (`open` or `invited`), the email domains that may sign in
through a provider (any, when empty), and whether people may sign in with a password (administrators
always may).

**Domains** lists every domain in the registry: its status and why (*Live*, *Its control plane
cannot be reached*, *says it is another domain*), its version, the id of the key it signs access
tokens with (*differs* when it is not the one most domains share, with a warning above the list),
whether it is the settings home, whether you are signed in there — **Sign in** when not — and
**Open**.

**Data protection** holds *Protected by default*: a row per kind of sensitive data, **Off**,
**Hashed**, **Partial** or **Withheld**, what every new materialization masks unless it chooses
otherwise. Saving it also needs *Manage data protection defaults*: without it the row is read-only,
saying so, while the rest of the page may still be saved. A change applies to materializations
created from then on, never to existing ones. While the domain has no protection key, a warning
above the rows says so: nothing can be hashed, so a create that keeps a default that hashes is
refused until the key is added (control-plane handbook
[22](../../docs/handbook/22-data-protection.md) §22.9). The
domain's **Deployment** section shows the protection key's id, or *not configured: nothing can be
hashed*, and the storage its apps and runtimes write with: the S3 endpoint, region and path-style
addressing and the Azure Blob endpoint, never a credential. The console's own **Deployment** section
names its storage profiles in **Object storage access** — each one's name, kind and mode, direct or
cached — and gives each a row, **Storage profile <name>**: its scope, endpoint, region and path
style, what it reads with, and the variables its credentials come from, never a value
([03 §3.6a](./03-configuration-reference.md)).

A section with unsaved edits carries a dot in ink (a `•` in the picker). Settings marked advanced sit
in a collapsed **Advanced** panel, which opens by itself when one of them has an edit.

### Search

Typing in **Search settings** shows, in place of the section, what matches every word typed (`search.ts`,
`SettingsSearch.tsx`): *8 settings match “retention”*. First the sections whose name matches —
*Deletion & retention*, *Compaction & retention* — and those without settings whose name or summary
does (Users, Groups, the audit log), each a way in. Then each matching setting under its section's name,
a link to the section: a setting matches on its name, description, key (`snapshot_retention_hours`
reads as words too) or environment variable, and one whose name holds the words comes first in its
section. Advanced settings are found like any other. A result is the setting itself, changed in place:
its edit is the same draft the section holds, counted in the same save bar. Last, the settings only the
deployment sets that match, under **Deployment**, read-only. Nothing matching: *Nothing matches
“zzqx”*, what search reads, and **Clear search**.

Escape clears the search and, once empty, leaves the box; choosing a section, from the list or a
result, ends it.

### A setting

| Part | Shows |
|------|-------|
| Label | With *Can remove data* and a warning sign when changing it can, and *Unsaved* while it has an edit. An edited row is also marked the way a document marks a change: a raised ground and an ink bar in its margin |
| Description | What it controls and, where useful, when to change it. Only where the label is not enough |
| Provenance | Nothing while it holds its default. *Set by the deployment* (the environment variable in its tooltip), or *Changed by jane · 5 minutes ago · deployment value 16 workers* |
| Effect | While it has an edit, what the change applies to, when that is not "at once": *Applies to new materializations* |
| Control | A number field with its unit, a switch, a text field, a select for an `enum` setting such as **Default partitioning** (its `options`), or a row of choices per option for a `choice_map` such as **Protected by default**. Large numbers keep thousands separators, and a readable equivalent shows under the field (`= 15 min`, `= 8 MiB`) |
| Reset / Undo | **Reset** returns an override to the deployment value or default (named in its tooltip). **Undo** drops an unsaved edit |

### Saving

Edits are drafts until saved. A bar at the foot — on a phone, above the navigation — counts them and,
on a wider screen, names their sections, and offers **Discard** and **Save changes**. Save stays disabled while an edit is invalid: the field says why
(`At least 1`, `A destination such as gs://bucket/prefix, s3://bucket/prefix or
abfss://container@account.dfs.core.windows.net/prefix`). One save covers every section and scope.

| Outcome | What the page does |
|---------|--------------------|
| Applied | Toast **Settings saved**: *They apply from now on*, or *Running runtimes pick the change up within seconds* when a runtime setting changed |
| Accepted, still applying (after 10 s) | Toast saying so; the page re-reads 3 s later |
| A value refused | The message under that setting and in a toast; edits stay |
| Someone changed the scope first | A banner: *These settings changed after this page loaded. Your edits are kept: reload to see the current values, then save again.* with **Reload settings** |
| The control plane is unreachable | A banner, *Settings are read-only*, naming the URL it cannot reach. The control plane's settings are not shown; the console's are shown locked |

Leaving the page with unsaved edits asks first.

### Runtimes: delivery to runtimes

Above the runtime settings — on Runtimes, Commits, Schema evolution and Compaction & retention,
every section that holds some — **Delivery to runtimes** shows how far the current runtime-settings
revision has reached. Beside its title, how many running materializations run it — *3 of 3 running
current*: quiet, with a check, when all do; with Starting's turning glyph while one is still applying;
as needing attention when delivery has settled but some cannot take it yet (§10.6). Below, each
materialization that is not current, with its state: **Applying** (with the revision it is on, or none
while it runs settings from before this installation), **Not reporting**, **Stopped**, or, in words, *On
its next deploy* (its runtime predates live settings). While one is applying, the page re-reads every
5 s.

Before any runtime setting is changed (revision 0) the panel only says so — unless a runtime still
runs settings an earlier installation left on the delivery topic: it is then listed as
**Applying** until it drops them, within seconds (handbook 17 §17.7).

### Deployment

The settings only a deployment can change, per component (control plane, runtimes, this console),
each with its value and environment variable, locked.

### Change history

Every scope's changes, newest first: who, when, the scope, the revision, and each setting's value
before and after; a value that was not an override is marked *(default)* or *(deployment)*. The newest 100 per
scope are kept.

## 11.8c Your account (`/settings/account[/:domain]`)

Everyone signed in to a domain. Where the console serves several, **Your domains** first: each
domain, with who you are signed in there as and how (*with a password*, *through Google*), **Show**
and **Sign out**, or **Sign in**; **Sign out everywhere**. Then **Access tokens**, every domain's at
once, and below them your account in the domain shown (`/settings/account/<domain>`, your first by
default): your name and email ("An administrator manages your name, email and groups"); **What you
can do** there, by category; **Password** — changing it signs you out of that domain everywhere else,
and this browser carries on with a new session; and **Sessions** there: each browser signed in, with
its address, when it signed in and was last active, **Sign out** on any other one, and **Sign out
other sessions**.

**Access tokens**: credentials for DuckDB, Spark, Trino or PyIceberg to read the Iceberg REST catalogs
as you, in every domain where you have an account (handbook 18 §18.15). Each token shows its name,
permissions, expiry, the domain it was **made in**, and the datasets it is limited to — named
`<domain>.<dataset>` — (*Every dataset you may read, in every domain* when it is not), with **Revoke**,
which reaches every domain. **New token** asks for a name, the domain to make it in (one where you
hold `catalog.read`), the permissions (those you hold there; **Commit to tables** is marked as able to
rewrite data), the **Datasets** — every one you may read, now and later, in every domain, or **Only
these datasets**, chosen from those you read in any domain you are signed in to — and a lifetime,
then shows the token **once** with **Copy**: *Copy it now: it is not shown again.* — with the
federated catalog's URI, and a domain's own for engines that read one level of namespaces. With one
domain the page is that domain's account, as before.

## 11.8d Users (`/settings/users[/:userId]`)

The list (`users.view`): tabs **All users**, **Active**, **Deactivated**, **Locked out**,
**Password to change**, each with its count; search by name or email; sort by name, last active
or date added. Each row shows name and email, groups, status badges (*Deactivated*, *Locked out*,
*Password to change*, *Administrator*, *You*) and when they were last active.

**Add user** (`users.manage`): first and last name, email, an **Initial password** — generated,
20 characters from an alphabet without lookalikes, with **Copy password** and **Generate a new
password** — and **Groups**. Only groups whose access the person adding holds can be chosen
(`grantable`); everyone is in All Users anyway. The new user must change the password at first
sign-in; pass it on out of band.

A user's page (`users.view_details`):

| Panel | Shows / does |
|-------|--------------|
| Profile | Name and email; editable with `users.manage` |
| Groups | The groups they were added to, editable (only groups you may grant); All Users and Guest are implicit |
| Access | Every permission they hold, by category, each with the groups and roles it comes from |
| Dataset access | Their roles on single datasets, their own and their groups' (*through Finance team*), each dataset a link to its page, with Share open |
| Activity | Added, last signed in, last active, failed sign-ins |
| Sessions | Their sessions; **Sign out** on one |

Actions, with `users.manage` and only for someone whose access you hold yourself: **Unlock** (when
locked out), **Reset password** (a generated one to pass on; ends their sessions; they must change
it), **Sign out everywhere**, **Deactivate** / **Reactivate** (deactivating ends every session at
once), and **Delete** (only once deactivated; frees the email). You cannot deactivate or delete
yourself, and the last active administrator cannot be removed.

## 11.8e Groups (`/settings/groups[/:groupId]`)

The list (`groups.view`): name, members, roles, created on; built-in groups first, marked with a
lock. **New group** (`groups.manage`): name, description, roles.

A group's page: **Settings** (name, description — fixed for built-in groups), **Roles** (which
roles it grants; the Admin group always keeps Administrator), **Access** (the permissions those
roles amount to), **Dataset access** (its roles on single datasets), and **Members** with **Add
people** and remove (`users.view` to see them). Guest
and All Users have no member list: their membership is automatic. Changes need `groups.manage`
and, for anything that grants access, holding that access yourself.

## 11.8f Roles (`/settings/roles[/:roleId]`)

The list (`roles.view`): role, type (*Built in* / *Custom*), description, the groups holding it.
**Create role** (`roles.manage`).

The editor: **Role details** (name, description), **Permissions** by category with a filter by
type, each permission's description, *Can remove data or access* on the dangerous ones, and what
each implies — choosing **Export data** also shows **Query data** as included. A dataset permission
carries a **Per dataset** badge: held through a group it applies on every dataset, granted on a
dataset (the dataset roles, 11.11) on that one only. **Permissions preview** sums up what the role grants and **Held by** lists
its groups. Built-in roles are read-only — "they gain new permissions as the application does" —
with **Duplicate** to start a custom role from one. You can only grant permissions you hold.

## 11.8g Audit log (`/settings/audit`)

`audit.view`. Newest first, 50 at a time with **Load older entries**: when, the event (*Signed
in*, *Failed sign-in*, *Locked out*, *Added a user*, *Changed a group*, *Made an access token*,
*Revoked an access token*, …, with **Failed** on failures), who did it, and what it was done to. Filter by activity (sign-ins, users, groups,
roles), by outcome, and search by email, name or address. A row opens to the address and browser,
and what changed, before and after. Entries are kept for the audit retention setting (90 days).

## 11.9 Cross-cutting behaviour

| Behaviour | Where |
|-----------|-------|
| Every mutation shows a toast naming the materialization and the requested phase | All lifecycle actions |
| No optimistic updates | All lifecycle actions |
| Relative timestamps update every second without refetching | Everywhere `RelativeTime` is used |
| Ids are copyable on hover | `Identifier` |
| Loading states preserve final layout | Skeletons sized to their content |
| Control-plane outage keeps last-known data visible | Header states the outage |
| Deep links work on cold load | Server SPA fallback |
| Pages, navigation and buttons follow the person's permissions; the server checks every request again | `useCan`, `RequirePermission`, route `permit()` |
| A table's dataset decides what of it a person sees: its schema, data, snapshots as of a time, connection snippets. Tables of datasets locked to them are listed, with a lock, never hidden: names are not secret | `useCan(permission, datasetId)`, `shared/access.ts` |
| A change to users, groups or roles waits for the control plane to apply it before the toast | `useIdentityChange` |

## 11.10 Table → History and Connect

A table's Iceberg side, on its page (§11.4a): how it got here and how it is kept (**History**:
figures, snapshots, maintenance — `features/detail/TableTab.tsx`), and how another engine reads it
and how it is laid out (**Connect**: the connection, its partitions, its properties —
`features/tables/TableConnect.tsx`, `PartitionsPanel.tsx`). Data from
`GET /api/materializations/:id/tables/:table` (06 §6.5).

**Connect**, top to bottom:

| Panel | Shows |
|---|---|
| Connect | With `catalog.read` on the table's dataset. One sentence on reading through the REST catalog with an access token (a link to make one); the table's catalog name, `lake.sales.orders`, and the catalog's URI, each with copy; the engine's snippet (**DuckDB**, **PyIceberg**, **Spark**, **Trino**, **By path** — DuckDB's `iceberg_scan` on the location) with **Copy**. How each engine reads the data files follows the location's scheme, from the console's storage profile for it: an `s3` secret or `s3.*` properties with the endpoint, region and path style; an `azure` secret or `adls.*` properties with the account; a GCS HMAC secret, `GCSFileIO` or Google credentials. Every credential is a placeholder. Notes only when they apply: the catalog turned off, no storage profile for the location, the address engines outside the cluster need |
| Partitions | Where its data is in time: *730 days · Oct 5, 2024 to Oct 4, 2026 · 108 due for compaction*. A column chart on a true time axis — **Size**, **Files** or **Rows** — each partition a column, binned into weeks, months, quarters or years as finely as the width allows, empty stretches left empty; the ones the next compaction takes stronger than the rest, a neutral emphasis, since a state's colour never paints a series (§10.8). The line above the chart reads out the whole table, or the column pointed at: its value, its time, its partitions, files and small files, size, rows and how many are due. Rows without a timestamp, and an unpartitioned table, are counted beside the legend. **List** gives every partition's exact numbers. A note says what counts as small and when compaction takes a partition (`features/tables/partitions.ts`) |
| Properties | Identifier, format, schema, partition spec, sort order, current snapshot and table UUID; the location and the metadata file, each with copy; **Iceberg properties**, folded, the commit and metadata settings behind **Show all** — without the fork map, `materializer.protection` and `schema.*` for someone who may not see the dataset's schemas |

**History**:

| Panel | Shows |
|---|---|
| Figures | **Rows**, with *Complete through* (every record with a Kafka timestamp before then is in the table); **Size**; **Data files**, with how many are small; **Last commit**, with its duration |
| Snapshots | The newest 200: when committed, the operation (append, a compaction's replace, a **reprotect**'s, …), files and rows added, the offsets reached. The current one's row opens the table's Data tab, for someone who may query its dataset; the Data tab reads the latest data only, so older rows do not |
| Maintenance | **Compaction**, **Snapshot expiry** and **Orphan cleanup**: each job's last run — when, its outcome, its partitions, `32 files → 1`, bytes, snapshots expired and kept, orphans deleted of those listed, how long it took; a skipped run's note in muted text and a failure's in amber; the job running now. The maintenance app runs them on its own schedule, whether or not the runtime runs, kept tables included. **Run now** (`materializations.maintain`) asks it to run one on this table next; the panel follows the result. Once a reprotect has been asked for, a **Reprotect** row too — *requested*, running, or its last run: files rewritten, values masked, snapshots expired — asked from the Protection tab, not here |

Both tabs read the table itself, so they work while the runtime is stopped. A table that cannot be read
shows why (*The table could not be read*), and one not created yet says so.

## 11.10a Detail → Protection

What it protects, and whether that is in force (`features/protection/ProtectionTab.tsx`):

| Part | Content |
|------|---------|
| The answer | How far the policy has reached (**In force · revision 2**, **Applying revision 3**, **Applies on resume**, **No member reporting**), then *4 kinds masked* set large, the kinds as chips with their masks, one sentence — *Masked before anything is written, so no query, engine or file holds the plain value. A change reaches new records within seconds.* — and the revision, who chose it and when. While a change is still reaching it: *Applying: 2 of 3 tables, 1 of 4 workers* |
| Rows already written | One line when nothing is plain: *Nothing in plain text: every value masked now is masked in every file.* Otherwise how many rows in how many files still hold a value plain, and each table with something to say (plain text, a job running or asked for, its last reprotect and what it did). **Mask rows already written** (`materializations.maintain` and *Choose data protection* on every dataset) opens the reprotect dialog, with **Purge the plain text now**. *How this is counted* folds away the snapshot and expiry detail (`ReprotectPanel.tsx`) |
| Revision changes ahead, the current rules | Only when there are any: each field whose protection the recorded revision or the current rules would change, `kind mask → kind mask`, with **Apply the current rules** |
| Protected fields | One panel: each table with a protected field, its masked and withheld counts, and each field's kind, mask and the schema it was protected from (or *Plain since schema N*); the tables that protect nothing named together in one line |
| History | Each revision once, newest first: when, who, from which schema, and what it masks |

## 11.11 Datasets (`/datasets`, `/datasets/:name[/:tab]`)

A dataset is a named group of tables, and their namespace: SQL reads each table as
`<dataset>.<table>`, in the console and through the Iceberg catalog. Access is granted per dataset
(control-plane handbook [18 §18.16](../../docs/handbook/18-identity-and-access.md)). Every page needs
`datasets.view` (`features/datasets/`).

**The list** — every dataset, *including those locked to the person*: names and tables are no secret,
schemas and data are. Search by name, description or table. Each row: the name, as SQL reads it; its
description, when it has one; its tables (how many and the first three, every one in the tooltip); its
owners, or *No owner*; and under **Your access** the person's access in a word — **Owner** and
**Writer** in ink, **Reader** quieter, **Locked** quietest, with a lock (*Its schemas and data need a
role on sales: ask one of its owners*). **New dataset** (`datasets.create`): a name — the
dataset rules, checked as typed, fixed once created — and a description; the creator owns it and All
Users may read it.

**A dataset's page** answers *what is in it, and who can use it?* The header: its name, its
description under it, the person's access in a word and its owners (*Owned by Ana Ruiz*). Its owners
(`dataset.manage`) see **Share** and **⋯** with **Edit description…** and **Delete dataset…**.

Below, **Tables**: every table in it, by the name SQL reads, `sales.orders`, above its topic; the
materialization writing it, a link; its state as everywhere else (§10.6), from its record and its
materialization's — Flowing, Catching up, Stopped, **Kept** (no longer written, still readable),
**Being dropped**, **Starting** while it is created — and *committed 3 min ago*, or *nothing committed
yet*. A table links to its page (§11.4a) for someone who may
read the dataset. Locked to the person: a note that they see the names, not the schemas or data, and
whom to ask. Empty: *No tables yet*, and how one gets there, with **New materialization**.

**Share** (`SharePopover.tsx`) opens beside the button, the way a document is shared: *Share sales*,
a row to add a person or group with a role — **Reader** unless another is chosen — then each person
and group with a role on it, their role a choice beside them that also offers **Remove access**; someone
holding several roles shows them together (*Writer + Owner*). Each role in one sentence: **Reader** sees
its schemas, queries and exports its tables, and reads them through the catalog; **Writer** also adds
tables to it and drops them; **Owner** also changes the dataset and who can use it. An owner grants
only roles they hold on it themselves, and cannot take away a role they could not grant: such a grant
shows its roles as words. A note says plainly what access does not do: *Midstream checks access, not
the storage: anyone with a key that reads the bucket reads every table in it. Table names are not
secret.* The toast says *Shared with Ana Ruiz* or *Ana Ruiz no longer has access*.
`/datasets/<name>/access`, the old Access tab's address, opens the page with Share open.

**Delete dataset…** shows the plan of a delete (§10.10). While it holds tables it cannot be deleted:
the dialog says so — *It still holds 2 tables. A dataset can be deleted once its tables are gone* —
lists them under **Holds**, each with the materialization writing it, and only closes. Once empty:
**Deletes** the dataset and who can use it, every grant going with it; its name is free again; and a
danger **Delete sales**. **Edit description…** asks for one sentence; the name never changes.

A change of access reloads the person's own session, since what they may do may have changed with it;
open detail pages of others pick it up within 30 seconds (08 §8.22).

## 11.12 Search (`/search`)

One box over every domain: materializations by name, id or topic, tables by name
(`<dataset>.<table>` or in full, `<domain>.<dataset>.<table>`), and datasets by name or description —
in each domain where the person may see them. Results are grouped (**Materializations**, **Tables**,
**Datasets**), each with its domain's chip, and open in their domain: a materialization's page, a
table on its materialization's **Table** tab, a dataset's page. ↑ and ↓ move through them, ↵ opens one;
⌘K or Ctrl+K from anywhere focuses the box.

## 11.13 Every domain at once

Under **All domains**, the **Overview** shows the fleet's totals and throughput summed over every
domain, a **Domains** panel (each domain's materializations, rates and status), and *Needs attention*
across domains, each row with its domain's chip; **Materializations** lists every domain's in one
table with a **Domain** column and domain filter chips, and **New materialization** asks which
domain first; **Datasets** lists every domain's, grouped by domain, and **New dataset** asks which
domain first. A domain the person may not see, or that cannot be asked now, is named under the list
with **Sign in** where that would help. Inside a domain each page is as before, about that domain.

