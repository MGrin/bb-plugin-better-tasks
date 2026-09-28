# Better Tasks

A fast task board for [bb](https://github.com/get-bb/bb). Every task in every
project, open work first, in a list or a board — and it stays fast when the
board holds thousands of tasks and agents are changing them all day.

It reads and writes through bb's built-in **Tasks** plugin. It keeps no data of
its own and never touches the Tasks database: your tasks stay where they are,
and both pages show the same board.

## What it does

- **Everything, open work first.** In progress, in review, todo and backlog
  load first. Done and canceled are one click away — collapsed groups in the
  list, collapsed columns on the board — never a wall of history.
- **List and board**, per project or across all of them.
- **Search** over key and title as you type, plus the task descriptions
  (searched by the Tasks plugin, shown as `+N`).
- **Filters** by project, status, priority, label and "agent working now".
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
npm test            # node --test over test/*.test.ts
npm run typecheck   # tsc --noEmit
bb plugin build .   # dist/ bundles
bb plugin reload better-tasks
```

Tests use synthetic tasks only.

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
