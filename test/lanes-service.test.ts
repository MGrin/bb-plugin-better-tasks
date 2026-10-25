import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { LaneRepository, MIGRATIONS } from "../lib/lanes/repository.ts";
import { LaneService } from "../lib/lanes/service.ts";
import { task } from "./fixtures.ts";

function setup() {
  const { bb, harness } = createFakePluginHost();
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const tasks = new Map([["task", task({ id: "task" })]]);
  const r = new LaneRepository(db);
  const s = new LaneService(r, {
    getTask: async (id: string) => {
      if (id === "offline") throw new Error("offline");
      return tasks.get(id) ?? null;
    },
    getOwner: async (id: string) => ({
      id,
      status: "missing" as const,
      title: null,
    }),
  });
  return { s, r, tasks, harness };
}
test("validation rejects empty names, unknown fields and invalid revisions", async () => {
  const { s, harness } = setup();
  await assert.rejects(() => s.execute({ op: "create", name: "  ", goal: "" }));
  await assert.rejects(() =>
    s.execute({ op: "create", name: "A", goal: "", state: "archived" }),
  );
  await assert.rejects(() =>
    s.execute({
      op: "assign",
      taskId: "task",
      laneId: "x",
      expectedRevision: -1,
    }),
  );
  await harness.lifecycle.dispose();
});
test("assignment confirms task existence; failed lookup and unloaded tasks preserve memberships", async () => {
  const { s, r, tasks, harness } = setup();
  const l = r.create({ name: "A", goal: "" });
  await assert.rejects(
    () =>
      s.execute({
        op: "assign",
        taskId: "missing",
        laneId: l.id,
        expectedRevision: 0,
      }),
    /exist/,
  );
  await assert.rejects(
    () =>
      s.execute({
        op: "assign",
        taskId: "offline",
        laneId: l.id,
        expectedRevision: 0,
      }),
    /offline/,
  );
  await s.execute({
    op: "assign",
    taskId: "task",
    laneId: l.id,
    expectedRevision: 0,
  });
  tasks.clear();
  assert.equal(r.membership("task").laneId, l.id);
  await s.execute({
    op: "assign",
    taskId: "task",
    laneId: null,
    expectedRevision: 1,
  });
  assert.equal(r.membership("task").laneId, null);
  await harness.lifecycle.dispose();
});
test("lane get preserves a missing owner and paginates cross-board members", async () => {
  const { s, r, harness } = setup();
  const l = r.create({ name: "same", goal: "A", ownerThreadId: "gone" });
  for (let i = 0; i < 3; i++) r.setMembership("task-" + i, l.id, 0);
  const result: any = await s.execute({ op: "get", id: l.id, limit: 2 });
  assert.equal(result.owner.status, "missing");
  assert.equal(result.lane.ownerThreadId, "gone");
  assert.equal(result.memberships.length, 2);
  assert.ok(result.nextCursor);
  const next: any = await s.execute({
    op: "get",
    id: l.id,
    limit: 2,
    cursor: result.nextCursor,
  });
  assert.equal(next.memberships.length, 1);
  await assert.rejects(() => s.execute({ op: "list", limit: 501 }));
  await harness.lifecycle.dispose();
});
test("membership read exposes tombstone revisions for safe CLI reassignment", async () => {
  const { s, r, harness } = setup();
  const lane = r.create({ name: "A", goal: "" });
  r.setMembership("task", lane.id, 0);
  r.setMembership("task", null, 1);
  const result: any = await s.execute({ op: "membership", taskId: "task" });
  assert.equal(result.membership.laneId, null);
  assert.equal(result.membership.revision, 2);
  await harness.lifecycle.dispose();
});
