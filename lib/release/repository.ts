// Plugin-owned release stage storage. Shares the lane database and its
// append-only migration list; never touches Tasks plugin data.
import type Database from "better-sqlite3";
import {
  releaseConflict,
  releaseReceiptSchema,
  releaseRecordSchema,
  releaseSetSchema,
  ReleaseError,
  RELEASE_WRITER,
  type ReleaseReceipt,
  type ReleaseRecord,
  type ReleaseSetRequest,
  type ReleaseStage,
} from "./model.ts";

export const RELEASE_MIGRATION = `CREATE TABLE release_stages (task_id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);
   CREATE TABLE release_history (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, data TEXT NOT NULL);
   CREATE INDEX release_history_task ON release_history (task_id, seq);
   CREATE TABLE release_operations (id TEXT PRIMARY KEY NOT NULL, request TEXT NOT NULL, receipt TEXT NOT NULL);`;

// Key order is fixed so a replay compares byte-for-byte.
function canonical(r: ReleaseSetRequest): ReleaseSetRequest {
  return {
    operationId: r.operationId,
    taskId: r.taskId,
    stage: r.stage,
    train: r.train,
    expectedRevision: r.expectedRevision,
    writer: r.writer,
    evidence: r.evidence,
  };
}

export class ReleaseRepository {
  readonly db: Database.Database;
  constructor(db: Database.Database) {
    this.db = db;
  }

  #decode(data: string, what: string): ReleaseRecord {
    try {
      return releaseRecordSchema.parse(JSON.parse(data));
    } catch {
      throw new ReleaseError("invalid_record", what);
    }
  }

  get(taskId: string): ReleaseRecord | null {
    const row = this.db
      .prepare("SELECT data FROM release_stages WHERE task_id=?")
      .get(taskId) as { data: string } | undefined;
    if (row === undefined) return null;
    const record = this.#decode(row.data, taskId);
    if (record.taskId !== taskId) throw new ReleaseError("invalid_record", taskId);
    return record;
  }

  list(filter: {
    stage?: ReleaseStage;
    train?: string;
    cursor?: string;
    limit: number;
  }): { records: ReleaseRecord[]; nextCursor: string | null } {
    const rows = this.db
      .prepare(
        "SELECT task_id, data FROM release_stages WHERE task_id>? ORDER BY task_id",
      )
      .iterate(filter.cursor ?? "") as Iterable<{ task_id: string; data: string }>;
    const records: ReleaseRecord[] = [];
    let more = false;
    for (const row of rows) {
      const record = this.#decode(row.data, row.task_id);
      if (filter.stage && record.stage !== filter.stage) continue;
      if (filter.train && record.train !== filter.train) continue;
      if (records.length === filter.limit) {
        more = true;
        break;
      }
      records.push(record);
    }
    return { records, nextCursor: more ? records.at(-1)!.taskId : null };
  }

  history(taskId: string, limit: number): ReleaseRecord[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM release_history WHERE task_id=? ORDER BY seq DESC LIMIT ?",
        )
        .all(taskId, limit) as { data: string }[]
    ).map((row) => this.#decode(row.data, taskId));
  }

  operation(operationId: string): ReleaseReceipt | null {
    const row = this.db
      .prepare("SELECT request, receipt FROM release_operations WHERE id=?")
      .get(operationId) as { request: string; receipt: string } | undefined;
    if (row === undefined) return null;
    try {
      const receipt = releaseReceiptSchema.parse(JSON.parse(row.receipt));
      if (
        receipt.operationId !== operationId ||
        JSON.stringify(canonical(releaseSetSchema.parse(JSON.parse(row.request)))) !==
          row.request
      )
        throw Error("Operation identity mismatch");
      return receipt;
    } catch {
      throw new ReleaseError("invalid_record", "operation " + operationId);
    }
  }

  #replay(request: ReleaseSetRequest): ReleaseReceipt | null {
    const prior = this.operation(request.operationId);
    if (prior && JSON.stringify(canonical(prior.request)) !== JSON.stringify(canonical(request)))
      throw new ReleaseError("operation_id_reused", request.operationId);
    return prior;
  }

  replay(request: ReleaseSetRequest): ReleaseReceipt | null {
    return this.#replay(canonical(request));
  }

  /** One atomic compare-and-set with a stored receipt; a retry returns the same receipt. */
  set(
    raw: ReleaseSetRequest,
    actorThreadId: string | null,
  ): { receipt: ReleaseReceipt; changed: boolean } {
    const request = canonical(raw);
    return this.db
      .transaction(() => {
        const prior = this.#replay(request);
        if (prior) return { receipt: prior, changed: false };
        const before = this.get(request.taskId);
        const reason = releaseConflict(request, before);
        const outcome = reason
          ? "conflict"
          : before && before.stage === request.stage && before.train === request.train
            ? "unchanged"
            : "applied";
        const now = new Date().toISOString();
        let after = before;
        if (outcome === "applied") {
          after = releaseRecordSchema.parse({
            taskId: request.taskId,
            stage: request.stage,
            train: request.train,
            revision: (before?.revision ?? 0) + 1,
            writer: RELEASE_WRITER,
            actorThreadId,
            evidence: request.evidence,
            updatedAt: now,
          });
          const data = JSON.stringify(after);
          this.db
            .prepare(
              "INSERT INTO release_stages VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET data=excluded.data",
            )
            .run(request.taskId, data);
          this.db
            .prepare("INSERT INTO release_history (task_id, data) VALUES (?,?)")
            .run(request.taskId, data);
        }
        const receipt = releaseReceiptSchema.parse({
          schemaVersion: 1,
          operationId: request.operationId,
          taskId: request.taskId,
          request,
          outcome,
          reason,
          before,
          after,
          committedAt: now,
        });
        this.db
          .prepare("INSERT INTO release_operations VALUES (?,?,?)")
          .run(request.operationId, JSON.stringify(request), JSON.stringify(receipt));
        return { receipt, changed: outcome === "applied" };
      })
      .immediate();
  }
}
