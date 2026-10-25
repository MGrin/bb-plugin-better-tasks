import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, request, A, B, binding } from "./lanes-transfer-fixtures.ts";

test("F01 F02 F03 bounded diagnostic observation preserves absent and tombstone semantics", async () => {
  const { db, r, observe } = setup(":memory:", {
    getTask: async () => {
      throw Error("external read");
    },
    getOwner: async () => {
      throw Error("external read");
    },
  });
  r.list = r.snapshot = () => {
    throw Error("unbounded read");
  };
  const o = await observe();
  assert.equal(o.version, 9);
  assert.equal(o.source.lane.revision, 4);
  assert.equal(o.destination.lane.revision, 7);
  db.exec("DELETE FROM lane_memberships");
  assert.deepEqual((await observe()).membership, {
    taskId: "T",
    laneId: null,
    revision: 0,
    updatedAt: "",
  });
  assert.deepEqual((await observe()).source, { kind: "none" });
  r.setMembership("T", null, 0);
  assert.equal((await observe()).membership.revision, 1);
  assert.deepEqual(db.prepare("SELECT count(*) n FROM lane_operations").get(), {
    n: 0,
  });
  db.close();
});

test("F07 F08 F14 exact replay precedes upstream reads and binds every semantic field", async () => {
  let calls = 0;
  const { db, run, r, lookup } = setup(":memory:", {
    getTask: async (id) => {
      calls++;
      return { id };
    },
  });
  const p = request();
  const first = await run(p);
  assert.equal(first.receipt.outcome, "applied");
  assert.equal(first.receipt.after.version, 10);
  assert.equal(first.receipt.after.membership.revision, 4);
  const reordered = Object.fromEntries(Object.entries(p).reverse());
  assert.deepEqual(await run(reordered), first);
  assert.equal(calls, 1);
  await assert.rejects(
    () => run({ ...p, expected: { ...p.expected, membershipRevision: 4 } }),
    /operation_id_reused/,
  );
  assert.equal((await lookup()).status, "found");
  const unassign = {
    ...p,
    operationId: "22222222-2222-4222-8222-222222222222",
    laneId: null,
    expected: {
      membershipRevision: 4,
      fromLaneId: "B",
      source: binding(B),
      destination: null,
    },
  };
  assert.equal((await run(unassign)).receipt.outcome, "applied");
  assert.equal(calls, 1);
  assert.equal(r.membership("T").laneId, null);
  assert.equal(r.membership("T").revision, 5);
  db.close();
});

for (const [id, mutate, reason] of [
  [
    "F09",
    (x: any) => {
      x.r.update("A", { ownerThreadId: "c" }, 4);
      x.r.update("A", { ownerThreadId: "owner-a" }, 5);
    },
    "source_changed",
  ],
  [
    "F10",
    (x: any) => {
      x.r.update("B", { state: "parked" }, 7);
      x.r.update("B", { state: "active" }, 8);
    },
    "destination_changed",
  ],
  [
    "F11",
    (_: any, p: any) => {
      p.expected.destination.ownerThreadId = "other";
    },
    "destination_changed",
  ],
  [
    "F12",
    (_: any, p: any) => {
      p.expected.fromLaneId = "B";
      p.expected.source = binding(B);
    },
    "membership_changed",
  ],
  [
    "F13",
    (x: any, p: any) => {
      x.r.setMembership("T", "B", 3);
      p.laneId = null;
      p.expected.destination = null;
    },
    "membership_changed",
  ],
  [
    "F26",
    (x: any, p: any) => {
      x.r.update("B", { state: "archived" }, 7);
      p.expected.destination = {
        ...binding(B),
        revision: 8,
        state: "archived",
      };
    },
    "destination_archived",
  ],
  [
    "F28",
    (x: any) => x.db.exec("DELETE FROM lanes WHERE id='A'"),
    "lane_missing",
  ],
] as const)
  test(`${id} conflict is terminal and preserves membership`, async () => {
    const x = setup();
    const p = request();
    mutate(x, p);
    const before = x.r.membership("T");
    const receipt = (await x.run(p)).receipt;
    assert.equal(receipt.outcome, "conflict");
    assert.equal(receipt.reason, reason);
    assert.deepEqual(receipt.before, receipt.after);
    assert.deepEqual(x.r.membership("T"), before);
    assert.deepEqual((await x.run(p)).receipt, receipt);
    if (id === "F28")
      assert.deepEqual((await x.observe()).source, {
        kind: "missing",
        id: "A",
      });
    x.db.close();
  });

test("F24 F25 metadata allows parked/ownerless destination and removal from archived source", async () => {
  for (const mode of ["parked", "archived-source"]) {
    const x = setup();
    const p: any = request();
    if (mode === "parked") {
      x.r.update("B", { state: "parked", ownerThreadId: null }, 7);
      p.expected.destination = {
        ...binding(B),
        revision: 8,
        state: "parked",
        ownerThreadId: null,
      };
    } else {
      x.r.update("A", { state: "archived" }, 4);
      p.expected.source = { ...binding(A), revision: 5, state: "archived" };
      p.laneId = p.expected.destination = null;
    }
    assert.equal((await x.run(p)).receipt.outcome, "applied");
    assert.equal(x.r.membership("T").revision, 4);
    x.db.close();
  }
});

test("F27 validated no-ops preserve absence, tombstones and archived same-lane membership", async () => {
  for (const mode of ["same", "absent", "tombstone"]) {
    const x = setup();
    const p: any = request();
    if (mode === "same") {
      x.r.update("A", { state: "archived" }, 4);
      p.laneId = "A";
      p.expected.source = p.expected.destination = {
        ...binding(A),
        revision: 5,
        state: "archived",
      };
    } else {
      x.db.exec("DELETE FROM lane_memberships");
      if (mode === "tombstone") x.r.setMembership("T", null, 0);
      p.laneId =
        p.expected.fromLaneId =
        p.expected.source =
        p.expected.destination =
          null;
      p.expected.membershipRevision = mode === "absent" ? 0 : 1;
    }
    const before = x.r.snapshot();
    assert.equal((await x.run(p)).receipt.outcome, "unchanged");
    assert.deepEqual(x.r.snapshot(), before);
    assert.deepEqual(
      x.db.prepare("SELECT count(*) n FROM lane_operations").get(),
      { n: 1 },
    );
    x.db.close();
  }
});

test("F15 receipt failure rolls membership, clock and events back together", async () => {
  const x = setup();
  const before = x.r.snapshot();
  x.db.exec(
    "CREATE TRIGGER fail_receipt BEFORE INSERT ON lane_operations BEGIN SELECT RAISE(ABORT,'receipt failed'); END",
  );
  await assert.rejects(() => x.run(request()), /receipt failed/);
  assert.deepEqual(x.r.snapshot(), before);
  assert.equal((await x.lookup()).status, "not_found");
  x.db.close();
});

test("F18 F19 pending preflight and failed same-ID preflight reconcile committed receipt", async () => {
  for (const fail of [null, new Error("offline")]) {
    let finish!: (v: any) => void;
    let calls = 0;
    const x = setup(":memory:", {
      getTask: async (id) => {
        if (++calls === 1)
          return new Promise((resolve, reject) => {
            finish = () => (fail ? reject(fail) : resolve(null));
          });
        return { id };
      },
    });
    const waiting = x.run(request());
    assert.equal((await x.lookup()).status, "not_found");
    const applied = await x.run(request());
    finish(null);
    assert.deepEqual(await waiting, applied);
    assert.equal(x.r.membership("T").revision, 4);
    x.db.close();
  }
});

test("F21 F35 immutable receipts survive later state changes and feed compaction", async () => {
  for (const conflict of [false, true]) {
    const x = setup();
    if (conflict) x.r.update("B", { name: "new" }, 7);
    const receipt = await x.run(request());
    x.r.setMembership("T", "A", conflict ? 3 : 4);
    for (let i = 0; i < 1002; i++)
      x.r.update("B", { goal: String(i) }, (conflict ? 8 : 7) + i);
    const version = x.r.version;
    assert.deepEqual(await x.run(request()), receipt);
    assert.equal(x.r.version, version);
    assert.equal(receipt.receipt.outcome, conflict ? "conflict" : "applied");
    x.db.close();
  }
});

test("F31 upstream missing, failed or malformed tasks never produce receipts", async () => {
  for (const value of [
    null,
    undefined,
    {},
    { id: "wrong" },
    new Error("offline"),
  ]) {
    const x = setup(":memory:", {
      getTask: async () => {
        if (value instanceof Error) throw value;
        return value;
      },
    });
    await assert.rejects(() => x.run(request()), /task_(missing|unknown)/);
    assert.equal((await x.lookup()).status, "not_found");
    assert.equal(x.r.membership("T").revision, 3);
    x.db.close();
  }
});

test("F32 committed publish failure reconciles without a second event", async () => {
  const x = setup(":memory:", {}, () => {
    throw Error("publish failed");
  });
  await assert.rejects(() => x.run(request()), /publish failed/);
  assert.equal((await x.run(request())).receipt.outcome, "applied");
  assert.equal(x.r.changesSince(9)?.events.length, 1);
  x.db.close();
});

test("F36 unrelated writes cannot make observe, lookup, replay, conflict or unchanged publish", async () => {
  for (const mode of ["observe", "lookup", "replay", "conflict", "unchanged"]) {
    let signals = 0;
    const x = setup(":memory:", {}, () => {
      signals++;
    });
    const p = request();
    if (mode === "replay") await x.run(p);
    if (mode === "conflict") p.expected.membershipRevision = 0;
    if (mode === "unchanged") {
      p.laneId = "A";
      p.expected.destination = binding(A);
    }
    const before = signals;
    const pending =
      mode === "observe"
        ? x.observe()
        : mode === "lookup"
          ? x.lookup()
          : x.run(p);
    await x.run({ op: "create", name: "Unrelated" });
    await pending;
    assert.equal(signals - before, 1, mode);
    x.db.close();
  }
});

for (const [id, table, column, key, values] of [
  [
    "F30 F37",
    "lane_memberships",
    "task_id",
    "T",
    [
      "null",
      "{",
      JSON.stringify({
        taskId: "wrong",
        laneId: "A",
        revision: 3,
        updatedAt: "x",
      }),
      JSON.stringify({ taskId: "T", revision: 3, updatedAt: "x" }),
      JSON.stringify({ taskId: "T", laneId: "A", revision: 0, updatedAt: "" }),
      JSON.stringify({ taskId: "T", laneId: null, revision: 0, updatedAt: "" }),
      JSON.stringify({
        taskId: "T",
        laneId: "A",
        revision: 9007199254740992,
        updatedAt: "x",
      }),
    ],
  ],
  [
    "F30 F38",
    "lanes",
    "id",
    "A",
    [
      "null",
      JSON.stringify({ ...A, state: "wrong" }),
      JSON.stringify({ ...A, id: "wrong" }),
      JSON.stringify({ ...A, revision: 0 }),
    ],
  ],
] as const)
  test(`${id} raw rows fail closed without synthetic absence or terminal receipt`, async () => {
    for (const data of values) {
      const x = setup();
      x.db
        .prepare(`UPDATE ${table} SET data=? WHERE ${column}=?`)
        .run(data, key);
      await assert.rejects(x.observe, /invalid_observation/);
      await assert.rejects(() => x.run(request()), /invalid_observation/);
      assert.equal((await x.lookup()).status, "not_found");
      assert.equal(x.r.version, 9);
      x.db.close();
    }
  });

test("F04 F20 closed database errors are never absence", async () => {
  const x = setup();
  await x.run(request());
  x.db.close();
  await assert.rejects(x.observe);
  await assert.rejects(x.lookup);
});

test("F22 F23 local owner references cannot detect live BB archive/unarchive ABA", async () => {
  let ownerReads = 0;
  let archived = false;
  const x = setup(":memory:", {
    getOwner: async (id) => {
      ownerReads++;
      return { id, title: null, status: archived ? "archived" : "available" };
    },
  });
  const before = await x.observe();
  archived = true;
  assert.equal(
    (await x.run({ op: "owner", threadId: "owner-b" })).owner.status,
    "archived",
  );
  archived = false;
  assert.equal(
    (await x.run({ op: "owner", threadId: "owner-b" })).owner.status,
    "available",
  );
  assert.deepEqual(await x.observe(), before);
  assert.equal(ownerReads, 2);
  assert.equal(before.destination.lane.revision, 7);
  x.db.close();
});

test("F39 corrupt operation rows cannot prove application or absence", async () => {
  for (const mode of [
    "null",
    "version",
    "id",
    "request",
    "after",
    "stored-request",
  ]) {
    const x = setup();
    const receipt = (await x.run(request())).receipt;
    if (mode === "version") receipt.schemaVersion = 2;
    if (mode === "id")
      receipt.operationId = "22222222-2222-4222-8222-222222222222";
    if (mode === "request") receipt.request.expected.membershipRevision = 42;
    if (mode === "after") receipt.after.membership.taskId = "wrong";
    if (mode === "stored-request")
      x.db.exec("UPDATE lane_operations SET request='null'");
    else
      x.db
        .prepare("UPDATE lane_operations SET receipt=?")
        .run(mode === "null" ? "null" : JSON.stringify(receipt));
    await assert.rejects(x.lookup, /invalid_operation_record/);
    await assert.rejects(() => x.run(request()), /invalid_operation_record/);
    assert.equal(x.r.membership("T").revision, 4);
    x.db.close();
  }
});

test("F39 same-lane receipt rejects contradictory full lane references", async () => {
  const x = setup();
  const p = request();
  p.laneId = "A";
  p.expected.destination = binding(A);
  const receipt = (await x.run(p)).receipt;
  receipt.before.destination.lane.name = "Contradictory name";
  receipt.after.destination.lane.name = "Contradictory name";
  x.db
    .prepare("UPDATE lane_operations SET receipt=?")
    .run(JSON.stringify(receipt));
  await assert.rejects(x.lookup, /invalid_operation_record/);
  await assert.rejects(() => x.run(p), /invalid_operation_record/);
  x.db.close();
});

test("strict transfer bindings reject omitted nulls, inconsistent identities and unsafe numbers", async () => {
  for (const change of [
    (p: any) => {
      delete p.expected.source;
    },
    (p: any) => {
      p.expected.destination.id = "A";
    },
    (p: any) => {
      p.laneId = "A";
      p.expected.destination = { ...binding(A), revision: 5 };
    },
    (p: any) => {
      p.expected.membershipRevision = Number.MAX_SAFE_INTEGER + 1;
    },
    (p: any) => {
      p.operationId = "not-uuid";
    },
    (p: any) => {
      p.extra = true;
    },
  ]) {
    const x = setup();
    const p = request();
    change(p);
    await assert.rejects(() => x.run(p));
    assert.equal(x.r.version, 9);
    x.db.close();
  }
});
