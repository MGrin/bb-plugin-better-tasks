import assert from "node:assert/strict";
import { test } from "node:test";
import type { Row, Status } from "../lib/model.ts";
import { ClientStore, type Snapshot } from "../lib/store.ts";
import {
  DEFAULT_FILTERS,
  flattenGroups,
  groupRows,
  parseFilters,
  visibleStatuses,
} from "../lib/view.ts";
import { indexAt, prefixOffsets, scrollToReveal, windowRange } from "../lib/virtual.ts";

let serial = 0;
function row(overrides: Partial<Row> = {}): Row {
  serial += 1;
  return {
    id: `r${serial}`,
    key: `DEMO-${serial}`,
    projectId: "p1",
    number: serial,
    title: `Synthetic row ${serial}`,
    status: "todo",
    priority: "none",
    dueDate: null,
    parentTaskId: null,
    position: serial,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    labelIds: [],
    live: [],
    rev: 1,
    ...overrides,
  };
}

const counts: Record<Status, number> = {
  in_progress: 0,
  in_review: 0,
  todo: 0,
  backlog: 0,
  done: 0,
  canceled: 0,
};

function snapshot(rows: Row[], version: number): Snapshot {
  return { version, rows, projects: [], labels: [], counts, complete: true };
}

test("store: an older row never replaces a newer one", () => {
  const store = new ClientStore();
  const fresh = row({ rev: 5, title: "new" });
  store.applySnapshot(snapshot([fresh], 5), "open");
  store.applySnapshot(snapshot([{ ...fresh, rev: 3, title: "old" }], 6), "closed");
  assert.equal(store.rows.get(fresh.id)?.title, "new");
});

test("store: deltas that arrive before the first snapshot are replayed", () => {
  const store = new ClientStore();
  const early = row({ rev: 11, status: "in_review" });
  assert.equal(
    store.onDelta({ kind: "rows", from: 10, to: 11, upserts: [early], removes: [] }),
    "buffered",
  );
  store.applySnapshot(snapshot([{ ...early, rev: 9, status: "todo" }], 10), "open");
  assert.equal(store.rows.get(early.id)?.status, "in_review");
});

test("store: a gap asks for a pull; a contiguous delta does not", () => {
  const store = new ClientStore();
  store.applySnapshot(snapshot([], 10), "open");
  assert.equal(store.onDelta({ kind: "rows", from: 10, to: 12, upserts: [], removes: [] }), "applied");
  assert.equal(store.version, 12);
  assert.equal(store.onDelta({ kind: "rows", from: 15, to: 16, upserts: [], removes: [] }), "pull");
  assert.equal(store.version, 12);
  assert.equal(store.onDelta({ kind: "range", from: 12, to: 40 }), "pull");
});

test("store: a removal is not undone by a stale snapshot", () => {
  const store = new ClientStore();
  const doomed = row({ rev: 2 });
  store.applySnapshot(snapshot([doomed], 2), "open");
  store.onDelta({ kind: "rows", from: 2, to: 3, upserts: [], removes: [{ id: doomed.id, rev: 3 }] });
  store.applySnapshot(snapshot([doomed], 2), "closed");
  assert.equal(store.rows.has(doomed.id), false);
});

test("store: optimistic change rolls back only if nothing newer arrived", () => {
  const store = new ClientStore();
  const item = row({ rev: 1 });
  store.applySnapshot(snapshot([item], 1), "open");
  const rollback = store.optimistic(item.id, { status: "done" });
  assert.equal(store.rows.get(item.id)?.status, "done");
  rollback();
  assert.equal(store.rows.get(item.id)?.status, "todo");
  const rollback2 = store.optimistic(item.id, { status: "done" });
  store.upsertRow({ ...item, status: "in_review", rev: 2 });
  rollback2();
  assert.equal(store.rows.get(item.id)?.status, "in_review");
});

test("view: open work first, closed work newest first", () => {
  const rows = [
    row({ status: "done", updatedAt: "2026-02-01T00:00:00.000Z" }),
    row({ status: "done", updatedAt: "2026-03-01T00:00:00.000Z" }),
    row({ status: "in_progress", priority: "low" }),
    row({ status: "in_progress", priority: "urgent" }),
  ];
  const groups = groupRows(rows, DEFAULT_FILTERS);
  assert.deepEqual(
    groups.in_progress.map((item) => item.priority),
    ["urgent", "low"],
  );
  assert.equal(groups.done[0]?.updatedAt, "2026-03-01T00:00:00.000Z");
  const items = flattenGroups(groups, visibleStatuses(DEFAULT_FILTERS), new Set(["done"]));
  assert.deepEqual(
    items.map((item) => (item.kind === "header" ? `#${item.status}:${item.count}` : item.row.status)),
    ["#in_progress:2", "in_progress", "in_progress", "#done:2"],
  );
});

test("view: search matches every term in key or title, or a server hit", () => {
  const a = row({ title: "Fix the flaky login test" });
  const b = row({ title: "Write docs" });
  const filters = { ...DEFAULT_FILTERS, search: "flaky LOGIN" };
  assert.deepEqual(groupRows([a, b], filters).todo, [a]);
  assert.deepEqual(groupRows([a, b], filters, new Set([b.id])).todo.length, 2);
  assert.deepEqual(groupRows([a, b], { ...DEFAULT_FILTERS, search: b.key.toLowerCase() }).todo, [b]);
});

test("view: filters by project, priority, label and live threads", () => {
  const live = row({ live: [{ threadId: "thr_x", title: "w", liveStatus: "working" }] });
  const labelled = row({ labelIds: ["l1"], priority: "high", projectId: "p2" });
  const rows = [live, labelled, row()];
  assert.deepEqual(groupRows(rows, { ...DEFAULT_FILTERS, liveOnly: true }).todo, [live]);
  assert.deepEqual(groupRows(rows, { ...DEFAULT_FILTERS, labelIds: ["l1"] }).todo, [labelled]);
  assert.deepEqual(groupRows(rows, { ...DEFAULT_FILTERS, priorities: ["high"] }).todo, [labelled]);
  assert.deepEqual(groupRows(rows, { ...DEFAULT_FILTERS, projectIds: ["p2"] }).todo, [labelled]);
});

test("view: persisted filters are parsed defensively", () => {
  const parsed = parseFilters({ statuses: ["todo", "bogus"], sort: "nope", search: 5, liveOnly: "yes" });
  assert.deepEqual(parsed.statuses, ["todo"]);
  assert.equal(parsed.sort, "priority");
  assert.equal(parsed.search, "");
  assert.equal(parsed.liveOnly, false);
  assert.deepEqual(parseFilters(null), DEFAULT_FILTERS);
});

test("virtual: window covers the viewport plus overscan", () => {
  const offsets = prefixOffsets(1000, (index) => (index % 100 === 0 ? 36 : 40));
  assert.equal(offsets[1], 36);
  assert.equal(indexAt(offsets, 0), 0);
  assert.equal(indexAt(offsets, 36), 1);
  const [start, end] = windowRange(offsets, 4000, 800, 5);
  assert.ok(offsets[start]! <= 4000 - 5 * 36);
  assert.ok(offsets[end]! >= 4800);
  assert.ok(end - start < 40, `renders ${end - start} items, not 1000`);
  assert.deepEqual(windowRange([0], 0, 800, 5), [0, 0]);
});

test("virtual: reveal scrolls only when the item is out of view", () => {
  const offsets = prefixOffsets(100, () => 40);
  assert.equal(scrollToReveal(offsets, 5, 0, 400), null);
  assert.equal(scrollToReveal(offsets, 20, 0, 400), 440);
  assert.equal(scrollToReveal(offsets, 2, 400, 400), 80);
});

test("view: one status order for list and board, backlog first", () => {
  assert.deepEqual(visibleStatuses(DEFAULT_FILTERS), [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "done",
    "canceled",
  ]);
});
