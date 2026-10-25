// Only plugin-owned storage. Shipped migration statements must remain append-only.
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  Lane,
  LanePatch,
  LaneMembership,
  LaneSnapshot,
  LaneChanges,
  LaneEvent,
  WriteResult,
} from "./model.ts";

export const MIGRATIONS = [
  `CREATE TABLE lanes (id TEXT PRIMARY KEY, data TEXT NOT NULL);
   CREATE TABLE lane_memberships (task_id TEXT PRIMARY KEY, data TEXT NOT NULL);
   CREATE TABLE lane_clock (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
   INSERT INTO lane_clock VALUES (1,0);
   CREATE TABLE lane_changes (version INTEGER PRIMARY KEY, data TEXT NOT NULL);`,
  `CREATE TABLE lane_imports (id TEXT PRIMARY KEY, preview TEXT NOT NULL, receipt TEXT);`,
];

function read<T>(row: unknown): T | null {
  return row ? (JSON.parse((row as { data: string }).data) as T) : null;
}

export class LaneRepository {
  readonly db: Database.Database;
  constructor(db: Database.Database) {
    this.db = db;
  }

  atomic<T>(work: () => T): T {
    return this.db.transaction(work).immediate();
  }

  get version(): number {
    return (
      this.db.prepare("SELECT version FROM lane_clock WHERE id=1").get() as {
        version: number;
      }
    ).version;
  }

  #record(
    event:
      | Omit<Extract<LaneEvent, { kind: "lane" }>, "version">
      | Omit<Extract<LaneEvent, { kind: "membership" }>, "version">,
  ): void {
    this.db.prepare("UPDATE lane_clock SET version=version+1 WHERE id=1").run();
    const version = this.version;
    this.db
      .prepare("INSERT INTO lane_changes VALUES (?,?)")
      .run(version, JSON.stringify({ ...event, version }));
    this.db
      .prepare("DELETE FROM lane_changes WHERE version<=?")
      .run(version - 1000);
  }

  list(): Lane[] {
    return this.db
      .prepare("SELECT data FROM lanes ORDER BY id")
      .all()
      .map((row) => read<Lane>(row)!);
  }

  get(id: string): Lane | null {
    return read<Lane>(
      this.db.prepare("SELECT data FROM lanes WHERE id=?").get(id),
    );
  }

  create(input: {
    name: string;
    goal: string;
    ownerThreadId?: string | null;
  }): Lane {
    return this.atomic(() => {
      const now = new Date().toISOString();
      const lane: Lane = {
        id: randomUUID(),
        name: input.name,
        goal: input.goal,
        state: "active",
        ownerThreadId: input.ownerThreadId ?? null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.db
        .prepare("INSERT INTO lanes VALUES (?,?)")
        .run(lane.id, JSON.stringify(lane));
      this.#record({ kind: "lane", value: lane });
      return lane;
    });
  }

  update(
    id: string,
    patch: LanePatch,
    expectedRevision: number,
  ): WriteResult<Lane> {
    return this.atomic(() => {
      const current = this.get(id);
      if (!current || current.revision !== expectedRevision)
        return { ok: false, code: "conflict", current };
      const lane = {
        ...current,
        ...patch,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      this.db
        .prepare("UPDATE lanes SET data=? WHERE id=?")
        .run(JSON.stringify(lane), id);
      this.#record({ kind: "lane", value: lane });
      return { ok: true, value: lane };
    });
  }

  membership(taskId: string): LaneMembership {
    return (
      read<LaneMembership>(
        this.db
          .prepare("SELECT data FROM lane_memberships WHERE task_id=?")
          .get(taskId),
      ) ?? { taskId, laneId: null, revision: 0, updatedAt: "" }
    );
  }

  setMembership(
    taskId: string,
    laneId: string | null,
    expectedRevision: number,
  ): WriteResult<LaneMembership> {
    return this.atomic(() => {
      const current = this.membership(taskId);
      if (current.revision !== expectedRevision)
        return { ok: false, code: "conflict", current };
      if (laneId !== null) {
        const lane = this.get(laneId);
        if (!lane) throw new Error("Lane does not exist");
        if (lane.state === "archived")
          throw new Error("Restore archived lane before assigning tasks");
      }
      const value: LaneMembership = {
        taskId,
        laneId,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      this.db
        .prepare(
          "INSERT INTO lane_memberships VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET data=excluded.data",
        )
        .run(taskId, JSON.stringify(value));
      this.#record({ kind: "membership", value });
      return { ok: true, value };
    });
  }

  snapshot(): LaneSnapshot {
    return this.atomic(() => ({
      version: this.version,
      lanes: this.list(),
      memberships: this.db
        .prepare("SELECT data FROM lane_memberships ORDER BY task_id")
        .all()
        .map((row) => read<LaneMembership>(row)!),
    }));
  }

  changesSince(since: number): LaneChanges | null {
    return this.atomic(() => {
      const to = this.version;
      if (since > to || since < Math.max(0, to - 1000)) return null;
      const events = this.db
        .prepare(
          "SELECT data FROM lane_changes WHERE version>? ORDER BY version",
        )
        .all(since)
        .map((row) => read<LaneEvent>(row)!);
      return { from: since, to, events };
    });
  }
}
