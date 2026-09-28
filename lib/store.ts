// The page's copy of the board. Rows merge by `rev` (the server version at
// which the row last changed), so a snapshot, a delta and a pulled change
// set can arrive in any order and the newest state still wins.
import {
  type Changes,
  type DeltaSignal,
  type Label,
  type Project,
  type Removal,
  type Row,
  type Status,
} from "./model.ts";

export interface Snapshot {
  version: number;
  rows: Row[];
  projects: Project[];
  labels: Label[];
  counts: Record<Status, number>;
  complete: boolean;
}

/** What the caller must do after a delta signal. */
export type DeltaOutcome = "applied" | "pull" | "buffered";

export class ClientStore {
  readonly rows = new Map<string, Row>();
  projects: Project[] = [];
  labels: Label[] = [];
  /** Server counts from the last snapshot; used until closed rows load. */
  serverCounts: Record<Status, number> | null = null;
  /** Highest server version this store is known to be complete through. */
  version = -1;
  closedLoaded = false;
  /** Bumps on every change; the useSyncExternalStore snapshot. */
  revision = 0;

  readonly #tombs = new Map<string, number>();
  readonly #listeners = new Set<() => void>();
  #buffer: DeltaSignal[] = [];

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getRevision = (): number => this.revision;

  applySnapshot(snapshot: Snapshot, part: "open" | "closed" | "all"): void {
    this.projects = snapshot.projects;
    this.labels = snapshot.labels;
    this.serverCounts = snapshot.counts;
    this.#mergeRows(snapshot.rows);
    if (part !== "open") this.closedLoaded = true;
    const firstSnapshot = this.version < 0;
    this.version = Math.max(this.version, snapshot.version);
    if (firstSnapshot) {
      const buffered = this.#buffer;
      this.#buffer = [];
      for (const signal of buffered) {
        if (signal.kind === "rows") this.#applyRows(signal);
      }
    }
    this.#emit();
  }

  /**
   * Apply a realtime delta. Returns "pull" when the store may have missed a
   * change and the caller should fetch `changes` since `version`.
   */
  onDelta(signal: DeltaSignal): DeltaOutcome {
    if (this.version < 0) {
      this.#buffer.push(signal);
      return "buffered";
    }
    if (signal.kind === "range") {
      return signal.to > this.version ? "pull" : "applied";
    }
    this.#applyRows(signal);
    const gap = signal.from > this.version;
    if (!gap) this.version = Math.max(this.version, signal.to);
    this.#emit();
    return gap ? "pull" : "applied";
  }

  applyChanges(changes: Changes): void {
    this.#applyRows(changes);
    this.version = Math.max(this.version, changes.to);
    this.#emit();
  }

  /** Replace everything with a full snapshot (the change log ran out). */
  replaceAll(snapshot: Snapshot): void {
    this.rows.clear();
    this.#tombs.clear();
    this.closedLoaded = false;
    this.applySnapshot(snapshot, "all");
  }

  /** Re-render subscribers without changing data (loading or error state). */
  touch(): void {
    this.#emit();
  }

  /** A row the server returned for our own write. */
  upsertRow(row: Row): void {
    this.#mergeRows([row]);
    this.#emit();
  }

  setMeta(projects: Project[], labels: Label[]): void {
    this.projects = projects;
    this.labels = labels;
    this.#emit();
  }

  /**
   * Show a change before the server confirms it. The server's row carries a
   * higher rev and replaces this one; `rollback` restores the previous row
   * if the write fails and nothing newer arrived meanwhile.
   */
  optimistic(id: string, patch: Partial<Pick<Row, "status" | "priority">>): () => void {
    const previous = this.rows.get(id);
    if (previous === undefined) return () => {};
    const next = { ...previous, ...patch };
    this.rows.set(id, next);
    this.#emit();
    return () => {
      if (this.rows.get(id) === next) {
        this.rows.set(id, previous);
        this.#emit();
      }
    };
  }

  countsByStatus(): Record<Status, number> {
    const counts: Record<Status, number> = {
      in_progress: 0,
      in_review: 0,
      todo: 0,
      backlog: 0,
      done: 0,
      canceled: 0,
    };
    for (const row of this.rows.values()) counts[row.status] += 1;
    if (!this.closedLoaded && this.serverCounts !== null) {
      counts.done = this.serverCounts.done;
      counts.canceled = this.serverCounts.canceled;
    }
    return counts;
  }

  #applyRows(changes: { upserts: Row[]; removes: Removal[] }): void {
    this.#mergeRows(changes.upserts);
    for (const { id, rev } of changes.removes) {
      const existing = this.rows.get(id);
      if (existing !== undefined && existing.rev > rev) continue;
      this.rows.delete(id);
      this.#tombs.set(id, Math.max(rev, this.#tombs.get(id) ?? 0));
    }
  }

  #mergeRows(rows: readonly Row[]): void {
    for (const row of rows) {
      const tomb = this.#tombs.get(row.id);
      if (tomb !== undefined && tomb >= row.rev) continue;
      const existing = this.rows.get(row.id);
      if (existing !== undefined && existing.rev > row.rev) continue;
      this.rows.set(row.id, row);
    }
  }

  #emit(): void {
    this.revision += 1;
    for (const listener of this.#listeners) listener();
  }
}
