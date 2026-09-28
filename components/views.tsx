// The list view (one virtual list, grouped by status) and the board view
// (one virtual list per status column).
import { memo, useCallback, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { StatusGlyph } from "@/components/glyphs";
import { CARD_SLOT, TaskCard, TaskRow } from "@/components/task-items";
import { VirtualList } from "@/components/virtual-list";
import { formatCount } from "@/lib/format";
import { STATUS_LABEL, type Row, type Status } from "@/lib/model";
import { itemHeight, type Groups, type ListItem } from "@/lib/view";
import { cn } from "@/lib/utils";

const GroupHeader = memo(function GroupHeader({
  status,
  count,
  collapsed,
  loading,
  onToggle,
}: {
  status: Status;
  count: number;
  collapsed: boolean;
  loading: boolean;
  onToggle: (status: Status) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(status)}
      aria-expanded={!collapsed}
      className="flex h-9 w-full items-center gap-2 border-b border-border bg-surface-recessed-solid px-3 text-left text-[13px] font-medium text-foreground outline-none hover:bg-state-hover focus-visible:bg-state-hover"
    >
      <Icon
        name="ChevronRight"
        className={cn("size-3.5 text-muted-foreground transition-transform duration-150", !collapsed && "rotate-90")}
      />
      <StatusGlyph status={status} />
      <span>{STATUS_LABEL[status]}</span>
      <span className="tabular-nums text-muted-foreground">{formatCount(count)}</span>
      {collapsed ? <span className="ml-auto text-xs font-normal text-muted-foreground">{loading ? "Loading…" : "Show"}</span> : null}
    </button>
  );
});

export function ListView({
  items,
  selectedId,
  revealIndex,
  closedLoading,
  onToggleGroup,
}: {
  items: readonly ListItem[];
  selectedId: string | null;
  revealIndex: number | null;
  closedLoading: boolean;
  onToggleGroup: (status: Status) => void;
}) {
  const render = useCallback(
    (item: ListItem) =>
      item.kind === "header" ? (
        <GroupHeader
          status={item.status}
          count={item.count}
          collapsed={item.collapsed}
          loading={closedLoading && (item.status === "done" || item.status === "canceled")}
          onToggle={onToggleGroup}
        />
      ) : (
        <TaskRow row={item.row} selected={item.row.id === selectedId} />
      ),
    [selectedId, closedLoading, onToggleGroup],
  );
  return (
    <VirtualList
      items={items}
      heightOf={itemHeight}
      keyOf={listKey}
      render={render}
      revealIndex={revealIndex}
      endPadding={48}
      label="Tasks"
      className="flex-1"
    />
  );
}

function listKey(item: ListItem): string {
  return item.kind === "header" ? `h:${item.status}` : item.row.id;
}

function cardHeight(): number {
  return CARD_SLOT;
}

function rowKey(row: Row): string {
  return row.id;
}

const BoardColumn = memo(function BoardColumn({
  status,
  rows,
  count,
  loading,
  collapsed,
  selectedId,
  revealIndex,
  onToggle,
  onDropTask,
}: {
  status: Status;
  rows: readonly Row[];
  count: number;
  loading: boolean;
  collapsed: boolean;
  selectedId: string | null;
  revealIndex: number | null;
  onToggle: (status: Status) => void;
  onDropTask: (taskId: string, status: Status) => void;
}) {
  const [over, setOver] = useState(false);
  const dropProps = {
    onDragOver: (event: React.DragEvent) => {
      if (!event.dataTransfer.types.includes("application/x-better-tasks")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (!over) setOver(true);
    },
    onDragLeave: (event: React.DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      setOver(false);
      const taskId = event.dataTransfer.getData("application/x-better-tasks");
      if (taskId !== "") onDropTask(taskId, status);
    },
  };
  const render = useCallback(
    (row: Row) => <TaskCard row={row} selected={row.id === selectedId} />,
    [selectedId],
  );
  if (collapsed) {
    return (
      <button
        type="button"
        {...dropProps}
        onClick={() => onToggle(status)}
        title={`Show ${STATUS_LABEL[status]}`}
        className={cn(
          "flex w-10 shrink-0 flex-col items-center gap-2 rounded-lg border border-transparent py-3 text-[13px] text-muted-foreground outline-none hover:bg-state-hover focus-visible:bg-state-hover",
          over && "border-ring bg-state-hover",
        )}
      >
        <StatusGlyph status={status} />
        <span className="tabular-nums">{formatCount(count)}</span>
        <span className="[writing-mode:vertical-rl]">{STATUS_LABEL[status]}</span>
      </button>
    );
  }
  return (
    <section
      {...dropProps}
      aria-label={STATUS_LABEL[status]}
      className={cn(
        "flex w-72 shrink-0 flex-col rounded-lg border border-transparent bg-surface-recessed-solid",
        over && "border-ring",
      )}
    >
      <header className="flex h-10 shrink-0 items-center gap-2 px-3 text-[13px] font-medium">
        <StatusGlyph status={status} />
        <span>{STATUS_LABEL[status]}</span>
        <span className="tabular-nums text-muted-foreground">{formatCount(count)}</span>
        <button
          type="button"
          onClick={() => onToggle(status)}
          aria-label={`Collapse ${STATUS_LABEL[status]}`}
          className="ml-auto inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-state-hover"
        >
          <Icon name="ChevronLeft" className="size-3.5" />
        </button>
      </header>
      {rows.length === 0 ? (
        <div className="mx-2 rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          {loading ? "Loading…" : "Nothing here"}
        </div>
      ) : (
        <VirtualList
          items={rows}
          heightOf={cardHeight}
          keyOf={rowKey}
          render={render}
          revealIndex={revealIndex}
          overscan={4}
          endPadding={8}
          label={STATUS_LABEL[status]}
          className="flex-1"
        />
      )}
    </section>
  );
});

export function BoardView({
  groups,
  statuses,
  counts,
  loading,
  collapsed,
  selectedId,
  selectedStatus,
  selectedIndex,
  onToggle,
  onDropTask,
}: {
  groups: Groups;
  statuses: readonly Status[];
  counts: Record<Status, number>;
  loading: ReadonlySet<Status>;
  collapsed: ReadonlySet<Status>;
  selectedId: string | null;
  selectedStatus: Status | null;
  selectedIndex: number | null;
  onToggle: (status: Status) => void;
  onDropTask: (taskId: string, status: Status) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto p-3">
      {statuses.map((status) => (
        <BoardColumn
          key={status}
          status={status}
          rows={groups[status]}
          count={counts[status]}
          loading={loading.has(status)}
          collapsed={collapsed.has(status)}
          selectedId={selectedStatus === status ? selectedId : null}
          revealIndex={selectedStatus === status ? selectedIndex : null}
          onToggle={onToggle}
          onDropTask={onDropTask}
        />
      ))}
    </div>
  );
}
