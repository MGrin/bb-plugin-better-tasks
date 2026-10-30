import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { LaneRepository, MIGRATIONS } from "../lib/lanes/repository.ts";
import { LaneService } from "../lib/lanes/service.ts";
import type { TaskFields } from "../lib/cache.ts";
import { task } from "./fixtures.ts";

function lanes() {
  const { bb, harness } = createFakePluginHost();
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const tasks = new Map<string, TaskFields>();
  const r = new LaneRepository(db);
  const s = new LaneService(r, {
    getTask: async (id: string) => {
      if (id === "offline") throw new Error("offline");
      return tasks.get(id) ?? null;
    },
    getOwner: async (id: string) => ({ id, status: "available" as const, title: null }),
  });
  return { s, r, tasks, harness };
}

const archive = (s: LaneService, id: string, expectedRevision: number) =>
  s.execute({ op: "update", id, patch: { state: "archived" }, expectedRevision }) as Promise<any>;

test("lane archive is refused while a member task is open or unreadable", async () => {
  const { s, r, tasks, harness } = lanes();
  const lane = r.create({ name: "A", goal: "" });
  tasks.set("open", task({ id: "open", key: "DEMO-1", status: "in_review" }));
  tasks.set("done", task({ id: "done", status: "done" }));
  for (const id of ["open", "done", "deleted", "offline"]) r.setMembership(id, lane.id, 0);
  const refused = await archive(s, lane.id, 1);
  assert.equal(refused.result.ok, false);
  assert.equal(refused.result.code, "open_tasks");
  assert.deepEqual(
    refused.result.openTasks.map((t: any) => [t.taskId, t.key, t.status]),
    [
      ["offline", null, "unknown"],
      ["open", "DEMO-1", "in_review"],
    ],
  );
  assert.equal(r.get(lane.id)!.state, "active");
  assert.equal(r.get(lane.id)!.revision, 1);
  // Parking is not archiving: it keeps ownership and needs no move.
  const parked = await s.execute({ op: "update", id: lane.id, patch: { state: "parked" }, expectedRevision: 1 });
  assert.equal((parked as any).result.ok, true);
  // Move the open task, finish the unreadable one; archive then applies.
  r.setMembership("open", null, 1);
  tasks.set("offline", task({ id: "offline", status: "canceled" }));
  const fresh = new LaneService(r, {
    getTask: async (id: string) => tasks.get(id) ?? null,
    getOwner: async (id: string) => ({ id, status: "available" as const, title: null }),
  });
  const applied = await archive(fresh, lane.id, 2);
  assert.equal(applied.result.ok, true);
  assert.equal(applied.result.value.state, "archived");
  await harness.lifecycle.dispose();
});

test("a task that joins during the archive check is refused, never archived unseen", async () => {
  const { r, tasks, harness } = lanes();
  const lane = r.create({ name: "A", goal: "" });
  tasks.set("late", task({ id: "late", status: "todo" }));
  const s = new LaneService(r, {
    getTask: async (id: string) => {
      // Another writer assigns a task while the guard reads statuses.
      if (r.membership("late").revision === 0) r.setMembership("late", lane.id, 0);
      return tasks.get(id) ?? null;
    },
    getOwner: async (id: string) => ({ id, status: "available" as const, title: null }),
  });
  tasks.set("closed", task({ id: "closed", status: "done" }));
  r.setMembership("closed", lane.id, 0);
  const result = await archive(s, lane.id, 1);
  assert.equal(result.result.code, "open_tasks");
  assert.deepEqual(result.result.openTasks, [{ taskId: "late", key: null, status: "unknown" }]);
  assert.equal(r.get(lane.id)!.state, "active");
  await harness.lifecycle.dispose();
});

function host(world: {
  tasks: TaskFields[];
  attached: Record<string, string[]>;
  children: Record<string, string[]>;
}) {
  const archived: string[] = [];
  const h = createFakePluginHost({
    sdk: {
      plugins: {
        callRpc: async ({ method, input }: any) => {
          if (method === "getTask")
            return { task: world.tasks.find((t) => t.id === input.taskId) ?? null };
          if (method === "listTasks") {
            const open = world.tasks.filter((t) => input.statuses.includes(t.status));
            const start = input.cursor ? Number(input.cursor) : 0;
            const page = open.slice(start, start + 1);
            return {
              tasks: page,
              nextCursor: start + 1 < open.length ? String(start + 1) : null,
            };
          }
          if (method === "listTaskThreads")
            return {
              taskThreads: (world.attached[input.taskId] ?? []).map((threadId) => ({
                threadId,
                title: threadId,
                liveStatus: "idle",
              })),
            };
          throw new Error("Unexpected core Tasks call: " + method);
        },
      },
      threads: {
        // A default page of 50 stands in for an unknown host default.
        list: async ({ parentThreadId, limit = 50, offset = 0 }: any) =>
          (world.children[parentThreadId] ?? [])
            .slice(offset, offset + limit)
            .map((id: string) => makeThreadResponse({ id })),
        archive: async ({ threadId }: { threadId: string }) => {
          archived.push(threadId);
          return { archivedThreadIds: [threadId, ...(world.children[threadId] ?? [])] };
        },
        get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId }),
      },
    },
  });
  plugin(h.bb);
  return { ...h, archived };
}

const run = (h: ReturnType<typeof host>, op: "check" | "archive", threadId: string) =>
  h.harness.behavior.runCli(["thread", op, "--input", JSON.stringify({ threadId })]);

test("thread archive is refused while the thread or a child holds an open task", async () => {
  const h = host({
    tasks: [
      task({ id: "t1", key: "DEMO-1", status: "in_progress" }),
      task({ id: "t2", key: "DEMO-2", status: "done" }),
      task({ id: "t3", key: "DEMO-3", status: "todo" }),
    ],
    attached: { t1: ["thr_child"], t2: ["thr_lane"], t3: ["thr_other"] },
    children: { thr_lane: ["thr_child"] },
  });
  const check = await run(h, "check", "thr_lane");
  assert.equal(check.exitCode, 1);
  const holdings = JSON.parse(check.stdout).holdings;
  assert.deepEqual(holdings.threads, ["thr_lane", "thr_child"]);
  assert.deepEqual(
    holdings.attachedTasks.map((t: any) => [t.key, t.status, t.threadId]),
    [["DEMO-1", "in_progress", "thr_child"]],
  );
  assert.equal(holdings.scannedTasks, 2);
  const refused = await run(h, "archive", "thr_lane");
  assert.equal(refused.exitCode, 1);
  assert.equal(JSON.parse(refused.stdout).outcome, "refused");
  assert.deepEqual(h.archived, []);
  const free = await run(h, "archive", "thr_other_free");
  assert.equal(free.exitCode, 0, free.stderr);
  assert.equal(JSON.parse(free.stdout).outcome, "archived");
  assert.deepEqual(h.archived, ["thr_other_free"]);
  await h.harness.lifecycle.dispose();
});

test("thread archive is refused while the thread owns a lane with open tasks", async () => {
  const h = host({
    tasks: [task({ id: "t1", key: "DEMO-1", status: "in_review" })],
    attached: {},
    children: {},
  });
  const created: any = await h.harness.behavior.callRpc("lane", {
    op: "create",
    name: "Lane",
    ownerThreadId: "thr_owner",
  });
  await h.harness.behavior.callRpc("lane", {
    op: "assign",
    taskId: "t1",
    laneId: created.lane.id,
    expectedRevision: 0,
  });
  const refused = await run(h, "archive", "thr_owner");
  assert.equal(refused.exitCode, 1);
  const lanes = JSON.parse(refused.stdout).holdings.ownedLanes;
  assert.deepEqual(
    lanes.map((l: any) => [l.name, l.openTasks.map((t: any) => t.key)]),
    [["Lane", ["DEMO-1"]]],
  );
  assert.deepEqual(h.archived, []);
  await h.harness.lifecycle.dispose();
});

test("a child beyond the first thread page still blocks the archive", async () => {
  const children = Array.from({ length: 150 }, (_, i) => `thr_w${i}`);
  const h = host({
    tasks: [task({ id: "t1", key: "DEMO-1", status: "todo" })],
    attached: { t1: ["thr_w120"] },
    children: { thr_operator: children },
  });
  const check = await run(h, "check", "thr_operator");
  assert.equal(check.exitCode, 1);
  const holdings = JSON.parse(check.stdout).holdings;
  assert.equal(holdings.threads.length, 151);
  assert.deepEqual(holdings.attachedTasks.map((t: any) => t.threadId), ["thr_w120"]);
  await h.harness.lifecycle.dispose();
});
