// Types and constants shared by server.ts and app.tsx. Pure data, no runtime
// dependencies, so both bundles can import it.

/** One order for list groups and board columns (mgrin, 2026-09-28). */
export const STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
] as const;
export type Status = (typeof STATUSES)[number];

export const OPEN_STATUSES: readonly Status[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
];
export const CLOSED_STATUSES: readonly Status[] = ["done", "canceled"];

export const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const STATUS_LABEL: Record<Status, string> = {
  in_progress: "In progress",
  in_review: "In review",
  todo: "Todo",
  backlog: "Backlog",
  done: "Done",
  canceled: "Cancelled",
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "No priority",
};

export function isOpen(status: Status): boolean {
  return status !== "done" && status !== "canceled";
}

/** A thread attached to a task that is starting or working right now. */
export interface LiveThread {
  threadId: string;
  title: string;
  liveStatus: "starting" | "working";
}

/**
 * One task as the board needs it: everything but the description, which is
 * 86% of the Tasks plugin's payload and is fetched per task on demand.
 */
export interface Row {
  id: string;
  key: string;
  projectId: string;
  number: number;
  title: string;
  status: Status;
  priority: Priority;
  dueDate: string | null;
  parentTaskId: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
  labelIds: string[];
  live: LiveThread[];
  /** Server cache version at which this row last changed. */
  rev: number;
}

export interface Project {
  id: string;
  name: string;
  prefix: string;
  color: string;
}

export interface Label {
  id: string;
  projectId: string;
  name: string;
  color: string;
}

export interface Removal {
  id: string;
  rev: number;
}

/** Everything that changed in the cache between two versions. */
export interface Changes {
  from: number;
  to: number;
  upserts: Row[];
  removes: Removal[];
}

/** Realtime channels this plugin publishes on. */
export const CHANNEL_DELTA = "delta";
export const CHANNEL_META = "meta";
export const CHANNEL_TOUCHED = "touched";

/**
 * A delta signal. Small change sets carry their rows; a large one (a resync)
 * carries only the range, and clients pull it with the `changes` RPC.
 */
export type DeltaSignal =
  | ({ kind: "rows" } & Changes)
  | { kind: "range"; from: number; to: number };
