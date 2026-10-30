// Only plugin-owned storage. Shipped migration statements must remain append-only.
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  storedLaneSchema,
  membershipSchema,
  localObservationSchema,
  canonicalTransferSchema,
  canonicalTransfer,
  transferReceiptSchema,
  transferConflict,
  LaneProtocolError,
  type CanonicalTransferRequest,
  type LocalObservation,
  type LaneReference,
  type TransferReceipt,
} from "./contract.ts";
import type {
  Lane,
  LanePatch,
  LaneMembership,
  LaneSnapshot,
  LaneChanges,
  LaneEvent,
  WriteResult,
} from "./model.ts";
import { RELEASE_MIGRATION } from "../release/repository.ts";

export const MIGRATIONS = [
  `CREATE TABLE lanes (id TEXT PRIMARY KEY, data TEXT NOT NULL);
   CREATE TABLE lane_memberships (task_id TEXT PRIMARY KEY, data TEXT NOT NULL);
   CREATE TABLE lane_clock (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
   INSERT INTO lane_clock VALUES (1,0);
   CREATE TABLE lane_changes (version INTEGER PRIMARY KEY, data TEXT NOT NULL);`,
  `CREATE TABLE lane_imports (id TEXT PRIMARY KEY, preview TEXT NOT NULL, receipt TEXT);`,
  `CREATE TABLE lane_operations (id TEXT PRIMARY KEY NOT NULL, request TEXT NOT NULL, receipt TEXT NOT NULL);`,
  RELEASE_MIGRATION,
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

  // Presence is checked before decoding: a stored JSON null is corruption, never absence.
  #strictRow<T>(
    table: "lanes" | "lane_memberships",
    key: string,
    schema: z.ZodType<T>,
  ): T | null {
    const column = table === "lanes" ? "id" : "task_id";
    const row = this.db
      .prepare(`SELECT data FROM ${table} WHERE ${column}=?`)
      .get(key) as { data: string } | undefined;
    if (row === undefined) return null;
    try {
      return schema.parse(JSON.parse(row.data));
    } catch {
      throw new LaneProtocolError("invalid_observation", `${table} row ${key}`);
    }
  }

  #observe(taskId: string, destinationLaneId: string | null): LocalObservation {
    const stored = this.#strictRow(
      "lane_memberships",
      taskId,
      membershipSchema,
    );
    if (stored && (stored.taskId !== taskId || stored.revision === 0))
      throw new LaneProtocolError(
        "invalid_observation",
        "membership row identity or persisted sentinel",
      );
    const membership = stored ?? {
      taskId,
      laneId: null,
      revision: 0,
      updatedAt: "",
    };
    const reference = (id: string | null): LaneReference => {
      if (id === null) return { kind: "none" };
      const lane = this.#strictRow("lanes", id, storedLaneSchema);
      if (lane && lane.id !== id)
        throw new LaneProtocolError("invalid_observation", "lane row identity");
      return lane ? { kind: "present", lane } : { kind: "missing", id };
    };
    const source = reference(membership.laneId);
    const destination =
      destinationLaneId === membership.laneId
        ? source
        : reference(destinationLaneId);
    // Validate even the clock/synthesized sentinel. No raw decoder errors become a business conflict.
    const parsed = localObservationSchema.safeParse({
      schemaVersion: 1,
      taskId,
      version: this.version,
      membership,
      source,
      destination,
    });
    if (!parsed.success) throw new LaneProtocolError("invalid_observation");
    return parsed.data;
  }

  observe(taskId: string, destinationLaneId: string | null): LocalObservation {
    return this.atomic(() => this.#observe(taskId, destinationLaneId));
  }

  operation(operationId: string): TransferReceipt | null {
    const row = this.db
      .prepare("SELECT request,receipt FROM lane_operations WHERE id=?")
      .get(operationId) as { request: string; receipt: string } | undefined;
    if (row === undefined) return null;
    try {
      const request = canonicalTransferSchema.parse(JSON.parse(row.request));
      const receipt = transferReceiptSchema.parse(JSON.parse(row.receipt));
      const canonical = JSON.stringify(canonicalTransfer(request));
      if (
        request.operationId !== operationId ||
        receipt.operationId !== operationId ||
        canonical !== row.request ||
        JSON.stringify(canonicalTransfer(receipt.request)) !== canonical
      )
        throw Error("Operation identity mismatch");
      return receipt;
    } catch {
      throw new LaneProtocolError("invalid_operation_record", operationId);
    }
  }

  replay(request: CanonicalTransferRequest): TransferReceipt | null {
    const prior = this.operation(request.operationId);
    if (
      prior &&
      JSON.stringify(canonicalTransfer(prior.request)) !==
        JSON.stringify(request)
    )
      throw new LaneProtocolError("operation_id_reused");
    return prior;
  }

  transfer(
    request: CanonicalTransferRequest,
    preflightFailure: LaneProtocolError | null,
  ): { receipt: TransferReceipt; changed: boolean } {
    return this.atomic(() => {
      const prior = this.replay(request);
      if (prior) return { receipt: prior, changed: false };
      if (preflightFailure) throw preflightFailure;
      const before = this.#observe(request.taskId, request.laneId);
      const reason = transferConflict(request, before);
      const outcome = reason
        ? "conflict"
        : before.membership.laneId === request.laneId
          ? "unchanged"
          : "applied";
      let after = before;
      if (outcome === "applied") {
        // Reuse the existing synchronous savepoint, membership revision and event writer.
        const result = this.setMembership(
          request.taskId,
          request.laneId,
          request.expected.membershipRevision,
        );
        if (!result.ok) throw Error("Membership changed within transaction");
        after = this.#observe(request.taskId, request.laneId);
      }
      const receipt = transferReceiptSchema.parse({
        schemaVersion: 1,
        operationId: request.operationId,
        taskId: request.taskId,
        request,
        outcome,
        reason,
        before,
        after,
        committedAt:
          outcome === "applied"
            ? after.membership.updatedAt
            : new Date().toISOString(),
      });
      this.db
        .prepare("INSERT INTO lane_operations VALUES (?,?,?)")
        .run(
          request.operationId,
          JSON.stringify(request),
          JSON.stringify(receipt),
        );
      return { receipt, changed: outcome === "applied" };
    });
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

  memberIds(laneId: string): string[] {
    return this.db
      .prepare("SELECT data FROM lane_memberships ORDER BY task_id")
      .all()
      .map((row) => read<LaneMembership>(row)!)
      .filter((m) => m.laneId === laneId)
      .map((m) => m.taskId);
  }

  // `checkedMembers`: the member set an archive guard has already found closed.
  // A task that joined since then is refused as unknown rather than archived unseen.
  update(
    id: string,
    patch: LanePatch,
    expectedRevision: number,
    checkedMembers?: readonly string[],
  ): WriteResult<Lane> {
    return this.atomic(() => {
      const current = this.get(id);
      if (!current || current.revision !== expectedRevision)
        return { ok: false, code: "conflict", current };
      if (checkedMembers) {
        const checked = new Set(checkedMembers);
        const joined = this.memberIds(id).filter((taskId) => !checked.has(taskId));
        if (joined.length > 0)
          return {
            ok: false,
            code: "open_tasks",
            current,
            openTasks: joined.map((taskId) => ({ taskId, key: null, status: "unknown" })),
          };
      }
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
