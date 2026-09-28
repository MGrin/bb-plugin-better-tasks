import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeltaSignal } from "../lib/model.ts";
import { TaskSync } from "../lib/sync.ts";
import { FakeTasks, task } from "./fixtures.ts";

function setup() {
  const fake = new FakeTasks();
  const published: { channel: string; payload: unknown }[] = [];
  const sync = new TaskSync({
    api: fake,
    publish: (channel, payload) => published.push({ channel, payload }),
    debounceMs: 1,
  });
  const deltas = () =>
    published.filter((entry) => entry.channel === "delta").map((entry) => entry.payload as DeltaSignal);
  return { fake, sync, published, deltas };
}

test("full load caches every task and resolves open before closed", async () => {
  const { fake, sync } = setup();
  for (let index = 0; index < 1200; index += 1) {
    fake.add(task({ status: index % 10 === 0 ? "todo" : "done" }));
  }
  let openAt = -1;
  void sync.openReady.then(() => (openAt = sync.cache.size));
  await sync.fullLoad();
  assert.equal(sync.cache.size, 1200);
  assert.equal(openAt, 120, "open work was ready before any closed page was read");
});

test("a tasks:changed signal re-reads that one task, never the whole set", async () => {
  const { fake, sync, deltas } = setup();
  const items = Array.from({ length: 50 }, () => task());
  fake.add(...items);
  await sync.fullLoad();
  fake.calls = [];
  const target = items[7]!;
  fake.tasks.set(target.id, { ...target, status: "in_review" });
  sync.onSignal("tasks:changed", { taskId: target.id, projectId: target.projectId });
  await sync.settle();
  assert.deepEqual(fake.calls, ["getTask"]);
  const last = deltas().at(-1)!;
  assert.equal(last.kind, "rows");
  assert.equal(last.kind === "rows" && last.upserts[0]?.status, "in_review");
});

test("a burst of duplicate signals collapses into one read per task", async () => {
  const { fake, sync } = setup();
  const items = Array.from({ length: 5 }, () => task());
  fake.add(...items);
  await sync.fullLoad();
  fake.calls = [];
  for (let round = 0; round < 20; round += 1) {
    for (const item of items) sync.onSignal("threads:changed", { taskId: item.id });
  }
  await sync.settle();
  assert.equal(fake.calls.filter((call) => call === "listTaskThreads").length, 5);
  assert.ok(!fake.calls.includes("listTasks"));
});

test("threads:changed that changes nothing publishes no delta", async () => {
  const { fake, sync, deltas } = setup();
  const item = task();
  fake.add(item);
  await sync.fullLoad();
  const before = deltas().length;
  sync.onSignal("threads:changed", { taskId: item.id });
  await sync.settle();
  assert.equal(deltas().length, before);
});

test("live threads are tracked from the start and from signals", async () => {
  const { fake, sync } = setup();
  const busy = task();
  const quiet = task();
  fake.add(busy, quiet);
  fake.threads.set(busy.id, [
    { threadId: "thr_1", title: "Worker", liveStatus: "working" },
    { threadId: "thr_2", title: "Old", liveStatus: "completed" },
  ]);
  await sync.fullLoad();
  assert.deepEqual(
    sync.cache.get(busy.id)?.live.map((thread) => thread.threadId),
    ["thr_1"],
  );
  fake.threads.set(quiet.id, [{ threadId: "thr_3", title: "New", liveStatus: "starting" }]);
  sync.onSignal("threads:changed", { taskId: quiet.id });
  await sync.settle();
  assert.equal(sync.cache.get(quiet.id)?.live[0]?.threadId, "thr_3");
});

test("a deleted task is removed and announced", async () => {
  const { fake, sync, deltas } = setup();
  const item = task();
  fake.add(item);
  await sync.fullLoad();
  fake.tasks.delete(item.id);
  sync.onSignal("tasks:changed", { taskId: item.id });
  await sync.settle();
  assert.equal(sync.cache.get(item.id), undefined);
  const last = deltas().at(-1)!;
  assert.equal(last.kind === "rows" && last.removes[0]?.id, item.id);
});

test("a reload drops tasks that vanished while the feed was down", async () => {
  const { fake, sync } = setup();
  const keep = task();
  const gone = task();
  fake.add(keep, gone);
  await sync.fullLoad();
  fake.tasks.delete(gone.id);
  await sync.requestFullLoad();
  assert.equal(sync.cache.size, 1);
  assert.ok(sync.cache.get(keep.id));
});

test("a large change set is announced as a range, not inline rows", async () => {
  const { fake, sync, deltas } = setup();
  for (let index = 0; index < 1000; index += 1) fake.add(task());
  await sync.fullLoad();
  assert.ok(deltas().some((delta) => delta.kind === "range"));
});

test("a cursor invalidated mid-read restarts that pass instead of failing the load", async () => {
  const { fake, sync } = setup();
  for (let index = 0; index < 1200; index += 1) fake.add(task({ status: "done" }));
  fake.staleCursors = 2;
  await sync.fullLoad();
  assert.equal(sync.cache.size, 1200);
  assert.equal(sync.loaded, true);
});
