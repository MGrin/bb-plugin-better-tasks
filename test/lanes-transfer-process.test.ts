import { test } from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import Database from "better-sqlite3";
import { LaneRepository } from "../lib/lanes/repository.ts";
import { LaneService } from "../lib/lanes/service.ts";
import { setup, request } from "./lanes-transfer-fixtures.ts";

function child(path: string, mode: string, input = request(), release = "") {
  const p = fork(
    new URL("./fixtures/lane-process.ts", import.meta.url),
    [path, mode, JSON.stringify(input), release],
    { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  const messages: any[] = [];
  let error = "";
  p.stderr!.on("data", (data) => {
    error += data;
  });
  p.on("message", (message) => messages.push(message));
  const stage = async (name: string): Promise<any> => {
    for (;;) {
      const found = messages.find((m) => m.stage === name);
      if (found) return found;
      if (
        messages.some((m) => m.stage === "error") ||
        p.exitCode !== null ||
        p.signalCode !== null
      )
        throw Error(JSON.stringify(messages) + error);
      await Promise.race([
        once(p, "message"),
        once(p, "exit").then(() => {
          throw Error("Child exited: " + error);
        }),
      ]);
    }
  };
  return { p, stage, messages };
}
async function stop(p: ChildProcess) {
  if (p.exitCode === null && p.signalCode === null) {
    const exited = once(p, "exit");
    p.kill("SIGKILL");
    await exited;
  }
}
function file() {
  const dir = mkdtempSync(join(tmpdir(), "lanes-transfer-"));
  const path = join(dir, "lanes.db");
  const x = setup(path);
  x.db.pragma("journal_mode = WAL");
  x.db.pragma("synchronous = FULL");
  return { ...x, dir, path, release: join(dir, "release") };
}

test(
  "F01 observation excludes a concurrent process writer from all selected rows",
  { timeout: 15000 },
  async () => {
    const x = file();
    const read = child(
      x.path,
      "observe",
      { op: "observe", taskId: "T", destinationLaneId: "B" } as any,
      x.release,
    );
    const writer = child(x.path, "compete");
    try {
      await read.stage("snapshot");
      await writer.stage("preflight");
      writer.p.send("go");
      await writer.stage("entering");
      writeFileSync(x.release, "release");
      const observed = (await read.stage("result")).result.observation;
      assert.equal(observed.version, 9);
      assert.equal(observed.membership.revision, 3);
      assert.equal(observed.source.lane.revision, 4);
      assert.equal(observed.destination.lane.revision, 7);
      assert.equal(
        (await writer.stage("result")).result.receipt.outcome,
        "applied",
      );
    } finally {
      await stop(read.p);
      await stop(writer.p);
      x.db.close();
      rmSync(x.dir, { recursive: true });
    }
  },
);

for (const same of [false, true])
  test(
    `${same ? "F06" : "F05"} two preflighted processes serialize identical CAS with ${same ? "same" : "distinct"} IDs`,
    { timeout: 15000 },
    async () => {
      const x = file();
      const q = request();
      if (!same) q.operationId = "22222222-2222-4222-8222-222222222222";
      const p1 = child(x.path, "compete");
      const p2 = child(x.path, "compete", q);
      try {
        await Promise.all([p1.stage("preflight"), p2.stage("preflight")]);
        p1.p.send("go");
        const a = (await p1.stage("result")).result;
        p2.p.send("go");
        const b = (await p2.stage("result")).result;
        assert.equal(a.receipt.outcome, "applied");
        assert.equal(b.receipt.outcome, same ? "applied" : "conflict");
        if (same) assert.deepEqual(a, b);
        else assert.equal(b.receipt.reason, "membership_changed");
        assert.deepEqual(await x.run(q), b);
        assert.equal(x.r.membership("T").revision, 4);
        assert.equal(x.r.version, 10);
        assert.equal(x.r.changesSince(9)!.events.length, 1);
        assert.deepEqual(
          x.db.prepare("SELECT count(*) n FROM lane_operations").get(),
          { n: same ? 1 : 2 },
        );
      } finally {
        await stop(p1.p);
        await stop(p2.p);
        x.db.close();
        rmSync(x.dir, { recursive: true });
      }
    },
  );

for (const stage of ["precommit", "postcommit"])
  test(
    `${stage === "precommit" ? "F16" : "F17"} SIGKILL at ${stage} recovers both effects and receipt or neither`,
    { timeout: 15000 },
    async () => {
      const x = file();
      const p = child(x.path, stage);
      try {
        await p.stage(stage);
        await stop(p.p);
        x.db.close();
        const db = new Database(x.path);
        const r = new LaneRepository(db);
        const receipt = r.operation(request().operationId);
        assert.equal(
          receipt?.outcome ?? "not_found",
          stage === "precommit" ? "not_found" : "applied",
        );
        assert.equal(r.membership("T").revision, stage === "precommit" ? 3 : 4);
        assert.equal(r.version, stage === "precommit" ? 9 : 10);
        const s = new LaneService(r, {
          getTask: async (id) => {
            if (stage === "postcommit")
              throw Error("replay performed preflight");
            return { id };
          },
          getOwner: async () => {
            throw Error("owner read");
          },
        });
        const retry: any = await s.execute(request());
        assert.equal(retry.receipt.outcome, "applied");
        if (receipt) assert.deepEqual(retry.receipt, receipt);
        assert.equal(r.membership("T").revision, 4);
        assert.equal(r.version, 10);
        db.close();
      } finally {
        await stop(p.p);
        if (x.db.open) x.db.close();
        rmSync(x.dir, { recursive: true });
      }
    },
  );

test(
  "F33 busy is an infrastructure error and same-ID retry remains safe",
  { timeout: 15000 },
  async () => {
    const x = file();
    x.db.pragma("busy_timeout = 20");
    const holder = child(x.path, "lock", request(), x.release);
    try {
      await holder.stage("locked");
      await assert.rejects(
        () => x.run(request()),
        (e: any) => e.code === "SQLITE_BUSY",
      );
      assert.equal((await x.lookup()).status, "not_found");
      writeFileSync(x.release, "release");
      await once(holder.p, "exit");
      assert.equal((await x.run(request())).receipt.outcome, "applied");
      assert.equal(x.r.version, 10);
    } finally {
      await stop(holder.p);
      x.db.close();
      rmSync(x.dir, { recursive: true });
    }
  },
);

test("F14 F34 reopen and isolated restore expose local history only; crash tests do not prove power-loss durability", async (t) => {
  const x = file();
  t.diagnostic(
    JSON.stringify({
      journal_mode: x.db.pragma("journal_mode", { simple: true }),
      synchronous: x.db.pragma("synchronous", { simple: true }),
    }),
  );
  x.db.pragma("wal_checkpoint(TRUNCATE)");
  const backup = join(x.dir, "before.db");
  copyFileSync(x.path, backup);
  const p = request();
  p.laneId = p.expected.destination = null;
  await x.run(p);
  x.db.close();
  const reopened = new Database(x.path);
  assert.equal(
    new LaneRepository(reopened).operation(p.operationId)?.outcome,
    "applied",
  );
  reopened.close();
  const restored = new Database(backup);
  const r = new LaneRepository(restored);
  assert.equal(r.operation(p.operationId), null);
  assert.equal(r.membership("T").revision, 3);
  restored.close();
  rmSync(x.dir, { recursive: true });
});
