import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { laneInputSchema, newLaneReplySchema } from "./contract.ts";
import type { LaneChanges, LaneReply, LaneSnapshot } from "./model.ts";
import { LaneRepository, MIGRATIONS } from "./repository.ts";
import { LaneService, type LaneAdapters } from "./service.ts";
import { LaneImporter, type ImportAdapters } from "./import.ts";
import {
  previewInputSchema,
  applyInputSchema,
  type ImportPreview,
  type ImportReceipt,
} from "./import-model.ts";
import { laneCli } from "./cli.ts";

export const laneRpcMethods = {
  laneImportPreview: {
    input: previewInputSchema,
    output: z.custom<ImportPreview>(),
  },
  laneImportApply: {
    input: applyInputSchema,
    output: z.custom<ImportReceipt>(),
  },
  lane: {
    input: laneInputSchema,
    output: z.union([
      newLaneReplySchema,
      z.custom<LaneReply>(
        (value) =>
          !!value &&
          typeof value === "object" &&
          "kind" in value &&
          [
            "membership",
            "list",
            "detail",
            "create",
            "update",
            "assign",
            "owner",
          ].includes(String(value.kind)),
      ),
    ]),
  },
  laneSnapshot: { input: z.null(), output: z.custom<LaneSnapshot>() },
  laneChanges: {
    input: z.object({ since: z.number().int().nonnegative() }).strict(),
    output: z.object({ changes: z.custom<LaneChanges>().nullable() }),
  },
};
export function laneBackend(
  bb: BbPluginApi,
  adapters: LaneAdapters & ImportAdapters,
) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const repo = new LaneRepository(db);
  const service = new LaneService(repo, adapters, (version) =>
    bb.realtime.publish("lanes", { version }),
  );
  // SDK owns the database handle and closes it on disposal/reload.
  const importer = new LaneImporter(repo, adapters, (version) =>
    bb.realtime.publish("lanes", { version }),
  );
  bb.cli.register(laneCli(service, importer));
  // These observe-only listeners are disposed by the host with this generation.
  for (const event of [
    "thread.archived",
    "thread.unarchived",
    "thread.deleted",
  ] as const) {
    bb.events.on(event, ({ thread }) => {
      if (repo.list().some((l) => l.ownerThreadId === thread.id))
        bb.realtime.publish("lane-owners", { threadId: thread.id });
    });
  }
  return {
    laneImportPreview: (input: unknown) => importer.preview(input),
    laneImportApply: (input: unknown) => importer.apply(input),
    async lane(input: z.input<typeof laneInputSchema>) {
      return service.execute(input);
    },
    laneSnapshot() {
      return repo.snapshot();
    },
    laneChanges({ since }: { since: number }) {
      return { changes: repo.changesSince(since) };
    },
  };
}
