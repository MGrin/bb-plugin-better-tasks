// Real file-backed SQLite child. Fault injection stays entirely in the test harness.
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { LaneRepository } from "../../lib/lanes/repository.ts";
import { LaneService } from "../../lib/lanes/service.ts";

const [path, mode, raw, release] = process.argv.slice(2);
const db = new Database(path);
db.pragma("busy_timeout = 200");
function barrier(stage: string) {
  process.send!({ stage });
  while (!release || !existsSync(release))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
if (mode === "lock") {
  db.exec("BEGIN IMMEDIATE");
  barrier("locked");
  db.exec("ROLLBACK");
} else {
  if (mode === "precommit") {
    db.function("crash_barrier", () => {
      barrier("precommit");
      return 0;
    });
    db.exec(
      "CREATE TEMP TRIGGER crash_insert AFTER INSERT ON main.lane_operations BEGIN SELECT crash_barrier(); END",
    );
  }
  if (mode === "observe") {
    const prepare = db.prepare.bind(db);
    let paused = false;
    db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (sql.includes("SELECT data FROM lane_memberships")) {
        const get = statement.get.bind(statement);
        statement.get = (...args: unknown[]) => {
          const result = get(...args);
          if (!paused) {
            paused = true;
            barrier("snapshot");
          }
          return result;
        };
      }
      return statement;
    }) as typeof db.prepare;
  }
  const s = new LaneService(
    new LaneRepository(db),
    {
      getTask: async (id) => {
        if (mode === "compete") {
          process.send!({ stage: "preflight" });
          await new Promise<void>((resolve) =>
            process.once("message", () => resolve()),
          );
          process.send!({ stage: "entering" });
        }
        return { id };
      },
      getOwner: async () => {
        throw Error("Unexpected owner read");
      },
    },
    () => {
      if (mode === "postcommit") barrier("postcommit");
    },
  );
  try {
    const result = await s.execute(JSON.parse(raw));
    process.send!({ stage: "result", result });
  } catch (error) {
    process.send!({ stage: "error", message: String(error) });
    process.exitCode = 1;
  }
}
db.close();
process.disconnect!();
