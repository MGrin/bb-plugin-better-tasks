import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { MIGRATIONS } from "../lib/lanes/repository.ts";
import { ReleaseRepository } from "../lib/release/repository.ts";
import { ReleaseService } from "../lib/release/service.ts";
import type { ReleaseStage } from "../lib/release/model.ts";
import { task } from "./fixtures.ts";

function setup() {
  const { bb, harness } = createFakePluginHost();
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const tasks = new Map([["task", task({ id: "task", status: "in_review" })]]);
  const r = new ReleaseRepository(db);
  const changed: string[] = [];
  const s = new ReleaseService(
    r,
    {
      getTask: async (id: string) => {
        if (id === "offline") throw new Error("offline");
        return tasks.get(id) ?? null;
      },
    },
    (taskId) => changed.push(taskId),
  );
  return { s, r, harness, changed, tasks };
}

const write = (
  stage: ReleaseStage,
  expectedRevision: number,
  extra: Record<string, unknown> = {},
) => ({
  operationId: randomUUID(),
  taskId: "task",
  stage,
  train: ["boarded", "go", "live", "verified"].includes(stage) ? "train-7" : null,
  expectedRevision,
  writer: "marco-train",
  ...extra,
});

test("a train walks a task through every stage with revisions and history", async () => {
  const { s, r, harness, changed, tasks } = setup();
  const stages: ReleaseStage[] = ["merged-dev", "nominated", "boarded", "go", "live", "verified"];
  for (const [i, stage] of stages.entries()) {
    const reply: any = await s.set(write(stage, i, { evidence: `step ${i}` }), "thr_train");
    assert.equal(reply.receipt.outcome, "applied", stage);
    assert.equal(reply.receipt.after.revision, i + 1);
  }
  const record = r.get("task")!;
  assert.equal(record.stage, "verified");
  assert.equal(record.train, "train-7");
  assert.equal(record.actorThreadId, "thr_train");
  assert.deepEqual(
    r.history("task", 10).map((h) => h.stage),
    [...stages].reverse(),
  );
  assert.equal(changed.length, 6);
  // Status stays with the lane.
  assert.equal(tasks.get("task")!.status, "in_review");
  await harness.lifecycle.dispose();
});

test("train rules refuse unboarded, skipped, cross-train and unexplained backward writes", async () => {
  const { s, harness } = setup();
  const outcome = async (input: unknown) => ((await s.set(input, null)) as any).receipt;
  assert.equal((await outcome(write("go", 0))).reason, "not_boarded");
  assert.equal((await outcome(write("boarded", 0))).outcome, "applied");
  assert.equal((await outcome(write("live", 1))).reason, "stage_skipped");
  assert.equal((await outcome(write("go", 1, { train: "train-8" }))).reason, "train_mismatch");
  assert.equal((await outcome(write("go", 0))).reason, "revision_changed");
  assert.equal((await outcome(write("go", 1))).outcome, "applied");
  assert.equal((await outcome(write("nominated", 2))).reason, "evidence_required");
  const dropped = await outcome(write("nominated", 2, { evidence: "dropped from train-7: CI red" }));
  assert.equal(dropped.outcome, "applied");
  assert.equal(dropped.after.train, null);
  // Re-boarding onto a new train needs no history rewrite.
  assert.equal((await outcome(write("boarded", 3, { train: "train-8" }))).outcome, "applied");
  const same = await outcome(write("boarded", 4, { train: "train-8" }));
  assert.equal(same.outcome, "unchanged");
  assert.equal(same.after.revision, 4);
  await harness.lifecycle.dispose();
});

test("input validation: train ID per stage, writer identity, missing or unknown tasks", async () => {
  const { s, harness } = setup();
  await assert.rejects(() => s.set(write("boarded", 0, { train: null }), null));
  await assert.rejects(() => s.set(write("nominated", 0, { train: "train-7" }), null));
  await assert.rejects(() => s.set(write("merged-dev", 0, { writer: "someone" }), null));
  await assert.rejects(() => s.set(write("merged-dev", 0, { status: "done" }), null));
  await assert.rejects(() => s.set(write("merged-dev", 0, { taskId: "gone" }), null), /task_missing/);
  await assert.rejects(() => s.set(write("merged-dev", 0, { taskId: "offline" }), null), /task_unknown/);
  await harness.lifecycle.dispose();
});

test("an operation ID replays its receipt once and cannot be reused for another write", async () => {
  const { s, r, harness } = setup();
  const input = write("merged-dev", 0);
  const first: any = await s.set(input, null);
  const again: any = await s.set(input, null);
  assert.deepEqual(again, first);
  assert.equal(r.history("task", 10).length, 1);
  await assert.rejects(
    () => s.set({ ...input, stage: "nominated", expectedRevision: 1 }, null),
    /operation_id_reused/,
  );
  const lookup: any = s.read({ op: "operation", operationId: input.operationId });
  assert.deepEqual(lookup.receipt, first.receipt);
  await harness.lifecycle.dispose();
});

test("list filters by stage and train with pagination", async () => {
  const { s, r, harness, tasks } = setup();
  for (const id of ["a", "b", "c"]) {
    tasks.set(id, task({ id }));
    await s.set(write("boarded", 0, { taskId: id }), null);
  }
  await s.set(write("go", 1, { taskId: "b" }), null);
  const boarded: any = s.read({ op: "list", stage: "boarded", train: "train-7", limit: 1 });
  assert.deepEqual(boarded.records.map((x: any) => x.taskId), ["a"]);
  assert.equal(boarded.nextCursor, "a");
  const next: any = s.read({ op: "list", stage: "boarded", cursor: "a" });
  assert.deepEqual(next.records.map((x: any) => x.taskId), ["c"]);
  assert.equal(next.nextCursor, null);
  assert.equal(r.list({ train: "other", limit: 10 }).records.length, 0);
  await harness.lifecycle.dispose();
});

test("CLI writes with the caller thread; RPC only reads; Tasks status is never written", async () => {
  const methods: string[] = [];
  const { bb, harness } = createFakePluginHost({
    sdk: {
      plugins: {
        callRpc: async ({ method, input }: any) => {
          methods.push(method);
          if (method === "getTask") return { task: task({ id: input.taskId, status: "in_review" }) };
          if (method === "listTaskThreads") return { taskThreads: [] };
          if (method === "listComments") return { comments: [] };
          if (method === "listTasks") return { tasks: [], nextCursor: null };
          throw new Error("Unexpected core Tasks call: " + method);
        },
      },
    },
  });
  plugin(bb);
  const set = (input: unknown) =>
    harness.behavior.runCli(["release", "set", "--input", JSON.stringify(input)], {
      threadId: "thr_operator",
    });
  const ok = await set(write("merged-dev", 0));
  assert.equal(ok.exitCode, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).receipt.after.actorThreadId, "thr_operator");
  const conflict = await set(write("merged-dev", 0, { stage: "nominated" }));
  assert.equal(conflict.exitCode, 1);
  assert.equal(JSON.parse(conflict.stdout).receipt.reason, "revision_changed");
  const got = await harness.behavior.runCli(["release", "get", "--input", '{"taskId":"task"}']);
  assert.equal(JSON.parse(got.stdout).record.stage, "merged-dev");
  await assert.rejects(() => harness.behavior.callRpc("release", { op: "set", ...write("nominated", 1) }));
  const rpc: any = await harness.behavior.callRpc("release", { op: "history", taskId: "task" });
  assert.equal(rpc.entries.length, 1);
  const detail: any = await harness.behavior.callRpc("detail", { taskId: "task" });
  assert.equal(detail.detail.release.stage, "merged-dev");
  assert.equal(
    harness.realtimeSignals.filter((x) => x.channel === "touched").length,
    1,
  );
  assert.deepEqual(
    methods.filter((m) => !["getTask", "listTaskThreads", "listComments", "listTasks"].includes(m)),
    [],
  );
  await harness.lifecycle.dispose();
});
