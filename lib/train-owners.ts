// Deferred train checks a thread still owns. marco publishes them to a small
// JSON file on every train state change; the archive guard only reads it.
//
//   { "schema_version": 1, "updated_at": "...Z",
//     "owners": [{ "thread": "thr_x", "repo": "Flarexyz/app", "task": "APP-10", "check": "APP-10 check 1" }] }
//
// A missing file means marco published nothing, so nothing is held. Any other
// failure (unreadable, malformed, unknown schema version) is "unreadable": the
// guard keeps the thread rather than archive a check's only owner.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export interface TrainCheck {
  threadId: string;
  repo: string | null;
  task: string;
  check: string;
}

export type TrainOwners = { ok: true; checks: TrainCheck[] } | { ok: false; reason: string };

/** Overrides the default location (tests, non-standard state directories). */
export const OWNERS_FILE_ENV = "MARCO_TRAIN_OWNERS_FILE";
const MAX_BYTES = 1024 * 1024;

export function ownersFile(): string {
  return (
    process.env[OWNERS_FILE_ENV] || join(homedir(), ".local", "state", "marco", "train", "owners.json")
  );
}

const fileSchema = z.object({
  schema_version: z.literal(1),
  owners: z.array(
    z.object({
      thread: z.string().trim().min(1),
      repo: z.string().optional(),
      task: z.string().trim().min(1),
      check: z.string().trim().min(1),
    }),
  ),
});

export async function readTrainOwners(path: string = ownersFile()): Promise<TrainOwners> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: true, checks: [] };
    const code = (error as NodeJS.ErrnoException)?.code ?? "error";
    return { ok: false, reason: `train owners file cannot be read (${code}): ${path}` };
  }
  if (text.length > MAX_BYTES)
    return { ok: false, reason: `train owners file exceeds ${MAX_BYTES} bytes: ${path}` };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: `train owners file is not valid JSON: ${path}` };
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success)
    return {
      ok: false,
      reason: `train owners file has an unsupported schema (expects schema_version 1 and owners): ${path}`,
    };
  return {
    ok: true,
    checks: parsed.data.owners.map((o) => ({
      threadId: o.thread,
      repo: o.repo ?? null,
      task: o.task,
      check: o.check,
    })),
  };
}
