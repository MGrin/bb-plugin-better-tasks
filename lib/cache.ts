// The server-side task cache: every task as a compact Row, a monotonically
// increasing version, and a bounded log of what changed at each version so a
// client that missed a signal can catch up without a full snapshot.
import {
  CLOSED_STATUSES,
  type Changes,
  type LiveThread,
  type Removal,
  type Row,
  type Status,
} from "./model.ts";

/** The task fields the cache keeps, as the Tasks plugin returns them. */
export interface TaskFields {
  id: string;
  key: string;
  projectId: string;
  number: number;
  title: string;
  status: Status;
  priority: Row["priority"];
  dueDate: string | null;
  parentTaskId: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
  labelIds: string[];
}

interface LogEntry {
  version: number;
  id: string;
}

const SAME_KEYS = [
  "key",
  "projectId",
  "number",
  "title",
  "status",
  "priority",
  "dueDate",
  "parentTaskId",
  "position",
  "createdAt",
  "updatedAt",
] as const;

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameLive(a: readonly LiveThread[], b: readonly LiveThread[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (thread, index) =>
        thread.threadId === b[index]!.threadId &&
        thread.title === b[index]!.title &&
        thread.liveStatus === b[index]!.liveStatus,
    )
  );
}

export class TaskCache {
  readonly #rows = new Map<string, Row>();
  readonly #removed = new Map<string, number>();
  #log: LogEntry[] = [];
  #version = 0;
  readonly #logLimit: number;

  constructor(options: { logLimit?: number } = {}) {
    this.#logLimit = options.logLimit ?? 20_000;
  }

  get version(): number {
    return this.#version;
  }

  get size(): number {
    return this.#rows.size;
  }

  get(id: string): Row | undefined {
    return this.#rows.get(id);
  }

  ids(): IterableIterator<string> {
    return this.#rows.keys();
  }

  /**
   * Insert or update one task. `live` replaces the task's live threads when
   * given and keeps the cached ones when omitted. Returns whether anything
   * changed; an identical write does not bump the version.
   */
  upsert(task: TaskFields, live?: LiveThread[]): boolean {
    const previous = this.#rows.get(task.id);
    const nextLive = live ?? previous?.live ?? [];
    if (
      previous !== undefined &&
      SAME_KEYS.every((key) => previous[key] === task[key]) &&
      sameStrings(previous.labelIds, task.labelIds) &&
      sameLive(previous.live, nextLive)
    ) {
      return false;
    }
    const version = this.#bump(task.id);
    this.#removed.delete(task.id);
    this.#rows.set(task.id, {
      id: task.id,
      key: task.key,
      projectId: task.projectId,
      number: task.number,
      title: task.title,
      status: task.status,
      priority: task.priority,
      dueDate: task.dueDate,
      parentTaskId: task.parentTaskId,
      position: task.position,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      labelIds: [...task.labelIds],
      live: nextLive,
      rev: version,
    });
    return true;
  }

  /** Replace only the live threads of a cached task. */
  setLive(id: string, live: LiveThread[]): boolean {
    const previous = this.#rows.get(id);
    if (previous === undefined || sameLive(previous.live, live)) return false;
    const version = this.#bump(id);
    this.#rows.set(id, { ...previous, live, rev: version });
    return true;
  }

  remove(id: string): boolean {
    if (!this.#rows.delete(id)) return false;
    this.#removed.set(id, this.#bump(id));
    return true;
  }

  /** Rows by part: open work, closed work, or everything. */
  rows(part: "open" | "closed" | "all"): Row[] {
    const out: Row[] = [];
    for (const row of this.#rows.values()) {
      const closed = CLOSED_STATUSES.includes(row.status);
      if (part === "all" || (part === "closed") === closed) out.push(row);
    }
    return out;
  }

  countsByStatus(): Record<Status, number> {
    const counts: Record<Status, number> = {
      in_progress: 0,
      in_review: 0,
      todo: 0,
      backlog: 0,
      done: 0,
      canceled: 0,
    };
    for (const row of this.#rows.values()) counts[row.status] += 1;
    return counts;
  }

  /**
   * Everything that changed after `since`, or null when the log no longer
   * reaches back that far (the caller then takes a fresh snapshot).
   */
  changesSince(since: number): Changes | null {
    if (since >= this.#version) {
      return { from: since, to: this.#version, upserts: [], removes: [] };
    }
    const oldest = this.#log[0]?.version ?? this.#version + 1;
    if (since + 1 < oldest) return null;
    const touched = new Set<string>();
    for (let index = this.#log.length - 1; index >= 0; index -= 1) {
      const entry = this.#log[index]!;
      if (entry.version <= since) break;
      touched.add(entry.id);
    }
    const upserts: Row[] = [];
    const removes: Removal[] = [];
    for (const id of touched) {
      const row = this.#rows.get(id);
      if (row !== undefined) upserts.push(row);
      else {
        const rev = this.#removed.get(id);
        if (rev !== undefined) removes.push({ id, rev });
      }
    }
    return { from: since, to: this.#version, upserts, removes };
  }

  #bump(id: string): number {
    this.#version += 1;
    this.#log.push({ version: this.#version, id });
    if (this.#log.length > this.#logLimit * 1.25) {
      this.#log = this.#log.slice(-this.#logLimit);
    }
    return this.#version;
  }
}
