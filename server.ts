// better-tasks — server entry.
//
// Holds every task in memory as a compact row (no description), kept current
// one task at a time from the Tasks plugin's own change signals, and serves
// the board page over RPC. All reads and writes go through the Tasks
// plugin's public RPC; nothing here touches its database.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { TaskFields } from "./lib/cache.ts";
import { feedUrl, runFeed } from "./lib/feed.ts";
import {
  PRIORITIES,
  STATUSES,
  type Changes,
  type Label,
  type Project,
  type Row,
  type Status,
} from "./lib/model.ts";
import { TaskSync, type TasksApi, type TaskThreadFields } from "./lib/sync.ts";

const TASKS_PLUGIN = "tasks";

export interface TaskDetail {
  task: TaskFields & { description: string };
  threads: (TaskThreadFields & { attachedAt: string })[];
  comments: {
    id: string;
    kind: "user" | "agent" | "system";
    authorName: string;
    body: string;
    threadId: string | null;
    createdAt: string;
  }[];
  subtasks: string[];
}

const statusSchema = z.enum(STATUSES);
const prioritySchema = z.enum(PRIORITIES);
const taskIdSchema = z.string().min(1).max(64);
// Rows are produced by this server from validated Tasks plugin output, so the
// wire schema does not re-validate 5,000 of them on every snapshot.
const rowsSchema = z.custom<Row[]>();
const changesSchema = z.custom<Changes>();

export const rpcContract = defineRpcContract({
  snapshot: {
    input: z.object({ part: z.enum(["open", "closed", "all"]) }).strict(),
    output: z.object({
      version: z.number(),
      rows: rowsSchema,
      projects: z.custom<Project[]>(),
      labels: z.custom<Label[]>(),
      counts: z.custom<Record<Status, number>>(),
      complete: z.boolean(),
    }),
  },
  changes: {
    input: z.object({ since: z.number().int().nonnegative() }).strict(),
    output: z.object({ changes: changesSchema.nullable() }),
  },
  detail: {
    input: z.object({ taskId: taskIdSchema }).strict(),
    output: z.object({ detail: z.custom<TaskDetail>().nullable() }),
  },
  update: {
    input: z
      .object({
        taskId: taskIdSchema,
        status: statusSchema.optional(),
        priority: prioritySchema.optional(),
      })
      .strict(),
    output: z.object({ row: z.custom<Row>().nullable() }),
  },
  move: {
    input: z
      .object({
        taskId: taskIdSchema,
        status: statusSchema,
        beforeTaskId: taskIdSchema.nullable().optional(),
        afterTaskId: taskIdSchema.nullable().optional(),
      })
      .strict(),
    output: z.object({ row: z.custom<Row>().nullable() }),
  },
  search: {
    input: z.object({ query: z.string().trim().min(2).max(200) }).strict(),
    output: z.object({ ids: z.array(z.string()), truncated: z.boolean() }),
  },
  stats: {
    input: z.null(),
    output: z.custom<Record<string, unknown>>(),
  },
});

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

type TaskOrError =
  | { ok: true; task: TaskFields }
  | { ok: false; error: { code: string; message: string } };

export default function plugin(bb: BbPluginApi) {
  async function call<T>(method: string, input: unknown): Promise<T> {
    return bb.sdk.plugins.callRpc<T>({
      pluginId: TASKS_PLUGIN,
      method,
      input: input as never,
      // The Tasks plugin validates its own output; do not parse it twice.
      outputSchema: z.custom<T>(),
    });
  }

  const api: TasksApi = {
    listTasks: (input) => call("listTasks", input),
    getTask: async (taskId) =>
      (await call<{ task: TaskFields | null }>("getTask", { taskId })).task,
    listTaskThreads: async (taskId) =>
      (await call<{ taskThreads: TaskThreadFields[] }>("listTaskThreads", { taskId }))
        .taskThreads,
    listProjects: async () =>
      (await call<{ projects: Project[] }>("listProjects", {})).projects,
    listLabels: async (projectId) =>
      (await call<{ labels: Label[] }>("listLabels", { projectId })).labels,
  };

  const sync = new TaskSync({
    api,
    publish: (channel, payload) => bb.realtime.publish(channel, payload),
    log: (message) => bb.log.warn(message),
  });
  bb.onDispose(() => sync.dispose());

  function unwrap(result: TaskOrError): TaskFields {
    if (!result.ok) throw new Error(result.error.message);
    return result.task;
  }

  bb.rpc.register(rpcContract, {
    async snapshot({ part }) {
      if (part === "open") await sync.openReady;
      else await sync.allReady;
      return {
        version: sync.cache.version,
        rows: sync.cache.rows(part),
        projects: sync.projects,
        labels: sync.labels,
        counts: sync.cache.countsByStatus(),
        complete: sync.loaded,
      };
    },
    changes({ since }) {
      return { changes: sync.changesSince(since) };
    },
    async detail({ taskId }) {
      const task = await call<{ task: TaskDetail["task"] | null }>("getTask", { taskId });
      if (task.task === null) return { detail: null };
      const [threads, comments, subtasks] = await Promise.all([
        call<{ taskThreads: TaskDetail["threads"] }>("listTaskThreads", { taskId }),
        call<{ comments: TaskDetail["comments"] }>("listComments", { taskId }),
        call<{ tasks: TaskFields[] }>("listTasks", { parentTaskId: taskId, limit: 500 }),
      ]);
      return {
        detail: {
          task: task.task,
          threads: threads.taskThreads,
          comments: comments.comments.map(
            ({ id, kind, authorName, body, threadId, createdAt }) => ({
              id,
              kind,
              authorName,
              body,
              threadId,
              createdAt,
            }),
          ),
          subtasks: subtasks.tasks.map((subtask) => subtask.id),
        },
      };
    },
    async update({ taskId, status, priority }) {
      const task = unwrap(
        await call<TaskOrError>("updateTask", {
          taskId,
          ...(status === undefined ? {} : { status }),
          ...(priority === undefined ? {} : { priority }),
        }),
      );
      sync.applyTask(task);
      return { row: sync.cache.get(task.id) ?? null };
    },
    async move({ taskId, status, beforeTaskId, afterTaskId }) {
      const task = unwrap(
        await call<TaskOrError>("boardMove", {
          taskId,
          status,
          ...(beforeTaskId === undefined ? {} : { beforeTaskId }),
          ...(afterTaskId === undefined ? {} : { afterTaskId }),
        }),
      );
      sync.applyTask(task);
      return { row: sync.cache.get(task.id) ?? null };
    },
    async search({ query }) {
      const limit = 500;
      const page = await call<{ tasks: TaskFields[]; nextCursor: string | null }>(
        "listTasks",
        { search: query, limit },
      );
      return {
        ids: page.tasks.map((task) => task.id),
        truncated: page.nextCursor !== null,
      };
    },
    stats() {
      return {
        version: sync.cache.version,
        size: sync.cache.size,
        loaded: sync.loaded,
        ...sync.stats,
      };
    },
  });

  // Load once, then keep current from the Tasks plugin's own signals.
  bb.background.service("change-feed", {
    async start(signal) {
      // A failed load (the Tasks plugin busy, restarting) retries with
      // backoff rather than leaving the board half-read.
      const load = async () => {
        for (let attempt = 0; !signal.aborted; attempt += 1) {
          try {
            await sync.requestFullLoad();
            return;
          } catch (error) {
            sync.stats.failedLoads += 1;
            const delay = Math.min(30_000, 1_000 * 2 ** attempt);
            bb.log.error(`full load failed, retrying in ${delay} ms: ${String(error)}`);
            await sleep(delay, signal);
          }
        }
      };
      await runFeed(
        feedUrl(bb.server.loopbackBaseUrl),
        {
          onSignal: (channel, payload) => sync.onSignal(channel, payload),
          // First connect: the initial load. A reconnect: signals may have
          // been missed while the socket was down, so diff everything once.
          onOpen: () => void load(),
          log: (message) => bb.log.info(message),
        },
        signal,
      );
    },
  });
}
