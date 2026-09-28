// Synthetic tasks only. Nothing here is, or may ever be, real board content.
import type { TaskFields } from "../lib/cache.ts";
import type { Status } from "../lib/model.ts";
import type { TasksApi, TaskThreadFields } from "../lib/sync.ts";

let serial = 0;

export function task(overrides: Partial<TaskFields> = {}): TaskFields {
  serial += 1;
  const number = overrides.number ?? serial;
  return {
    id: `01TASK${String(serial).padStart(20, "0")}`,
    key: `DEMO-${number}`,
    projectId: "01PROJECTDEMO0000000000000",
    number,
    title: `Synthetic task ${number}`,
    status: "todo",
    priority: "none",
    dueDate: null,
    parentTaskId: null,
    position: number,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    labelIds: [],
    ...overrides,
  };
}

/** An in-memory Tasks plugin that counts every call. */
export class FakeTasks implements TasksApi {
  tasks = new Map<string, TaskFields>();
  threads = new Map<string, TaskThreadFields[]>();
  calls: string[] = [];
  /** Reject the next N cursor-bearing listTasks calls the way the Tasks plugin does. */
  staleCursors = 0;

  add(...tasks: TaskFields[]): void {
    for (const item of tasks) this.tasks.set(item.id, item);
  }

  async listTasks(input: {
    statuses?: Status[];
    activeOnly?: boolean;
    limit: number;
    cursor?: string;
  }) {
    this.calls.push("listTasks");
    if (input.cursor !== undefined && this.staleCursors > 0) {
      this.staleCursors -= 1;
      throw new Error(
        "HTTP 500: task-list data changed after this cursor was issued; restart pagination without --cursor",
      );
    }
    let all = [...this.tasks.values()];
    if (input.statuses) all = all.filter((item) => input.statuses!.includes(item.status));
    if (input.activeOnly) {
      all = all.filter((item) =>
        (this.threads.get(item.id) ?? []).some(
          (thread) => thread.liveStatus === "working" || thread.liveStatus === "starting",
        ),
      );
    }
    const start = input.cursor === undefined ? 0 : Number(input.cursor);
    const page = all.slice(start, start + input.limit);
    const next = start + input.limit;
    return { tasks: page, nextCursor: next < all.length ? String(next) : null };
  }

  async getTask(taskId: string) {
    this.calls.push("getTask");
    return this.tasks.get(taskId) ?? null;
  }

  async listTaskThreads(taskId: string) {
    this.calls.push("listTaskThreads");
    return this.threads.get(taskId) ?? [];
  }

  async listProjects() {
    this.calls.push("listProjects");
    return [{ id: "01PROJECTDEMO0000000000000", name: "Demo", prefix: "DEMO", color: "blue" }];
  }

  async listLabels() {
    this.calls.push("listLabels");
    return [];
  }
}
