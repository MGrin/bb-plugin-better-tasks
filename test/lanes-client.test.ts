import { test } from "node:test";
import assert from "node:assert/strict";
import { LaneClient } from "../lib/lanes/client.ts";
const lane = {
  id: "a",
  name: "A",
  goal: "",
  state: "active" as const,
  ownerThreadId: null,
  revision: 1,
  createdAt: "",
  updatedAt: "",
};
test("lane snapshots and duplicates never roll back newer data", () => {
  const c = new LaneClient();
  c.snapshot({ version: 1, lanes: [lane], memberships: [] });
  assert.equal(
    c.changes({
      from: 1,
      to: 2,
      events: [
        {
          version: 2,
          kind: "lane",
          value: { ...lane, name: "new", revision: 2 },
        },
      ],
    }),
    "applied",
  );
  c.snapshot({ version: 1, lanes: [lane], memberships: [] });
  assert.equal(c.lanes.get("a")?.name, "new");
  c.changes({
    from: 1,
    to: 2,
    events: [{ version: 2, kind: "lane", value: lane }],
  });
  assert.equal(c.lanes.get("a")?.name, "new");
});
test("gaps request lane-only reconciliation; reset replaces and preserves tombstones", () => {
  const c = new LaneClient();
  c.snapshot({ version: 0, lanes: [], memberships: [] });
  assert.equal(c.changes({ from: 2, to: 3, events: [] }), "pull");
  assert.equal(c.version, 0);
  c.snapshot({
    version: 3,
    lanes: [lane],
    memberships: [
      { taskId: "unloaded", laneId: "a", revision: 1, updatedAt: "" },
    ],
  });
  assert.equal(c.memberships.get("unloaded")?.laneId, "a");
  c.changes({
    from: 3,
    to: 4,
    events: [
      {
        version: 4,
        kind: "membership",
        value: { taskId: "unloaded", laneId: null, revision: 2, updatedAt: "" },
      },
    ],
  });
  assert.equal(c.memberships.get("unloaded")?.revision, 2);
});
test("an authoritative reset accepts an older restored database without trusting late snapshots", () => {
  const c = new LaneClient();
  c.snapshot({ version: 10, lanes: [lane], memberships: [] });
  c.snapshot({ version: 1, lanes: [], memberships: [] });
  assert.equal(c.version, 10);
  c.snapshot({ version: 1, lanes: [], memberships: [] }, true);
  assert.equal(c.version, 1);
  assert.equal(c.lanes.size, 0);
});
