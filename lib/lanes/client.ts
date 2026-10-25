import type {
  Lane,
  LaneMembership,
  LaneSnapshot,
  LaneChanges,
} from "./model.ts";

// This store owns no core task data. A missing row never removes a membership.
export class LaneClient {
  lanes = new Map<string, Lane>();
  memberships = new Map<string, LaneMembership>();
  version = -1;
  revision = 0;
  #listeners = new Set<() => void>();
  subscribe = (fn: () => void) => {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  };
  getRevision = () => this.revision;
  #touch() {
    this.revision++;
    for (const fn of this.#listeners) fn();
  }

  snapshot(s: LaneSnapshot, reset = false): void {
    if (!reset && s.version < this.version) return;
    this.version = s.version;
    this.lanes = new Map(s.lanes.map((l) => [l.id, l]));
    this.memberships = new Map(s.memberships.map((m) => [m.taskId, m]));
    this.#touch();
  }
  changes(c: LaneChanges): "applied" | "pull" {
    if (c.to <= this.version) return "applied";
    if (this.version < 0 || c.from > this.version) return "pull";
    for (const e of c.events) {
      if (e.version <= this.version) continue;
      if (e.kind === "lane") this.lanes.set(e.value.id, e.value);
      else this.memberships.set(e.value.taskId, e.value);
    }
    this.version = c.to;
    this.#touch();
    return "applied";
  }
}
