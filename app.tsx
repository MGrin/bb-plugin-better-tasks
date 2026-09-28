// better-tasks — frontend entry.
//
// Every task, open work first. The page renders only the rows on screen,
// applies per-task deltas from the server, and never reloads the board.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_usePluginId,
  useBbNavigate,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DetailPane } from "@/components/detail-pane";
import { STATUS_MENU_ORDER } from "@/components/menus";
import {
  ActionsContext,
  LookupContext,
  type BoardActions,
  type BoardLookup,
} from "@/components/task-items";
import { Toolbar, type ViewMode } from "@/components/toolbar";
import { useBoard } from "@/components/use-board";
import { BoardView, ListView } from "@/components/views";
import {
  CLOSED_STATUSES,
  OPEN_STATUSES,
  PRIORITIES,
  STATUSES,
  type Priority,
  type Status,
} from "@/lib/model";
import {
  DEFAULT_FILTERS,
  flattenGroups,
  groupRows,
  parseFilters,
  visibleStatuses,
  type Filters,
  type ListItem,
} from "@/lib/view";

const PANEL_PATH = "board";

interface UiState {
  filters: Filters;
  view: ViewMode;
  listCollapsed: Status[];
  boardCollapsed: Status[];
}

const DEFAULT_UI: UiState = {
  filters: DEFAULT_FILTERS,
  view: "list",
  listCollapsed: ["done", "canceled"],
  boardCollapsed: ["done", "canceled"],
};

function readUi(storageKey: string): UiState {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Partial<UiState> | null;
    if (raw === null || typeof raw !== "object") return DEFAULT_UI;
    const statuses = (value: unknown, fallback: Status[]) =>
      Array.isArray(value) ? value.filter((item): item is Status => STATUSES.includes(item as Status)) : fallback;
    return {
      filters: parseFilters(raw.filters),
      view: raw.view === "board" ? "board" : "list",
      listCollapsed: statuses(raw.listCollapsed, DEFAULT_UI.listCollapsed),
      boardCollapsed: statuses(raw.boardCollapsed, DEFAULT_UI.boardCollapsed),
    };
  } catch {
    return DEFAULT_UI;
  }
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.closest("[role=menu],[role=dialog],[role=listbox]") !== null
  );
}

const SHORTCUTS: [string, string][] = [
  ["j / ↓", "Next task"],
  ["k / ↑", "Previous task"],
  ["h / l", "Previous / next column (board)"],
  ["Enter", "Open task"],
  ["Esc", "Close task / clear selection"],
  ["/", "Search"],
  ["v", "Switch list / board"],
  ["1 – 6", "Set status: backlog, todo, in progress, in review, done, canceled"],
  ["⇧1 – ⇧5", "Set priority: urgent, high, medium, low, none"],
  ["?", "This help"],
];

function BoardPage({ subPath }: PluginNavPanelProps) {
  const pluginId = experimental_usePluginId();
  const storageKey = `${pluginId}:ui:v1`;
  const navigate = useBbNavigate();
  const { rpc, store, revision, metrics, error, retry } = useBoard();
  const [ui, setUi] = useState<UiState>(() => readUi(storageKey));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [descriptionHits, setDescriptionHits] = useState<ReadonlySet<string> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(ui));
    } catch {
      // Storage full or disabled: filters just do not persist.
    }
  }, [storageKey, ui]);

  const { filters, view } = ui;
  const setFilters = useCallback((next: Filters) => setUi((current) => ({ ...current, filters: next })), []);
  const setView = useCallback((next: ViewMode) => setUi((current) => ({ ...current, view: next })), []);

  // Descriptions are not on the board; ask the Tasks plugin to search them.
  useEffect(() => {
    const query = filters.search.trim();
    if (query.length < 3) {
      setDescriptionHits(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      rpc.call("search", { query }).then(
        (result) => !cancelled && setDescriptionHits(new Set(result.ids)),
        () => !cancelled && setDescriptionHits(null),
      );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [filters.search, rpc]);

  // Derived views. `revision` changes whenever any row does.
  const groups = useMemo(
    () => groupRows(store.rows.values(), filters, descriptionHits ?? undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revision, filters, descriptionHits],
  );
  const statuses = useMemo(() => visibleStatuses(filters), [filters]);
  const listCollapsed = useMemo(() => new Set(ui.listCollapsed), [ui.listCollapsed]);
  const boardCollapsed = useMemo(() => new Set(ui.boardCollapsed), [ui.boardCollapsed]);
  const closedLoading = !store.closedLoaded;
  const allCounts = useMemo(() => store.countsByStatus(), [store, revision]);
  const filtered =
    filters.search !== "" ||
    filters.projectIds.length + filters.priorities.length + filters.labelIds.length > 0 ||
    filters.liveOnly;

  const columnCounts = useMemo(() => {
    const counts = {} as Record<Status, number>;
    for (const status of STATUSES) {
      counts[status] =
        closedLoading && CLOSED_STATUSES.includes(status) && !filtered
          ? allCounts[status]
          : groups[status].length;
    }
    return counts;
  }, [groups, allCounts, closedLoading, filtered]);

  const loadingStatuses = useMemo(
    () => new Set<Status>(closedLoading ? CLOSED_STATUSES : []),
    [closedLoading],
  );

  const items = useMemo(() => {
    const flat = flattenGroups(groups, statuses, listCollapsed);
    if (closedLoading && !filtered) {
      // Show the closed groups (collapsed, counted) before their rows arrive.
      for (const status of CLOSED_STATUSES) {
        if (statuses.includes(status) && groups[status].length === 0 && allCounts[status] > 0) {
          flat.push({ kind: "header", status, count: allCounts[status], collapsed: true });
        }
      }
    }
    return flat;
  }, [groups, statuses, listCollapsed, closedLoading, filtered, allCounts]);

  const rowIndex = useMemo(() => {
    const index = new Map<string, number>();
    items.forEach((item, position) => item.kind === "row" && index.set(item.row.id, position));
    return index;
  }, [items]);

  const lookup = useMemo<BoardLookup>(
    () => ({
      projects: new Map(store.projects.map((project) => [project.id, project])),
      labels: new Map(store.labels.map((label) => [label.id, label])),
      showProject: filters.projectIds.length !== 1,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store.projects, store.labels, filters.projectIds.length],
  );

  const openCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of store.rows.values()) {
      if (OPEN_STATUSES.includes(row.status)) counts.set(row.projectId, (counts.get(row.projectId) ?? 0) + 1);
    }
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  // Deep link: /plugins/<id>/board/task/<KEY> opens that task.
  const detailKey = subPath.startsWith("task/") ? decodeURIComponent(subPath.slice(5)) : null;
  const detailId = useMemo(() => {
    if (detailKey === null) return null;
    for (const row of store.rows.values()) if (row.key === detailKey) return row.id;
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailKey, revision]);

  useEffect(() => {
    if (detailId !== null) setSelectedId(detailId);
  }, [detailId]);

  const openTask = useCallback(
    (id: string | null) => {
      const row = id === null ? undefined : store.rows.get(id);
      if (row) setSelectedId(row.id);
      navigate.toPluginPanel(PANEL_PATH, { subPath: row ? `task/${encodeURIComponent(row.key)}` : "", replace: true });
    },
    [navigate, store],
  );

  const detailOpen = detailKey !== null;
  const detailOpenRef = useRef(detailOpen);
  detailOpenRef.current = detailOpen;

  const actions = useMemo<BoardActions>(() => {
    const write = (id: string, patch: { status?: Status; priority?: Priority }) => {
      const rollback = store.optimistic(id, patch);
      rpc.call("update", { taskId: id, ...patch }).then(
        ({ row }) => row && store.upsertRow(row),
        (cause: unknown) => {
          rollback();
          toast.error(`Could not update task: ${cause instanceof Error ? cause.message : String(cause)}`);
        },
      );
    };
    return {
      select: (id) => {
        setSelectedId(id);
        if (detailOpenRef.current) openTask(id);
      },
      open: (id) => openTask(id),
      setStatus: (id, status) => write(id, { status }),
      setPriority: (id, priority) => write(id, { priority }),
    };
  }, [rpc, store, openTask]);

  const moveTask = useCallback(
    (taskId: string, status: Status) => {
      const row = store.rows.get(taskId);
      if (!row || row.status === status) return;
      const rollback = store.optimistic(taskId, { status });
      rpc.call("move", { taskId, status }).then(
        (result) => result.row && store.upsertRow(result.row),
        (cause: unknown) => {
          rollback();
          toast.error(`Could not move task: ${cause instanceof Error ? cause.message : String(cause)}`);
        },
      );
    },
    [rpc, store],
  );

  const toggleList = useCallback(
    (status: Status) =>
      setUi((current) => ({
        ...current,
        listCollapsed: current.listCollapsed.includes(status)
          ? current.listCollapsed.filter((item) => item !== status)
          : [...current.listCollapsed, status],
      })),
    [],
  );
  const toggleBoard = useCallback(
    (status: Status) =>
      setUi((current) => ({
        ...current,
        boardCollapsed: current.boardCollapsed.includes(status)
          ? current.boardCollapsed.filter((item) => item !== status)
          : [...current.boardCollapsed, status],
      })),
    [],
  );

  const selectedRow = selectedId === null ? undefined : store.rows.get(selectedId);
  const selectedStatus = selectedRow?.status ?? null;
  const boardIndex = selectedRow ? groups[selectedRow.status].indexOf(selectedRow) : -1;

  // Keyboard: one listener for the page.
  const keyState = useRef({ items, groups, statuses, boardCollapsed, selectedId, view, detailOpen });
  keyState.current = { items, groups, statuses, boardCollapsed, selectedId, view, detailOpen };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target)) return;
      const state = keyState.current;
      const select = (id: string | undefined) => {
        if (id === undefined) return;
        event.preventDefault();
        actions.select(id);
      };
      const current = state.selectedId === null ? undefined : store.rows.get(state.selectedId);

      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (event.key === "?") {
        event.preventDefault();
        setHelpOpen(true);
        return;
      }
      if (event.key === "v") {
        event.preventDefault();
        setView(state.view === "list" ? "board" : "list");
        return;
      }
      if (event.key === "Escape") {
        if (state.detailOpen) {
          event.preventDefault();
          openTask(null);
        } else if (state.selectedId !== null) {
          event.preventDefault();
          setSelectedId(null);
        }
        return;
      }
      if (event.key === "Enter" || event.key === "o") {
        if (current) {
          event.preventDefault();
          openTask(current.id);
        }
        return;
      }
      if (/^Digit[1-6]$/u.test(event.code) && current) {
        const digit = Number(event.code.slice(5)) - 1;
        event.preventDefault();
        if (event.shiftKey) {
          const priority = PRIORITIES[digit];
          if (priority && priority !== current.priority) actions.setPriority(current.id, priority);
        } else {
          const status = STATUS_MENU_ORDER[digit];
          if (status && status !== current.status) actions.setStatus(current.id, status);
        }
        return;
      }

      const down = event.key === "j" || event.key === "ArrowDown";
      const up = event.key === "k" || event.key === "ArrowUp";
      const left = event.key === "h" || event.key === "ArrowLeft";
      const right = event.key === "l" || event.key === "ArrowRight";
      if (!down && !up && !left && !right) return;

      if (state.view === "list") {
        if (!down && !up) return;
        const rows = state.items.filter((item): item is Extract<ListItem, { kind: "row" }> => item.kind === "row");
        if (rows.length === 0) return;
        const at = current ? rows.findIndex((item) => item.row.id === current.id) : -1;
        const next = at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + (down ? 1 : -1)));
        select(rows[next]?.row.id);
        return;
      }

      const columns = state.statuses.filter(
        (status) => !state.boardCollapsed.has(status) && state.groups[status].length > 0,
      );
      if (columns.length === 0) return;
      const column = current && columns.includes(current.status) ? current.status : columns[0]!;
      const rows = state.groups[column];
      const at = current ? rows.indexOf(current) : -1;
      if (down || up) {
        const next = at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + (down ? 1 : -1)));
        select(rows[next]?.id);
      } else {
        const columnAt = columns.indexOf(column) + (right ? 1 : -1);
        const target = columns[Math.min(columns.length - 1, Math.max(0, columnAt))]!;
        const targetRows = state.groups[target];
        select(targetRows[Math.min(Math.max(at, 0), targetRows.length - 1)]?.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, openTask, setView, store]);

  const total = store.closedLoaded ? store.rows.size : Object.values(allCounts).reduce((sum, value) => sum + value, 0);
  const shownOpen = OPEN_STATUSES.reduce((sum, status) => sum + groups[status].length, 0);
  const detailRow = detailId === null ? undefined : store.rows.get(detailId);
  const firstLoad = store.version < 0;
  const nothingShown = !firstLoad && items.length === 0;

  return (
    <ActionsContext.Provider value={actions}>
      <LookupContext.Provider value={lookup}>
        <div className="flex h-full min-h-0 flex-1 flex-col bg-background" data-better-tasks-view={view}>
          <Toolbar
            ref={searchRef}
            filters={filters}
            onFilters={setFilters}
            view={view}
            onView={setView}
            projects={store.projects}
            labels={store.labels}
            openCounts={openCounts}
            shownOpen={shownOpen}
            total={total}
            descriptionHits={
              descriptionHits === null
                ? null
                : [...descriptionHits].filter((id) => {
                    const row = store.rows.get(id);
                    return row !== undefined && !`${row.key} ${row.title}`.toLowerCase().includes(filters.search.toLowerCase().trim());
                  }).length
            }
            onHelp={() => setHelpOpen(true)}
          />
          <div className="flex min-h-0 flex-1">
            <main className="flex min-w-0 flex-1 flex-col" aria-busy={firstLoad}>
              {error !== null ? (
                <div role="alert" className="m-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm">
                  <p className="text-destructive">Could not load tasks: {error}</p>
                  <button type="button" onClick={retry} className="mt-2 text-muted-foreground underline underline-offset-2 hover:text-foreground">
                    Try again
                  </button>
                </div>
              ) : firstLoad ? (
                <div className="flex-1 overflow-hidden" aria-label="Loading tasks">
                  {Array.from({ length: 12 }, (_, index) => (
                    <div key={index} className="flex h-10 items-center gap-3 border-b border-border/50 px-4">
                      <div className="size-3.5 animate-pulse rounded-full bg-state-hover" />
                      <div className="h-3 w-14 animate-pulse rounded bg-state-hover" />
                      <div className="h-3 animate-pulse rounded bg-state-hover" style={{ width: `${30 + ((index * 37) % 45)}%` }} />
                    </div>
                  ))}
                </div>
              ) : nothingShown ? (
                <div className="m-4 rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                  No tasks match.
                  {filtered || filters.statuses.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => setFilters({ ...DEFAULT_FILTERS, sort: filters.sort })}
                      className="ml-2 underline underline-offset-2 hover:text-foreground"
                    >
                      Clear filters
                    </button>
                  ) : null}
                </div>
              ) : view === "list" ? (
                <ListView
                  items={items}
                  selectedId={selectedId}
                  revealIndex={selectedId === null ? null : (rowIndex.get(selectedId) ?? null)}
                  closedLoading={closedLoading}
                  onToggleGroup={toggleList}
                />
              ) : (
                <BoardView
                  groups={groups}
                  statuses={statuses}
                  counts={columnCounts}
                  loading={loadingStatuses}
                  collapsed={boardCollapsed}
                  selectedId={selectedId}
                  selectedStatus={selectedStatus}
                  selectedIndex={boardIndex >= 0 ? boardIndex : null}
                  onToggle={toggleBoard}
                  onDropTask={moveTask}
                />
              )}
            </main>
            {detailOpen ? (
              detailId === null ? (
                <aside className="flex w-[min(480px,45%)] min-w-80 shrink-0 items-center justify-center border-l border-border text-sm text-muted-foreground">
                  {store.closedLoaded ? `No task ${detailKey}` : "Loading…"}
                </aside>
              ) : (
                <DetailPane
                  key={detailId}
                  taskId={detailId}
                  row={detailRow}
                  rows={store.rows}
                  project={detailRow ? lookup.projects.get(detailRow.projectId) : undefined}
                  labels={lookup.labels}
                  rpc={rpc}
                  actions={actions}
                  onClose={() => openTask(null)}
                />
              )
            ) : null}
          </div>
        </div>
        <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Keyboard shortcuts</DialogTitle>
              <DialogDescription>Work the board without the mouse.</DialogDescription>
            </DialogHeader>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              {SHORTCUTS.map(([keys, what]) => (
                <div key={keys} className="contents">
                  <dt>
                    <kbd className="rounded border border-border bg-surface-recessed-solid px-1.5 py-0.5 font-mono text-xs">{keys}</kbd>
                  </dt>
                  <dd className="text-muted-foreground">{what}</dd>
                </div>
              ))}
            </dl>
          </DialogContent>
        </Dialog>
        <span hidden data-metrics-open-rows={metrics.openRows} />
      </LookupContext.Provider>
    </ActionsContext.Provider>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "board",
    title: "Better Tasks",
    icon: "ListTodo",
    path: PANEL_PATH,
    component: BoardPage,
  });
});
