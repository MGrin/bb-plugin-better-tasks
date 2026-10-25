import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { LaneRepository, MIGRATIONS } from "../lib/lanes/repository.ts";
import { LaneImporter } from "../lib/lanes/import.ts";
import { task } from "./fixtures.ts";
function setup() {
  const { bb, harness } = createFakePluginHost();
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const r = new LaneRepository(db);
  const a = r.create({ name: "same", goal: "board A" }),
    b = r.create({ name: "same", goal: "board B" });
  const labels = [
    { id: "la", projectId: "a", name: "lane: same", color: "blue" },
    { id: "lb", projectId: "b", name: "lane: same", color: "blue" },
    { id: "lc", projectId: "a", name: "lane: other", color: "blue" },
  ];
  const tasks = [
    task({
      id: "a-task",
      projectId: "a",
      labelIds: ["la"],
      status: "in_progress",
    }),
    task({ id: "b-task", projectId: "b", labelIds: ["lb"] }),
  ];
  const importer = new LaneImporter(r, {
    listLabels: async (p: string) => labels.filter((l) => l.projectId === p),
    listTasks: async ({ projectId }: any) => ({
      tasks: tasks.filter((t) => t.projectId === projectId),
      nextCursor: null,
    }),
  });
  const mapping = [
    { projectId: "a", labelId: "la", laneId: a.id },
    { projectId: "b", labelId: "lb", laneId: b.id },
  ];
  return { r, a, b, labels, tasks, importer, mapping, harness };
}
test("same label names on different boards stay separate; explicit mappings may share a lane", async () => {
  const { r, a, b, importer, mapping, harness } = setup();
  const p = await importer.preview({ mapping });
  assert.equal(p.effects.length, 2);
  await importer.apply({ previewId: p.id, resolutions: [] });
  assert.equal(r.membership("a-task").laneId, a.id);
  assert.equal(r.membership("b-task").laneId, b.id);
  const next = await importer.preview({
    mapping: mapping.map((m) => ({ ...m, laneId: a.id })),
  });
  assert.equal(next.effects.find((e) => e.taskId === "b-task")?.conflict, true);
  await importer.apply({
    previewId: next.id,
    resolutions: [{ taskId: "b-task", laneId: a.id }],
  });
  assert.equal(r.membership("b-task").laneId, a.id);
  await harness.lifecycle.dispose();
});
test("two selected labels or an existing membership require an explicit decision", async () => {
  const { r, a, b, tasks, importer, mapping, harness } = setup();
  tasks[0]!.labelIds.push("lc");
  r.setMembership("b-task", a.id, 0);
  const p = await importer.preview({
    mapping: [...mapping, { projectId: "a", labelId: "lc", laneId: b.id }],
  });
  assert.equal(p.effects.filter((e) => e.conflict).length, 2);
  await assert.rejects(
    () => importer.apply({ previewId: p.id, resolutions: [] }),
    /resolution/i,
  );
  assert.equal(r.membership("a-task").revision, 0);
  await importer.apply({
    previewId: p.id,
    resolutions: [
      { taskId: "a-task", laneId: b.id },
      { taskId: "b-task", laneId: null },
    ],
  });
  assert.equal(r.membership("a-task").laneId, b.id);
  assert.equal(r.membership("b-task").laneId, a.id);
  await harness.lifecycle.dispose();
});
test("changed labels, tasks, lane revisions or membership invalidate preview atomically", async () => {
  for (const change of ["label", "task", "membership", "lane", "disappear"]) {
    const { r, a, labels, tasks, importer, mapping, harness } = setup();
    const p = await importer.preview({ mapping });
    if (change === "label") labels[0]!.name = "lane: changed";
    if (change === "task") tasks[0]!.labelIds = [];
    if (change === "membership") r.setMembership("b-task", a.id, 0);
    if (change === "lane") r.update(a.id, { state: "archived" }, 1);
    if (change === "disappear") labels.splice(0, 1);
    await assert.rejects(
      () => importer.apply({ previewId: p.id, resolutions: [] }),
      /changed|exist|archived/i,
    );
    assert.equal(r.membership("a-task").revision, 0);
    await harness.lifecycle.dispose();
  }
});
test("receipts reconcile an unknown outcome after restart without replay or changing core fields", async () => {
  const { r, tasks, labels, importer, mapping, harness } = setup();
  const core = JSON.stringify({ tasks, labels });
  const p = await importer.preview({ mapping });
  const first = await importer.apply({ previewId: p.id, resolutions: [] });
  const version = r.version;
  const restarted = new LaneImporter(r, {
    listLabels: async () => {
      throw new Error("offline");
    },
    listTasks: async () => {
      throw new Error("offline");
    },
  });
  const again = await restarted.apply({ previewId: p.id, resolutions: [] });
  assert.deepEqual(again, first);
  assert.equal(first.applied, 2);
  assert.equal(r.version, version);
  assert.equal(JSON.stringify({ tasks, labels }), core);
  await assert.rejects(
    () =>
      restarted.apply({
        previewId: p.id,
        resolutions: [{ taskId: "a-task", laneId: null }],
      }),
    /receipt|different/i,
  );
  await harness.lifecycle.dispose();
});
test("a late unresolved conflict rolls back earlier effects and no receipt survives", async () => {
  const { r, a, importer, mapping, harness } = setup();
  r.setMembership("b-task", a.id, 0);
  const p = await importer.preview({ mapping });
  await assert.rejects(
    () => importer.apply({ previewId: p.id, resolutions: [] }),
    /resolution/i,
  );
  assert.equal(r.membership("a-task").revision, 0);
  assert.equal(
    (
      await importer.apply({
        previewId: p.id,
        resolutions: [{ taskId: "b-task", laneId: null }],
      })
    ).applied,
    1,
  );
  await harness.lifecycle.dispose();
});
test("invalid mappings and resolutions never widen preview authority", async () => {
  const { r, a, b, labels, importer, mapping, harness } = setup();
  await assert.rejects(
    () => importer.preview({ mapping: [mapping[0], mapping[0]] }),
    /once/i,
  );
  await assert.rejects(
    () => importer.preview({ mapping: [{ ...mapping[0], laneId: "absent" }] }),
    /exist/i,
  );
  const p = await importer.preview({ mapping });
  await assert.rejects(
    () =>
      importer.apply({
        previewId: p.id,
        resolutions: [{ taskId: "outside", laneId: a.id }],
      }),
    /outside/i,
  );
  await assert.rejects(
    () =>
      importer.apply({
        previewId: p.id,
        resolutions: [{ taskId: "a-task", laneId: b.id }],
      }),
    /reviewed/i,
  );
  assert.equal(r.membership("a-task").revision, 0);
  labels[0]!.name = "ordinary";
  await assert.rejects(() => importer.preview({ mapping }), /lane:/i);
  await harness.lifecycle.dispose();
});
