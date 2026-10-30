import { cliCommand, type PluginCliCommand } from "@get-bb/plugin-sdk";
import type { ReleaseService } from "./service.ts";

export function parseInput(raw: string): Record<string, unknown> {
  if (raw.length > 65536) throw new Error("Input exceeds 64 KiB");
  const fields: unknown = JSON.parse(raw);
  if (!fields || typeof fields !== "object" || Array.isArray(fields))
    throw new Error("Input must be an object");
  return fields as Record<string, unknown>;
}

export const input = {
  input: {
    type: "string",
    description: "JSON input, max 64 KiB",
    default: "{}",
  },
} as const;

export const print = (value: unknown, exitCode = 0) => ({
  exitCode,
  stdout: JSON.stringify(value) + "\n",
});

export function releaseCommands(release: ReleaseService): Record<string, PluginCliCommand> {
  const read = (op: string, summary: string) =>
    cliCommand({
      summary,
      options: input,
      run: ({ options }) => print(release.read({ ...parseInput(options.input), op })),
    });
  return {
    "release set": cliCommand({
      summary:
        "Train tooling only (writer \"marco-train\"): CAS {operationId,taskId,stage,train,expectedRevision,writer,evidence}. Never changes task status. Conflict exits 1 with receipt; retry unchanged.",
      options: input,
      async run({ options }, ctx) {
        const reply = await release.set(parseInput(options.input), ctx.threadId ?? null);
        return print(reply, reply.kind === "set" && reply.receipt.outcome === "conflict" ? 1 : 0);
      },
    }),
    "release get": read("get", "Release stage of one task: {taskId}. Null when none recorded."),
    "release list": read(
      "list",
      "Release stages by task ID: {stage?,train?,limit?,cursor?}; limit 1–500.",
    ),
    "release history": read(
      "history",
      "Applied release stage writes for one task, newest first: {taskId,limit?}.",
    ),
    "release operation": read(
      "operation",
      "Stored receipt for one write: {operationId}. Null receipt is not cancellation.",
    ),
  };
}
