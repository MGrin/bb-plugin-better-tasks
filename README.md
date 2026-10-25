# Better Tasks

A fast task board for [bb](https://github.com/get-bb/bb). Every task in every
project, open work first, in a list or a board — and it stays fast when the
board holds thousands of tasks and agents are changing them all day.

It reads and writes tasks through bb's built-in **Tasks** plugin and never touches
the Tasks database. Goal lanes and their memberships persist separately in this
plugin's own supported SQLite storage. Tasks, labels, statuses, and attachments
stay in core Tasks.

## What it does

- **Everything, open work first.** In progress, in review, todo and backlog
  load first. Done and canceled are one click away — collapsed groups in the
  list, collapsed columns on the board — never a wall of history.
- **List and board**, per project or across all of them.
- **Search** over key and title as you type, plus the task descriptions
  (searched by the Tasks plugin, shown as `+N`).
- **Goal lanes** group tasks across projects by stable identity, with a goal,
  optional operator, and active, parked, or archived lifecycle. Each task has
  zero or one lane. Lanes and labels remain independent.
- **Filters** by lane/no-lane, project, status, priority, label and "agent working now".
  Filters, view and collapsed groups persist per browser.
- **Change status and priority in place** — from a row, a card, the detail
  pane, drag a card between columns, or with the keyboard.
- **Who is on it.** A green pulse marks tasks with a thread starting or
  working right now; the detail pane lists every attached thread and jumps to
  it.
- **Detail pane** with the description, sub-tasks, threads and activity,
  deep-linkable at `/plugins/better-tasks/board/task/<KEY>`, and a link to the
  same task in the built-in Tasks page.

### Keyboard

| Key | Action |
|---|---|
| `j` / `↓`, `k` / `↑` | Next / previous task |
| `h` / `l` | Previous / next column (board) |
| `Enter` | Open task |
| `Esc` | Close task, then clear selection |
| `/` | Search |
| `v` | Switch list / board |
| `1`–`6` | Status: backlog, todo, in progress, in review, done, cancelled |
| `⇧1`–`⇧5` | Priority: urgent, high, medium, low, none |
| `?` | Shortcut help |

## Why it is fast

The built-in page pages through **every task, descriptions included**, and
does it again on every task or thread change event — which, with agents
running, arrives in bursts every few seconds. Better Tasks does the opposite:

1. **A server-side cache without descriptions.** The plugin's server reads the
   board once through the Tasks RPC — open statuses first, then closed — and
   keeps each task as a compact row. Descriptions are most of the payload and
   are fetched only when a task is opened.
2. **Per-task updates.** The Tasks plugin announces every change with the
   task's id. The server hears those announcements on bb's own realtime socket
   (`bb.server.loopbackBaseUrl` + `/ws`), coalesces a burst into one read per
   task (`getTask`, `listTaskThreads`), and publishes a versioned delta holding
   only the rows that actually changed. A burst that changes nothing
   publishes nothing.
3. **Nothing is refetched wholesale.** The page applies deltas by row
   revision, so ordering does not matter; if it ever misses one (a reconnect),
   it pulls just the changes since its version. A full re-read happens only on
   the server, and only when its feed reconnects.
4. **Virtualized rendering.** The list and every board column render only the
   rows on screen. Rows are memoized on the row object, so a delta re-renders
   exactly the rows it touched.
5. **Instant revisits.** The board survives navigating away; coming back
   pulls only what changed.

## Install

```sh
bb plugin install git:https://github.com/MGrin/bb-plugin-better-tasks
```

Or from a checkout:

```sh
git clone https://github.com/MGrin/bb-plugin-better-tasks
cd bb-plugin-better-tasks
npm install
bb plugin install "path:$PWD"
```

It appears in the sidebar as **Better Tasks**. It needs the built-in Tasks
plugin enabled.

## Develop

```sh
npm install
npm test            # tsx + node:test, including synthetic SDK UI acceptance
npm run typecheck   # tsc --noEmit
bb plugin build .   # dist/ bundles
# Reload only an authorized development installation:
bb plugin reload better-tasks
```

Tests use synthetic tasks only. For a contained browser preview, run
`bb plugin build .`, then `npx tsx test/preview-server.ts`. It binds an ephemeral
loopback port and uses SDK fake-host SQLite plus synthetic task/owner fixtures.
It never installs or reloads a plugin. Stop the fixture with Ctrl-C.

## Working with lanes

Open **Lanes** to create or edit a goal, replace its operator, or park/archive/
restore it. **View tasks** scopes the existing virtualized list or board across
projects. The task detail's **Lane** field assigns or unassigns a task. Lane and
label filters combine. Archived lanes remain searchable and viewable.

Lifecycle edits preserve task statuses, attached threads, labels, and memberships.
An active lane is organizational state; **working now** derives from attached
task threads actually starting or working. Missing/unloaded task rows are counted
as unavailable, never silently deleted. Even a confirmed deleted task retains its
membership until explicit unassignment. Owner lookup displays available, archived,
missing, or unknown; it never substitutes another operator.

Names are not identity. IDs distinguish lanes with duplicate names. Mutations
use observed revisions and reject stale edits with current values. Reload and
review before saving a conflicting edit. Membership tombstones retain revisions
after unassignment.

### Agent API

See [the lane skill](skills/lanes/SKILL.md) for complete CLI examples:
`bb better-tasks lane list|get|create|update|archive|restore|assign|unassign|owner`.
Each command accepts `--input '<JSON>'` and returns JSON. Reads default to 100
records, capped at 500; follow `nextCursor`. Conflicts exit nonzero.

Typed RPC methods are `lane` (validated operation union), `laneSnapshot`,
`laneChanges`, `laneImportPreview`, and `laneImportApply`. See
[contracts](lib/lanes/contract.ts) and [import inputs](lib/lanes/import-model.ts).
The independent `lanes` realtime channel carries its persisted version; clients
pull bounded deltas or reset to a lane snapshot after falling behind. Lane-only
edits do not reload the task board or its descriptions.

### Importing existing lane labels

**Import lane labels** maps explicitly selected project/label IDs to existing
lane IDs. Create destination lanes first. The preview shows source projects,
label IDs, affected tasks, existing membership, and conflicts. Matching names
across boards never merge automatically. Several explicit mappings may share a
lane. Resolve each ambiguous/existing membership conflict or skip it.

Apply revalidates all reviewed source facts and revisions, then writes lane
memberships and a receipt in one SQLite transaction. A changed preview applies
nothing. After a lost response, retry the exact preview ID and resolutions to
retrieve its receipt without replay. Pending previews expire after 24 hours.
Limits are 20 selected labels, 500 affected tasks, and 50,000 scanned source tasks.

Core source reads and plugin writes cannot share a transaction: validation
reflects the source facts read immediately before the lane-side transaction.
A concurrent core label edit after that read may require a new reviewed import.
The importer never writes core labels, statuses, or attachments, and never
continues inferring membership after an import. Existing `marco tasks --lane`
continues to edit labels; its adoption of this API is separate integration work.

## Persistence, upgrade, and backup

The old version owned no durable records. Upgrade adds append-only migrations
to the plugin's `data.db`, through `bb.storage.database()` and
`bb.storage.migrate()`. No core Tasks database access or automatic live-data
migration occurs. Restart restores lane records, memberships, revisions, recent
changes, pending previews, and committed import receipts. The last 1,000 lane
changes are retained; older readers receive a snapshot reset.

Before an authorized upgrade/uninstall, take a consistent SQLite backup of
`<BB data dir>/plugins/better-tasks/data.db` using SQLite's backup facility.
A raw copy of only the database while WAL writes run may omit committed data.
Retain the backup outside the plugin directory; verify its integrity and test
restoration in an isolated installation. Plugin removal/data deletion may erase
lanes and receipts while leaving core tasks intact.

Integration belongs to the installation owner: review/merge the tested head,
back up plugin data, build/install that exact version through supported BB
commands, then verify stored lanes, assignments, and core task behavior. Keep
live label import separate and preview it against the intended mapping.
This feature PR does not authorize a live installation or migration.

| Path | What it is |
|---|---|
| `server.ts` | Plugin server: Tasks RPC adapter, RPC contract, change-feed service |
| `lib/sync.ts` | Loads the board and applies per-task changes to the cache |
| `lib/cache.ts` | The versioned row cache and its change log |
| `lib/feed.ts` | The realtime socket, filtered to Tasks signals, with reconnect |
| `lib/store.ts` | The page's copy of the board; merges snapshots and deltas by revision |
| `lib/view.ts` | Filtering, sorting and grouping |
| `lib/virtual.ts`, `components/virtual-list.tsx` | Windowing |
| `app.tsx`, `components/` | The page |

## License

MIT
