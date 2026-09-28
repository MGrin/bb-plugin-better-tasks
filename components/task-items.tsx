// One task as a list row and as a board card. Both are memoized on the row
// object, which the store replaces only when that task changes, so a delta
// re-renders exactly the rows it touched.
import { createContext, memo, useContext } from "react";
import { ColorDot, LiveDot } from "@/components/glyphs";
import { PriorityMenu, StatusMenu } from "@/components/menus";
import { shortAge } from "@/lib/format";
import type { Label, Priority, Project, Row, Status } from "@/lib/model";
import { cn } from "@/lib/utils";

export interface BoardActions {
  select(id: string): void;
  open(id: string): void;
  setStatus(id: string, status: Status): void;
  setPriority(id: string, priority: Priority): void;
}

export interface BoardLookup {
  projects: ReadonlyMap<string, Project>;
  labels: ReadonlyMap<string, Label>;
  showProject: boolean;
}

export const ActionsContext = createContext<BoardActions | null>(null);
export const LookupContext = createContext<BoardLookup>({
  projects: new Map(),
  labels: new Map(),
  showProject: true,
});

function useActions(): BoardActions {
  const actions = useContext(ActionsContext);
  if (actions === null) throw new Error("BoardActions missing");
  return actions;
}

function liveTitle(row: Row): string {
  return row.live.map((thread) => `${thread.liveStatus === "starting" ? "Starting" : "Working"}: ${thread.title}`).join("\n");
}

function LabelChips({ ids, max }: { ids: readonly string[]; max: number }) {
  const { labels } = useContext(LookupContext);
  if (ids.length === 0) return null;
  const shown = ids.slice(0, max);
  return (
    <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden">
      {shown.map((id) => {
        const label = labels.get(id);
        if (label === undefined) return null;
        return (
          <span
            key={id}
            className="inline-flex h-5 max-w-28 shrink-0 items-center gap-1 rounded-full border border-border px-1.5 text-[11px] leading-none text-muted-foreground"
          >
            <ColorDot color={label.color} className="size-1.5" />
            <span className="truncate">{label.name}</span>
          </span>
        );
      })}
      {ids.length > max ? (
        <span className="text-[11px] text-muted-foreground">+{ids.length - max}</span>
      ) : null}
    </span>
  );
}

function ProjectChip({ projectId }: { projectId: string }) {
  const { projects, showProject } = useContext(LookupContext);
  const project = projects.get(projectId);
  if (!showProject || project === undefined) return null;
  return (
    <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded px-1 font-mono text-[11px] text-muted-foreground" title={project.name}>
      <ColorDot color={project.color} className="size-1.5" />
      {project.prefix}
    </span>
  );
}

export const TaskRow = memo(function TaskRow({
  row,
  selected,
}: {
  row: Row;
  selected: boolean;
}) {
  const actions = useActions();
  return (
    <div
      role="row"
      aria-selected={selected}
      data-task-id={row.id}
      data-priority={row.priority}
      data-status={row.status}
      onClick={() => actions.select(row.id)}
      onDoubleClick={() => actions.open(row.id)}
      className={cn(
        "group flex h-10 cursor-default items-center gap-1.5 border-b border-border/50 pl-3 pr-4 text-sm select-none",
        selected ? "bg-state-active" : "hover:bg-state-hover",
      )}
    >
      <PriorityMenu priority={row.priority} onChange={(priority) => actions.setPriority(row.id, priority)} />
      <span className="w-[4.75rem] shrink-0 truncate font-mono text-xs text-muted-foreground">{row.key}</span>
      <StatusMenu status={row.status} onChange={(status) => actions.setStatus(row.id, status)} />
      <button
        type="button"
        tabIndex={-1}
        onClick={(event) => {
          event.stopPropagation();
          actions.open(row.id);
        }}
        className={cn(
          "min-w-0 flex-1 truncate text-left outline-none",
          row.status === "done" || row.status === "canceled" ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {row.title}
      </button>
      <LabelChips ids={row.labelIds} max={2} />
      {row.live.length > 0 ? (
        <span className="flex shrink-0 items-center gap-1 pl-1 text-[11px] text-emerald-600 dark:text-emerald-400" title={liveTitle(row)}>
          <LiveDot />
          {row.live.length > 1 ? row.live.length : null}
        </span>
      ) : null}
      <ProjectChip projectId={row.projectId} />
      <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground" title={row.updatedAt}>
        {shortAge(row.updatedAt)}
      </span>
    </div>
  );
});

export const CARD_SLOT = 112;

export const TaskCard = memo(function TaskCard({
  row,
  selected,
}: {
  row: Row;
  selected: boolean;
}) {
  const actions = useActions();
  return (
    <div className="px-2 pb-2">
      <div
        role="button"
        tabIndex={-1}
        draggable
        data-task-id={row.id}
        data-priority={row.priority}
        data-status={row.status}
        onDragStart={(event) => {
          event.dataTransfer.setData("application/x-better-tasks", row.id);
          event.dataTransfer.effectAllowed = "move";
        }}
        onClick={() => actions.select(row.id)}
        onDoubleClick={() => actions.open(row.id)}
        className={cn(
          "flex h-[104px] cursor-default flex-col rounded-lg border bg-card px-2.5 py-2 text-sm shadow-xs outline-none transition-colors select-none",
          selected ? "border-ring ring-1 ring-ring" : "border-border hover:border-foreground/25",
        )}
      >
        <div className="flex h-5 items-center gap-1">
          <PriorityMenu
            priority={row.priority}
            onChange={(priority) => actions.setPriority(row.id, priority)}
            className="-ml-1 size-5"
          />
          <span className="truncate font-mono text-[11px] text-muted-foreground">{row.key}</span>
          <span className="flex-1" />
          {row.live.length > 0 ? (
            <span title={liveTitle(row)} className="flex items-center">
              <LiveDot />
            </span>
          ) : null}
          <StatusMenu status={row.status} onChange={(status) => actions.setStatus(row.id, status)} className="-mr-1 size-5" />
        </div>
        <button
          type="button"
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            actions.open(row.id);
          }}
          className={cn(
            "mt-1 block min-h-0 text-left text-[13px] leading-[18px] outline-none",
            row.status === "done" || row.status === "canceled" ? "text-muted-foreground" : "text-foreground",
          )}
        >
          <span className="line-clamp-2 [overflow-wrap:anywhere]">{row.title}</span>
        </button>
        <div className="mt-auto flex h-5 items-center gap-1 overflow-hidden">
          <ProjectChip projectId={row.projectId} />
          <LabelChips ids={row.labelIds} max={1} />
          <span className="flex-1" />
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{shortAge(row.updatedAt)}</span>
        </div>
      </div>
    </div>
  );
});
