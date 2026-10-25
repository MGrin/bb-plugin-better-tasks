import Database from "better-sqlite3";
import { LaneRepository, MIGRATIONS } from "../lib/lanes/repository.ts";
import { LaneService, type LaneAdapters } from "../lib/lanes/service.ts";

export const stamp = "2026-10-25T00:00:00.000Z";
export const A = {
  id: "A",
  name: "Source",
  goal: "source",
  state: "active" as const,
  ownerThreadId: "owner-a",
  revision: 4,
  createdAt: stamp,
  updatedAt: stamp,
};
export const B = {
  ...A,
  id: "B",
  name: "Destination",
  ownerThreadId: "owner-b",
  revision: 7,
};
export const binding = (l: typeof A | typeof B) => ({
  id: l.id,
  revision: l.revision,
  state: l.state,
  ownerThreadId: l.ownerThreadId,
});
export function request() {
  return {
    op: "transfer" as const,
    operationId: "11111111-1111-4111-8111-111111111111",
    taskId: "T",
    laneId: "B" as string | null,
    expected: {
      membershipRevision: 3,
      fromLaneId: "A" as string | null,
      source: binding(A) as ReturnType<typeof binding> | null,
      destination: binding(B) as ReturnType<typeof binding> | null,
    },
  };
}
export function seed(db: Database.Database) {
  for (const sql of MIGRATIONS) db.exec(sql);
  for (const l of [A, B])
    db.prepare("INSERT INTO lanes VALUES (?,?)").run(l.id, JSON.stringify(l));
  db.prepare("INSERT INTO lane_memberships VALUES (?,?)").run(
    "T",
    JSON.stringify({ taskId: "T", laneId: "A", revision: 3, updatedAt: stamp }),
  );
  db.prepare("UPDATE lane_clock SET version=9").run();
}
export function setup(
  path = ":memory:",
  adapters: Partial<LaneAdapters> = {},
  publish: (v: number) => void = () => {},
) {
  const db = new Database(path);
  seed(db);
  const r = new LaneRepository(db);
  const s = new LaneService(
    r,
    {
      getTask: async (id) => ({ id }),
      getOwner: async (id) => ({ id, title: null, status: "available" }),
      ...adapters,
    },
    publish,
  );
  const run = (input: unknown): Promise<any> => s.execute(input);
  const observe = () =>
    run({ op: "observe", taskId: "T", destinationLaneId: "B" }).then(
      (x) => x.observation,
    );
  const lookup = () =>
    run({ op: "operation", operationId: request().operationId });
  return { db, r, s, run, observe, lookup };
}
