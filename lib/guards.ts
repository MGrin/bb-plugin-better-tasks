// Archive guards: a lane or a worker thread that still holds open tasks is not
// archived until those tasks are moved, finished or detached. Archived lanes
// holding open in_review tasks were one source of board drift (2026-10-30).
import { OPEN_STATUSES, STATUSES, type Status } from "./model.ts";

/** A task that blocks an archive. "unknown" means the lookup failed: fail closed. */
export interface HeldTask {
  taskId: string;
  key: string | null;
  status: Status | "unknown";
}

const CONCURRENCY = 8;
const PAGE = 500;
/** Archive cascades to children; a larger subtree is refused rather than half-checked. */
export const MAX_SUBTREE = 500;

export async function mapLimit<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run));
  return out;
}

function fields(task: unknown): { key: string | null; status: Status | "unknown" } {
  const record = task as { key?: unknown; status?: unknown };
  const key = typeof record.key === "string" ? record.key : null;
  const status = STATUSES.includes(record.status as Status)
    ? (record.status as Status)
    : "unknown";
  return { key, status };
}

/**
 * Open or unreadable tasks among `taskIds`, read through the authoritative
 * Tasks lookup. A deleted task (null) holds nothing.
 */
export async function heldTasks(
  taskIds: readonly string[],
  getTask: (id: string) => Promise<unknown | null>,
): Promise<HeldTask[]> {
  const results = await mapLimit(taskIds, async (taskId): Promise<HeldTask | null> => {
    let task: unknown;
    try {
      task = await getTask(taskId);
    } catch {
      return { taskId, key: null, status: "unknown" };
    }
    if (task === null) return null;
    if (!task || typeof task !== "object" || (task as { id?: unknown }).id !== taskId)
      return { taskId, key: null, status: "unknown" };
    const { key, status } = fields(task);
    return status === "unknown" || OPEN_STATUSES.includes(status)
      ? { taskId, key, status }
      : null;
  });
  return results.filter((held): held is HeldTask => held !== null);
}

export interface ThreadGuardAdapters {
  getTask: (id: string) => Promise<unknown | null>;
  listOpenTasks: (input: {
    statuses: Status[];
    limit: number;
    cursor?: string;
  }) => Promise<{ tasks: { id: string; key: string; status: Status }[]; nextCursor: string | null }>;
  listTaskThreads: (taskId: string) => Promise<{ threadId: string }[]>;
  /** Unarchived direct children, hidden ones included. */
  listChildren: (threadId: string) => Promise<string[]>;
  /** Lanes this thread owns that are not archived, with their member task IDs. */
  ownedLanes: (threadId: string) => { id: string; name: string; taskIds: string[] }[];
}

export interface ThreadHoldings {
  threadId: string;
  /** The thread and every unarchived descendant: archive takes them all. */
  threads: string[];
  attachedTasks: (HeldTask & { threadId: string })[];
  ownedLanes: { laneId: string; name: string; ownerThreadId: string; openTasks: HeldTask[] }[];
  scannedTasks: number;
  blocked: boolean;
}

async function subtree(threadId: string, a: ThreadGuardAdapters): Promise<string[]> {
  const seen = new Set([threadId]);
  const queue = [threadId];
  while (queue.length > 0) {
    const children = await mapLimit(queue.splice(0), (id) => a.listChildren(id));
    for (const id of children.flat()) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (seen.size > MAX_SUBTREE)
        throw new Error(`Thread subtree exceeds ${MAX_SUBTREE} threads; archive it in parts`);
      queue.push(id);
    }
  }
  return [...seen];
}

/** What a thread archive would orphan: open tasks attached to the subtree, and open tasks of lanes it owns. */
export async function threadHoldings(
  threadId: string,
  a: ThreadGuardAdapters,
): Promise<ThreadHoldings> {
  const threads = await subtree(threadId, a);
  const members = new Set(threads);
  const open: { id: string; key: string; status: Status }[] = [];
  let cursor: string | undefined;
  do {
    const page = await a.listOpenTasks({
      statuses: [...OPEN_STATUSES],
      limit: PAGE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    open.push(...page.tasks);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  const attached = await mapLimit(open, async (task) =>
    (await a.listTaskThreads(task.id))
      .filter((thread) => members.has(thread.threadId))
      .map((thread) => ({
        taskId: task.id,
        key: task.key,
        status: task.status,
        threadId: thread.threadId,
      })),
  );
  const ownedLanes = [];
  for (const owner of threads)
    for (const lane of a.ownedLanes(owner)) {
      const openTasks = await heldTasks(lane.taskIds, a.getTask);
      if (openTasks.length > 0)
        ownedLanes.push({ laneId: lane.id, name: lane.name, ownerThreadId: owner, openTasks });
    }
  const attachedTasks = attached.flat();
  return {
    threadId,
    threads,
    attachedTasks,
    ownedLanes,
    scannedTasks: open.length,
    blocked: attachedTasks.length > 0 || ownedLanes.length > 0,
  };
}
