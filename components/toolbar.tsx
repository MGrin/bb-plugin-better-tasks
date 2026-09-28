// The bar above the board: scope, filters, sort, view and search.
import { forwardRef, type ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { ColorDot, LiveDot, PriorityGlyph, StatusGlyph } from "@/components/glyphs";
import { STATUS_MENU_ORDER } from "@/components/menus";
import { formatCount } from "@/lib/format";
import {
  PRIORITIES,
  PRIORITY_LABEL,
  STATUS_LABEL,
  type Label,
  type Project,
} from "@/lib/model";
import type { Filters, SortKey } from "@/lib/view";
import { cn } from "@/lib/utils";

export type ViewMode = "list" | "board";

const SORT_LABEL: Record<SortKey, string> = {
  priority: "Priority",
  updated: "Last updated",
  created: "Newest",
  manual: "Manual order",
};

function toggle<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function ToolbarButton({
  children,
  active,
  className,
  ...props
}: React.ComponentProps<"button"> & { active?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-muted-foreground outline-none transition-colors hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-state-active data-[state=open]:text-foreground",
        active && "text-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

function Menu({
  trigger,
  children,
  label,
  active,
  align = "start",
}: {
  trigger: ReactNode;
  children: ReactNode;
  label: string;
  active?: boolean;
  align?: "start" | "end";
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ToolbarButton aria-label={label} active={active}>
          {trigger}
        </ToolbarButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="max-h-[70vh] min-w-56 overflow-y-auto">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface ToolbarProps {
  filters: Filters;
  onFilters: (next: Filters) => void;
  view: ViewMode;
  onView: (view: ViewMode) => void;
  projects: readonly Project[];
  labels: readonly Label[];
  openCounts: ReadonlyMap<string, number>;
  shownOpen: number;
  total: number;
  descriptionHits: number | null;
  onHelp: () => void;
}

export const Toolbar = forwardRef<HTMLInputElement, ToolbarProps>(function Toolbar(
  {
    filters,
    onFilters,
    view,
    onView,
    projects,
    labels,
    openCounts,
    shownOpen,
    total,
    descriptionHits,
    onHelp,
  },
  searchRef,
) {
  const set = (patch: Partial<Filters>) => onFilters({ ...filters, ...patch });
  const scopedProjects = projects.filter((project) => filters.projectIds.includes(project.id));
  const scopeLabel =
    scopedProjects.length === 0
      ? "All projects"
      : scopedProjects.length === 1
        ? scopedProjects[0]!.name
        : `${scopedProjects.length} projects`;
  const labelChoices =
    filters.projectIds.length === 0
      ? labels
      : labels.filter((label) => filters.projectIds.includes(label.projectId));
  const filterCount =
    filters.statuses.length +
    filters.priorities.length +
    filters.labelIds.length +
    (filters.liveOnly ? 1 : 0);
  const projectById = new Map(projects.map((project) => [project.id, project]));

  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-3">
      <Menu
        label="Projects"
        active={scopedProjects.length > 0}
        trigger={
          <>
            {scopedProjects.length === 1 ? (
              <ColorDot color={scopedProjects[0]!.color} />
            ) : (
              <Icon name="Layers" className="size-3.5" />
            )}
            <span className="max-w-40 truncate font-medium text-foreground">{scopeLabel}</span>
            <Icon name="ChevronDown" className="size-3 opacity-60" />
          </>
        }
      >
        <DropdownMenuCheckboxItem
          checked={filters.projectIds.length === 0}
          onCheckedChange={() => set({ projectIds: [], labelIds: [] })}
          onSelect={(event) => event.preventDefault()}
        >
          <Icon name="Layers" className="size-3.5" />
          <span className="flex-1">All projects</span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {projects.map((project) => (
          <DropdownMenuCheckboxItem
            key={project.id}
            checked={filters.projectIds.includes(project.id)}
            onCheckedChange={() => set({ projectIds: toggle(filters.projectIds, project.id) })}
            onSelect={(event) => event.preventDefault()}
          >
            <ColorDot color={project.color} />
            <span className="flex-1 truncate">{project.name}</span>
            <span className="font-mono text-[11px] text-muted-foreground">{project.prefix}</span>
            <span className="w-8 text-right text-[11px] tabular-nums text-muted-foreground">
              {formatCount(openCounts.get(project.id) ?? 0)}
            </span>
          </DropdownMenuCheckboxItem>
        ))}
      </Menu>

      <div className="mx-1 h-5 w-px bg-border" />

      <div className="flex shrink-0 items-center rounded-md bg-surface-recessed-solid p-0.5" role="group" aria-label="View">
        {(["list", "board"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={view === mode}
            onClick={() => onView(mode)}
            title={`${mode === "list" ? "List" : "Board"} (v)`}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded px-2 text-[13px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
              view === mode && "bg-background text-foreground shadow-xs",
            )}
          >
            <Icon name={mode === "list" ? "ListView" : "Columns2"} className="size-3.5" />
            {mode === "list" ? "List" : "Board"}
          </button>
        ))}
      </div>

      <Menu
        label="Filter"
        active={filterCount > 0}
        trigger={
          <>
            <Icon name="FilterHorizontal" className="size-3.5" />
            Filter
            {filterCount > 0 ? (
              <span className="rounded bg-state-active px-1 text-[11px] tabular-nums text-foreground">{filterCount}</span>
            ) : null}
          </>
        }
      >
        <DropdownMenuLabel>Status</DropdownMenuLabel>
        {STATUS_MENU_ORDER.map((status) => (
          <DropdownMenuCheckboxItem
            key={status}
            checked={filters.statuses.includes(status)}
            onCheckedChange={() => set({ statuses: toggle(filters.statuses, status) })}
            onSelect={(event) => event.preventDefault()}
          >
            <StatusGlyph status={status} />
            {STATUS_LABEL[status]}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Priority</DropdownMenuLabel>
        {PRIORITIES.map((priority) => (
          <DropdownMenuCheckboxItem
            key={priority}
            checked={filters.priorities.includes(priority)}
            onCheckedChange={() => set({ priorities: toggle(filters.priorities, priority) })}
            onSelect={(event) => event.preventDefault()}
          >
            <PriorityGlyph priority={priority} />
            {PRIORITY_LABEL[priority]}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={filters.liveOnly}
          onCheckedChange={() => set({ liveOnly: !filters.liveOnly })}
          onSelect={(event) => event.preventDefault()}
        >
          <LiveDot />
          Agent working now
        </DropdownMenuCheckboxItem>
        {labelChoices.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Labels</DropdownMenuLabel>
            {labelChoices.map((label) => (
              <DropdownMenuCheckboxItem
                key={label.id}
                checked={filters.labelIds.includes(label.id)}
                onCheckedChange={() => set({ labelIds: toggle(filters.labelIds, label.id) })}
                onSelect={(event) => event.preventDefault()}
              >
                <ColorDot color={label.color} />
                <span className="flex-1 truncate">{label.name}</span>
                {filters.projectIds.length !== 1 ? (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {projectById.get(label.projectId)?.prefix}
                  </span>
                ) : null}
              </DropdownMenuCheckboxItem>
            ))}
          </>
        ) : null}
        {filterCount > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={false}
              onCheckedChange={() => set({ statuses: [], priorities: [], labelIds: [], liveOnly: false })}
            >
              <Icon name="X" className="size-3.5" />
              Clear filters
            </DropdownMenuCheckboxItem>
          </>
        ) : null}
      </Menu>

      <Menu
        label="Sort"
        trigger={
          <>
            <Icon name="ArrowUpDown" className="size-3.5" />
            {SORT_LABEL[filters.sort]}
          </>
        }
      >
        <DropdownMenuLabel>Sort open work by</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={filters.sort} onValueChange={(value) => set({ sort: value as SortKey })}>
          {(Object.keys(SORT_LABEL) as SortKey[]).map((key) => (
            <DropdownMenuRadioItem key={key} value={key}>
              {SORT_LABEL[key]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </Menu>

      <span className="ml-2 hidden shrink-0 text-xs tabular-nums text-muted-foreground lg:inline">
        {formatCount(shownOpen)} open · {formatCount(total)} total
      </span>

      <div className="flex-1" />

      <label className="relative flex h-8 w-64 min-w-40 shrink items-center rounded-md border border-input bg-transparent focus-within:ring-1 focus-within:ring-ring">
        <Icon name="Search" className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" />
        <input
          ref={searchRef}
          value={filters.search}
          onChange={(event) => set({ search: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              if (filters.search !== "") set({ search: "" });
              else event.currentTarget.blur();
            }
            if (event.key === "ArrowDown" || event.key === "Enter") event.currentTarget.blur();
          }}
          placeholder="Search tasks"
          aria-label="Search tasks"
          className="h-full min-w-0 flex-1 bg-transparent pl-8 pr-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
        />
        {filters.search !== "" ? (
          <>
            {descriptionHits !== null && descriptionHits > 0 ? (
              <span className="shrink-0 pr-1 text-[11px] text-muted-foreground" title="Matches found in task descriptions">
                +{descriptionHits}
              </span>
            ) : null}
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => set({ search: "" })}
              className="mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-state-hover"
            >
              <Icon name="X" className="size-3.5" />
            </button>
          </>
        ) : (
          <kbd className="mr-2 shrink-0 rounded border border-border px-1 font-mono text-[10px] text-muted-foreground">/</kbd>
        )}
      </label>

      <ToolbarButton aria-label="Keyboard shortcuts" onClick={onHelp} className="px-2">
        <Icon name="CircleQuestion" className="size-4" />
      </ToolbarButton>
    </div>
  );
});
