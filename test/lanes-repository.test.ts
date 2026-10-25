import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaneRepository, MIGRATIONS } from "../lib/lanes/repository.ts";

function repo() {
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  return { db, r: new LaneRepository(db) };
}
test("lane identity and cross-board memberships persist across reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "lanes-"));
  const path = join(dir, "prior-stateless-plugin.db");
  let db = new Database(path);
  // Prior version owned no tables: migration of an empty SQLite file is the upgrade fixture.
  for (const sql of MIGRATIONS) db.exec(sql);
  let r = new LaneRepository(db);
  const lane = r.create({
    name: "Goal",
    goal: "Ship",
    ownerThreadId: "thread-a",
  });
  r.setMembership("board-a-task", lane.id, 0);
  r.setMembership("board-b-task", lane.id, 0);
  r.update(lane.id, { name: "Renamed", ownerThreadId: "thread-b" }, 1);
  db.close();
  db = new Database(path);
  r = new LaneRepository(db);
  assert.equal(r.get(lane.id)?.name, "Renamed");
  assert.equal(r.snapshot().memberships.length, 2);
  assert.equal(r.get(lane.id)?.ownerThreadId, "thread-b");
  db.close();
  rmSync(dir, { recursive: true });
});
test("stale lane revisions return current value without publishing a change", () => {
  const { r } = repo();
  const l = r.create({ name: "A", goal: "" });
  r.update(l.id, { goal: "new" }, 1);
  const version = r.snapshot().version;
  const result = r.update(l.id, { name: "stale" }, 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.current?.revision, 2);
  assert.equal(r.get(l.id)?.name, "A");
  assert.equal(r.snapshot().version, version);
});
test("membership tombstones reject stale assign and stale unassign", () => {
  const { r } = repo();
  const l = r.create({ name: "A", goal: "" });
  r.setMembership("task", l.id, 0);
  r.setMembership("task", null, 1);
  assert.equal(r.setMembership("task", l.id, 0).ok, false);
  assert.equal(r.setMembership("task", l.id, 1).ok, false);
  assert.equal(r.setMembership("task", l.id, 2).ok, true);
  assert.equal(r.setMembership("task", null, 2).ok, false);
  assert.equal(r.membership("task").laneId, l.id);
});
test("archive preserves memberships; new assignment requires restoration", () => {
  const { r } = repo();
  const l = r.create({ name: "A", goal: "" });
  r.setMembership("old-task", l.id, 0);
  r.update(l.id, { state: "parked" }, 1);
  r.update(l.id, { state: "archived" }, 2);
  assert.equal(r.membership("old-task").laneId, l.id);
  assert.throws(() => r.setMembership("new-task", l.id, 0), /archived/i);
  r.update(l.id, { state: "active" }, 3);
  assert.equal(r.setMembership("new-task", l.id, 0).ok, true);
});
test("change cursor survives restart, bounds history and resets stale readers", () => {
  const { r, db } = repo();
  const l = r.create({ name: "A", goal: "" });
  assert.equal(new LaneRepository(db).snapshot().version, 1);
  for (let i = 1; i <= 1005; i++) r.update(l.id, { goal: String(i) }, i);
  assert.equal(r.changesSince(0), null);
  const v = r.snapshot().version;
  assert.equal(r.changesSince(v - 1)?.to, v);
  assert.deepEqual(r.changesSince(v)?.events, []);
  assert.equal(r.changesSince(v + 1), null);
});
