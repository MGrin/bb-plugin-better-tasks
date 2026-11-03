// better-tasks — server entry.
//
// Holds every task in memory as a compact row (no description), kept current
// one task at a time from the Tasks plugin's own change signals, and serves
// the board page over RPC. All reads and writes go through the Tasks
// plugin's public RPC; nothing here touches its database.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { TaskFields } from "./lib/cache.ts";
import { FeedControl, feedUrl, runFeed } from "./lib/feed.ts";
import { feedHandlers, superviseSync } from "./lib/supervisor.ts";
import {
  PRIORITIES,
  STATUSES,
  type Changes,
  type Label,
  type Project,
  type Row,
  type Status,
  type SyncHealth,
} from "./lib/model.ts";
import { TaskSync, type TasksApi, type TaskThreadFields } from "./lib/sync.ts";

import { laneBackend, laneRpcMethods } from "./lib/lanes/backend.ts";
import type { ReleaseRecord, ReleaseReply } from "./lib/release/model.ts";
import { MAX_SUBTREE } from "./lib/guards.ts";

const TASKS_PLUGIN = "tasks";
const CHILD_PAGE = 100;
// A call to a Tasks plugin that never answers must not hold the sync forever.
const RPC_TIMEOUT_MS = 30_000;

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
  /** Written by train tooling only; the board shows it read-only. */
  release: ReleaseRecord | null;
}

const statusSchema = z.enum(STATUSES);
const prioritySchema = z.enum(PRIORITIES);
const taskIdSchema = z.string().min(1).max(64);
// Rows are produced by this server from validated Tasks plugin output, so the
// wire schema does not re-validate 5,000 of them on every snapshot.
const rowsSchema = z.custom<Row[]>();
const changesSchema = z.custom<Changes>();

export const rpcContract = defineRpcContract({
  ...laneRpcMethods,
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
  health: {
    input: z.null(),
    output: z.custom<SyncHealth>(),
  },
  openCount: {
    input: z.null(),
    output: z.object({ open: z.number().int().nonnegative().nullable() }),
  },
  stats: {
    input: z.null(),
    output: z.custom<Record<string, unknown>>(),
  },
});

type TaskOrError =
  | { ok: true; task: TaskFields }
  | { ok: false; error: { code: string; message: string } };

export default function plugin(bb: BbPluginApi) {
  async function call<T>(method: string, input: unknown): Promise<T> {
    return bb.sdk.plugins.callRpc<T>({
      pluginId: TASKS_PLUGIN,
      method,
      input: input as never,
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
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

  const laneHandlers=laneBackend(bb,{
    getTask:api.getTask,
    listLabels:api.listLabels,
    listTasks:input=>call("listTasks",input),
    listOpenTasks:input=>call("listTasks",input),
    listTaskThreads:api.listTaskThreads,
    // Page explicitly: a default page size must never hide a child from the archive guard.
    async listChildren(threadId){
      const ids:string[]=[];
      for(let offset=0;offset<=MAX_SUBTREE;offset+=CHILD_PAGE){
        const page=await bb.sdk.threads.list({parentThreadId:threadId,archived:false,includeHidden:true,limit:CHILD_PAGE,offset});
        ids.push(...page.map(thread=>thread.id));
        if(page.length<CHILD_PAGE) break;
      }
      return ids;
    },
    async getOwner(id){
      try {
        const thread=await bb.sdk.threads.get({threadId:id});
        return {id,status:thread.deletedAt!==null?"missing" as const:thread.archivedAt!==null?"archived" as const:"available" as const,title:thread.title};
      } catch(error) {
        const missing=typeof error==="object" && error!==null && "status" in error && error.status===404;
        return {id,status:missing?"missing" as const:"unknown" as const,title:null};
      }
    },
  });
  bb.rpc.register(rpcContract, {
    ...laneHandlers,
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
          release: (laneHandlers.release({ op: "get", taskId }) as Extract<
            ReleaseReply,
            { kind: "record" }
          >).record,
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
    health() {
      return sync.health();
    },
    openCount() {
      return { open: sync.openCount };
    },
    stats() {
      return {
        version: sync.cache.version,
        size: sync.cache.size,
        loaded: sync.loaded,
        ...sync.health(),
        ...sync.stats,
      };
    },
  });

  // Keep current from the Tasks plugin's own signals; reload whenever they
  // may have been missed, and reconcile on a timer in case they stop quietly.
  const feed = new FeedControl();
  const log = {
    info: (message: string) => bb.log.info(message),
    warn: (message: string) => bb.log.warn(message),
    error: (message: string) => bb.log.error(message),
  };
  bb.background.service("change-feed", {
    async start(signal) {
      await runFeed(feedUrl(bb.server.loopbackBaseUrl), feedHandlers(sync, log), signal, {
        control: feed,
      });
    },
  });
  bb.background.service("reconcile", {
    async start(signal) {
      await superviseSync(
        { sync, log, onDrift: () => feed.reconnect("reconcile found missed changes") },
        signal,
      );
    },
  });
}
