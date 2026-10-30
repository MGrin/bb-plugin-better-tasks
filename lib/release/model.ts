// Release stage: where a task's merged change is on its way to production.
// Train tooling writes it; the lane keeps the task status. Nothing here ever
// changes a task's status, and status writes never change the stage.
import { z } from "zod";

export const RELEASE_STAGES = [
  "merged-dev",
  "nominated",
  "boarded",
  "go",
  "live",
  "verified",
] as const;
export type ReleaseStage = (typeof RELEASE_STAGES)[number];

/** Stages that belong to one release train and carry its ID. */
export const TRAIN_STAGES: readonly ReleaseStage[] = [
  "boarded",
  "go",
  "live",
  "verified",
];

export const RELEASE_STAGE_LABEL: Record<ReleaseStage, string> = {
  "merged-dev": "Merged to dev",
  nominated: "Nominated",
  boarded: "Boarded",
  go: "Go",
  live: "Live",
  verified: "Verified",
};

/** The one tool allowed to write stages. A guardrail and an audit field, not a credential. */
export const RELEASE_WRITER = "marco-train";

const strictId = z
  .string()
  .min(1)
  .max(128)
  .refine((s) => s === s.trim());
const trainId = z
  .string()
  .min(1)
  .max(128)
  .refine((s) => s === s.trim() && !/\s/.test(s), "Train ID has no spaces");
const timestamp = z.iso.datetime();
const stage = z.enum(RELEASE_STAGES);
const evidence = z.string().max(2000);

export const releaseRecordSchema = z
  .object({
    taskId: strictId,
    stage,
    train: trainId.nullable(),
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    writer: z.literal(RELEASE_WRITER),
    actorThreadId: strictId.nullable(),
    evidence,
    updatedAt: timestamp,
  })
  .strict();
export type ReleaseRecord = z.infer<typeof releaseRecordSchema>;

const trainMatchesStage = (r: { stage: ReleaseStage; train: string | null }) =>
  TRAIN_STAGES.includes(r.stage) ? r.train !== null : r.train === null;
const TRAIN_RULE =
  "boarded, go, live and verified carry a train ID; merged-dev and nominated carry none";

export const releaseSetSchema = z
  .object({
    operationId: z.uuid(),
    taskId: strictId,
    stage,
    train: trainId.nullable().default(null),
    expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    writer: z.literal(RELEASE_WRITER),
    evidence: evidence.default(""),
  })
  .strict()
  .refine(trainMatchesStage, TRAIN_RULE);
export type ReleaseSetRequest = z.infer<typeof releaseSetSchema>;

export const RELEASE_REASONS = [
  "revision_changed",
  "not_boarded",
  "train_mismatch",
  "stage_skipped",
  "evidence_required",
] as const;
export type ReleaseReason = (typeof RELEASE_REASONS)[number];

export const releaseReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: z.uuid(),
    taskId: strictId,
    request: releaseSetSchema,
    outcome: z.enum(["applied", "unchanged", "conflict"]),
    reason: z.enum(RELEASE_REASONS).nullable(),
    before: releaseRecordSchema.nullable(),
    after: releaseRecordSchema.nullable(),
    committedAt: timestamp,
  })
  .strict();
export type ReleaseReceipt = z.infer<typeof releaseReceiptSchema>;

const page = {
  limit: z.number().int().min(1).max(500).default(100),
  cursor: strictId.optional(),
};
export const releaseReadSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("get"), taskId: strictId }).strict(),
  z
    .object({
      op: z.literal("list"),
      stage: stage.optional(),
      train: trainId.optional(),
      ...page,
    })
    .strict(),
  z
    .object({
      op: z.literal("history"),
      taskId: strictId,
      limit: z.number().int().min(1).max(500).default(100),
    })
    .strict(),
  z.object({ op: z.literal("operation"), operationId: z.uuid() }).strict(),
]);
export type ReleaseReadInput = z.input<typeof releaseReadSchema>;

export type ReleaseReply =
  | { kind: "record"; record: ReleaseRecord | null }
  | { kind: "list"; records: ReleaseRecord[]; nextCursor: string | null }
  | { kind: "history"; taskId: string; entries: ReleaseRecord[] }
  | { kind: "operation"; operationId: string; receipt: ReleaseReceipt | null }
  | { kind: "set"; receipt: ReleaseReceipt };

export class ReleaseError extends Error {
  constructor(
    readonly code:
      | "invalid_record"
      | "operation_id_reused"
      | "task_missing"
      | "task_unknown",
    detail = "",
  ) {
    super(`${code}${detail ? ": " + detail : ""}`);
  }
}

const order = (s: ReleaseStage) => RELEASE_STAGES.indexOf(s);

/**
 * Why a write must not apply, or null. Train stages advance one step at a
 * time on one train; boarding may start or restart a train from any stage;
 * stepping back off a train needs evidence (dropped, rebuilt, rolled back).
 */
export function releaseConflict(
  request: ReleaseSetRequest,
  current: ReleaseRecord | null,
): ReleaseReason | null {
  if ((current?.revision ?? 0) !== request.expectedRevision)
    return "revision_changed";
  if (current && current.stage === request.stage && current.train === request.train)
    return null;
  if (request.stage !== "boarded" && TRAIN_STAGES.includes(request.stage)) {
    if (!current || current.train === null) return "not_boarded";
    if (current.train !== request.train) return "train_mismatch";
    if (order(request.stage) > order(current.stage) + 1) return "stage_skipped";
  }
  if (
    current &&
    order(request.stage) < order(current.stage) &&
    request.evidence.trim() === ""
  )
    return "evidence_required";
  return null;
}
