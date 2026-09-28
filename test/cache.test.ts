import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskCache } from "../lib/cache.ts";
import { task } from "./fixtures.ts";

test("an identical upsert does not bump the version", () => {
  const cache = new TaskCache();
  const item = task();
  assert.equal(cache.upsert(item), true);
  assert.equal(cache.version, 1);
  assert.equal(cache.upsert({ ...item, labelIds: [...item.labelIds] }), false);
  assert.equal(cache.version, 1);
});

test("a changed field bumps the version and stamps the row's rev", () => {
  const cache = new TaskCache();
  const item = task();
  cache.upsert(item);
  cache.upsert({ ...item, status: "done" });
  assert.equal(cache.version, 2);
  assert.equal(cache.get(item.id)?.rev, 2);
  assert.equal(cache.get(item.id)?.status, "done");
});

test("upsert without live keeps the cached live threads", () => {
  const cache = new TaskCache();
  const item = task();
  cache.upsert(item, [{ threadId: "thr_a", title: "Worker", liveStatus: "working" }]);
  cache.upsert({ ...item, title: "Renamed" });
  assert.equal(cache.get(item.id)?.live.length, 1);
});

test("changesSince returns only rows touched after the version", () => {
  const cache = new TaskCache();
  const a = task();
  const b = task();
  cache.upsert(a);
  cache.upsert(b);
  const at = cache.version;
  cache.upsert({ ...a, priority: "high" });
  cache.remove(b.id);
  const changes = cache.changesSince(at);
  assert.ok(changes);
  assert.deepEqual(
    changes.upserts.map((row) => row.id),
    [a.id],
  );
  assert.deepEqual(changes.removes, [{ id: b.id, rev: cache.version }]);
  assert.equal(changes.to, cache.version);
});

test("changesSince reports null once the log no longer reaches back", () => {
  const cache = new TaskCache({ logLimit: 4 });
  const item = task();
  for (let index = 0; index < 10; index += 1) {
    cache.upsert({ ...item, position: index });
  }
  assert.equal(cache.changesSince(0), null);
  assert.ok(cache.changesSince(cache.version - 2));
});

test("rows splits open from closed work", () => {
  const cache = new TaskCache();
  cache.upsert(task({ status: "todo" }));
  cache.upsert(task({ status: "in_progress" }));
  cache.upsert(task({ status: "done" }));
  cache.upsert(task({ status: "canceled" }));
  assert.equal(cache.rows("open").length, 2);
  assert.equal(cache.rows("closed").length, 2);
  assert.equal(cache.rows("all").length, 4);
  assert.equal(cache.countsByStatus().done, 1);
});
