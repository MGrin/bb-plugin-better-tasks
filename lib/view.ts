// Filtering, sorting and grouping. Pure functions over rows, so the page can
// recompute a 5,000-row view in a few milliseconds and tests can pin it.
import {
  PRIORITIES,
  STATUSES,
  type Priority,
  type Row,
  type Status,
} from "./model.ts";

export type SortKey = "priority" | "updated" | "created" | "manual";

export interface Filters {
  projectIds: string[];
  statuses: Status[];
  priorities: Priority[];
  labelIds: string[];
  liveOnly: boolean;
  search: string;
  sort: SortKey;
}

export const DEFAULT_FILTERS: Filters = {
  projectIds: [],
  statuses: [],
  priorities: [],
  labelIds: [],
  liveOnly: false,
  search: "",
  sort: "priority",
};

const PRIORITY_RANK: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

const haystacks = new WeakMap<Row, string>();

function haystack(row: Row): string {
  let text = haystacks.get(row);
  if (text === undefined) {
    text = `${row.key} ${row.title}`.toLowerCase();
    haystacks.set(row, text);
  }
  return text;
}

export function searchTerms(search: string): string[] {
  return search.toLowerCase().split(/\s+/u).filter((term) => term.length > 0);
}

/**
 * Whether a row passes the filters. `extraMatches` are ids the server found
 * by description search; they satisfy the search terms on their own.
 */
export function matches(
  row: Row,
  filters: Filters,
  terms: readonly string[],
  extraMatches?: ReadonlySet<string>,
): boolean {
  if (filters.projectIds.length > 0 && !filters.projectIds.includes(row.projectId)) {
    return false;
  }
  if (filters.statuses.length > 0 && !filters.statuses.includes(row.status)) return false;
  if (filters.priorities.length > 0 && !filters.priorities.includes(row.priority)) {
    return false;
  }
  if (
    filters.labelIds.length > 0 &&
    !filters.labelIds.some((labelId) => row.labelIds.includes(labelId))
  ) {
    return false;
  }
  if (filters.liveOnly && row.live.length === 0) return false;
  if (terms.length > 0) {
    const text = haystack(row);
    if (!terms.every((term) => text.includes(term)) && !extraMatches?.has(row.id)) {
      return false;
    }
  }
  return true;
}

function byUpdated(a: Row, b: Row): number {
  return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
}

export function comparator(sort: SortKey, closed: boolean): (a: Row, b: Row) => number {
  // Closed work is read as history: most recently finished first, unless
  // the reader asked for creation order.
  if (closed && sort !== "created") return byUpdated;
  switch (sort) {
    case "updated":
      return byUpdated;
    case "created":
      return (a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);
    case "manual":
      return (a, b) => a.position - b.position || a.number - b.number;
    case "priority":
      return (a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || byUpdated(a, b);
  }
}

export type Groups = Record<Status, Row[]>;

export function emptyGroups(): Groups {
  return {
    in_progress: [],
    in_review: [],
    todo: [],
    backlog: [],
    done: [],
    canceled: [],
  };
}

export function groupRows(
  rows: Iterable<Row>,
  filters: Filters,
  extraMatches?: ReadonlySet<string>,
): Groups {
  const terms = searchTerms(filters.search);
  const groups = emptyGroups();
  for (const row of rows) {
    if (matches(row, filters, terms, extraMatches)) groups[row.status].push(row);
  }
  for (const status of STATUSES) {
    groups[status].sort(comparator(filters.sort, status === "done" || status === "canceled"));
  }
  return groups;
}

export type ListItem =
  | { kind: "header"; status: Status; count: number; collapsed: boolean }
  | { kind: "row"; row: Row };

export const HEADER_HEIGHT = 36;
export const ROW_HEIGHT = 40;

/** The list view as one flat, virtualizable sequence. */
export function flattenGroups(
  groups: Groups,
  visible: readonly Status[],
  collapsed: ReadonlySet<Status>,
): ListItem[] {
  const items: ListItem[] = [];
  for (const status of visible) {
    const rows = groups[status];
    if (rows.length === 0) continue;
    const isCollapsed = collapsed.has(status);
    items.push({ kind: "header", status, count: rows.length, collapsed: isCollapsed });
    if (!isCollapsed) for (const row of rows) items.push({ kind: "row", row });
  }
  return items;
}

export function itemHeight(item: ListItem): number {
  return item.kind === "header" ? HEADER_HEIGHT : ROW_HEIGHT;
}

export function visibleStatuses(filters: Filters): Status[] {
  return filters.statuses.length === 0
    ? [...STATUSES]
    : STATUSES.filter((status) => filters.statuses.includes(status));
}

export function isPriority(value: unknown): value is Priority {
  return typeof value === "string" && (PRIORITIES as readonly string[]).includes(value);
}

export function isStatus(value: unknown): value is Status {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

/** Parse persisted filters, dropping anything unrecognized. */
export function parseFilters(raw: unknown): Filters {
  if (typeof raw !== "object" || raw === null) return DEFAULT_FILTERS;
  const value = raw as Record<string, unknown>;
  const strings = (input: unknown) =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : [];
  const sort = value.sort;
  return {
    projectIds: strings(value.projectIds),
    statuses: strings(value.statuses).filter(isStatus),
    priorities: strings(value.priorities).filter(isPriority),
    labelIds: strings(value.labelIds),
    liveOnly: value.liveOnly === true,
    search: typeof value.search === "string" ? value.search.slice(0, 200) : "",
    sort:
      sort === "priority" || sort === "updated" || sort === "created" || sort === "manual"
        ? sort
        : DEFAULT_FILTERS.sort,
  };
}
