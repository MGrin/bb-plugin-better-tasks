import { cliCommand, defineCli } from "@get-bb/plugin-sdk";
import type { LaneService } from "./service.ts";

import type { LaneImporter } from "./import.ts";

export function laneCli(service: LaneService, importer: LaneImporter) {
  function command(op: string) {
    return cliCommand({
      summary:
        op === "observe"
          ? "Coherent local observation: {taskId,destinationLaneId} (required nullable destination). No reservation or permission."
          : op === "transfer"
            ? "Attributable local CAS: persist caller UUID and exact {operationId,taskId,laneId,expected} before send; retry unchanged. Conflict exits 1 with receipt JSON."
            : op === "operation"
              ? "Immutable receipt lookup: {operationId}. not_found is an observation, not cancellation; preserve the same request ID."
              : `Lane ${op}. Input is a JSON object; writes require expectedRevision.`,
      options: {
        input: {
          type: "string",
          description: "JSON input, max 64 KiB; list/get limit 1–500",
          default: "{}",
        },
      },
      async run(input) {
        if (input.options.input.length > 65536)
          throw new Error("Input exceeds 64 KiB");
        const fields: unknown = JSON.parse(input.options.input);
        if (!fields || typeof fields !== "object" || Array.isArray(fields))
          throw new Error("Input must be an object");
        const data = fields as Record<string, unknown>;
        let request: Record<string, unknown> = { ...data, op };
        if (op === "archive" || op === "restore")
          request = {
            ...data,
            op: "update",
            patch: { state: op === "archive" ? "archived" : "active" },
          };
        if (op === "unassign")
          request = { ...data, op: "assign", laneId: null };
        const result = await service.execute(request);
        const conflict =
          ("result" in result && !result.result.ok) ||
          (result.kind === "transfer" && result.receipt.outcome === "conflict");
        return {
          exitCode: conflict ? 1 : 0,
          stdout: JSON.stringify(result) + "\n",
        };
      },
    });
  }
  return defineCli({
    name: "better-tasks",
    summary: "First-class cross-project goal lanes; labels remain independent.",
    commands: {
      "lane import preview": cliCommand({
        summary:
          "Preview explicitly selected project/label to lane ID mappings (max 20 labels, 500 affected tasks).",
        options: {
          input: {
            type: "string",
            required: true,
            description: "JSON {mapping:[{projectId,labelId,laneId}]}",
          },
        },
        async run(input) {
          if (input.options.input.length > 65536)
            throw new Error("Input exceeds 64 KiB");
          return {
            exitCode: 0,
            stdout:
              JSON.stringify(
                await importer.preview(JSON.parse(input.options.input)),
              ) + "\n",
          };
        },
      }),
      "lane import apply": cliCommand({
        summary:
          "Apply reviewed preview ID with explicit conflict resolutions; retry same input to reconcile a lost response.",
        options: {
          input: {
            type: "string",
            required: true,
            description:
              "JSON {previewId,resolutions:[{taskId,laneId}]} (null skips)",
          },
        },
        async run(input) {
          if (input.options.input.length > 131072)
            throw new Error("Input exceeds 128 KiB");
          return {
            exitCode: 0,
            stdout:
              JSON.stringify(
                await importer.apply(JSON.parse(input.options.input)),
              ) + "\n",
          };
        },
      }),
      "lane membership": command("membership"),
      "lane observe": command("observe"),
      "lane transfer": command("transfer"),
      "lane operation": command("operation"),
      "lane list": command("list"),
      "lane get": command("get"),
      "lane create": command("create"),
      "lane update": command("update"),
      "lane archive": command("archive"),
      "lane restore": command("restore"),
      "lane assign": command("assign"),
      "lane unassign": command("unassign"),
      "lane owner": command("owner"),
    },
  });
}
