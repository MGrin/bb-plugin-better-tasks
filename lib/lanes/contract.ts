import { z } from "zod";
export const idSchema = z.string().trim().min(1).max(128);
const revision = z.number().int().nonnegative();
export const lanePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    goal: z.string().max(8000).optional(),
    ownerThreadId: idSchema.nullable().optional(),
    state: z.enum(["active", "parked", "archived"]).optional(),
  })
  .strict();
const page = {
  limit: z.number().int().min(1).max(500).default(100),
  cursor: idSchema.optional(),
};
// New protocol boundaries do not normalize stored/caller identities.
const strictId = z
  .string()
  .min(1)
  .max(128)
  .refine((s) => s === s.trim());
const safeRevision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveRevision = safeRevision.refine((n) => n > 0);
const state = z.enum(["active", "parked", "archived"]);
const timestamp = z.iso.datetime();
export const storedLaneSchema = z
  .object({
    id: strictId,
    name: z
      .string()
      .min(1)
      .max(160)
      .refine((s) => s === s.trim()),
    goal: z.string().max(8000),
    state,
    ownerThreadId: strictId.nullable(),
    revision: positiveRevision,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export const membershipSchema = z
  .object({
    taskId: strictId,
    laneId: strictId.nullable(),
    revision: safeRevision,
    updatedAt: z.union([timestamp, z.literal("")]),
  })
  .strict()
  .refine(
    (m) =>
      m.revision === 0
        ? m.laneId === null && m.updatedAt === ""
        : m.updatedAt !== "",
    "Invalid membership sentinel",
  );
const bindingSchema = z
  .object({
    id: strictId,
    revision: positiveRevision,
    state,
    ownerThreadId: strictId.nullable(),
  })
  .strict();
const expectedSchema = z
  .object({
    membershipRevision: safeRevision,
    fromLaneId: strictId.nullable(),
    source: bindingSchema.nullable(),
    destination: bindingSchema.nullable(),
  })
  .strict();
const transferFields = {
  operationId: z.uuid(),
  taskId: strictId,
  laneId: strictId.nullable(),
  expected: expectedSchema,
};
const consistent = (p: {
  laneId: string | null;
  expected: z.infer<typeof expectedSchema>;
}) => {
  const e = p.expected;
  return (
    (e.fromLaneId === null
      ? e.source === null
      : e.source?.id === e.fromLaneId) &&
    (p.laneId === null
      ? e.destination === null
      : e.destination?.id === p.laneId) &&
    (e.fromLaneId === null ||
      e.fromLaneId !== p.laneId ||
      sameBinding(e.source, e.destination))
  );
};
export const transferInputSchema = z
  .object({ op: z.literal("transfer"), ...transferFields })
  .strict()
  .refine(consistent, "Inconsistent lane bindings");
export const canonicalTransferSchema = z
  .object({ schemaVersion: z.literal(1), ...transferFields })
  .strict()
  .refine(consistent, "Inconsistent lane bindings");
export type CanonicalTransferRequest = z.infer<typeof canonicalTransferSchema>;
export type LaneBinding = z.infer<typeof bindingSchema>;
export function sameBinding(
  a: LaneBinding | null,
  b: LaneBinding | null,
): boolean {
  return a === null || b === null
    ? a === b
    : a.id === b.id &&
        a.revision === b.revision &&
        a.state === b.state &&
        a.ownerThreadId === b.ownerThreadId;
}
export function canonicalTransfer(
  p: z.infer<typeof transferInputSchema> | CanonicalTransferRequest,
): CanonicalTransferRequest {
  const binding = (b: LaneBinding | null) =>
    b === null
      ? null
      : {
          id: b.id,
          revision: b.revision,
          state: b.state,
          ownerThreadId: b.ownerThreadId,
        };
  return {
    schemaVersion: 1,
    operationId: p.operationId,
    taskId: p.taskId,
    laneId: p.laneId,
    expected: {
      membershipRevision: p.expected.membershipRevision,
      fromLaneId: p.expected.fromLaneId,
      source: binding(p.expected.source),
      destination: binding(p.expected.destination),
    },
  };
}
const referenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("missing"), id: strictId }).strict(),
  z.object({ kind: z.literal("present"), lane: storedLaneSchema }).strict(),
]);
export type LaneReference = z.infer<typeof referenceSchema>;
export const localObservationSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: strictId,
    version: safeRevision,
    membership: membershipSchema,
    source: referenceSchema,
    destination: referenceSchema,
  })
  .strict()
  .refine(
    (o) =>
      o.taskId === o.membership.taskId &&
      referenceId(o.source) === o.membership.laneId &&
      (referenceId(o.source) !== referenceId(o.destination) ||
        JSON.stringify(o.source) === JSON.stringify(o.destination)),
    "Observation identity mismatch",
  );
export type LocalObservation = z.infer<typeof localObservationSchema>;
export function referenceId(r: LaneReference): string | null {
  return r.kind === "none" ? null : r.kind === "missing" ? r.id : r.lane.id;
}
export function transferConflict(
  p: CanonicalTransferRequest,
  o: LocalObservation,
) {
  const e = p.expected;
  if (
    o.membership.revision !== e.membershipRevision ||
    o.membership.laneId !== e.fromLaneId
  )
    return "membership_changed" as const;
  for (const [ref, expected, reason] of [
    [o.source, e.source, "source_changed"],
    [o.destination, e.destination, "destination_changed"],
  ] as const) {
    if (ref.kind === "missing") return "lane_missing" as const;
    if (!sameBinding(ref.kind === "present" ? ref.lane : null, expected))
      return reason;
  }
  if (
    p.laneId !== o.membership.laneId &&
    o.destination.kind === "present" &&
    o.destination.lane.state === "archived"
  )
    return "destination_archived" as const;
  return null;
}
export const transferReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: z.uuid(),
    taskId: strictId,
    request: canonicalTransferSchema,
    outcome: z.enum(["applied", "unchanged", "conflict"]),
    reason: z
      .enum([
        "membership_changed",
        "source_changed",
        "destination_changed",
        "lane_missing",
        "destination_archived",
      ])
      .nullable(),
    before: localObservationSchema,
    after: localObservationSchema,
    committedAt: timestamp,
  })
  .strict()
  .refine((r) => {
    const p = r.request;
    if (
      r.operationId !== p.operationId ||
      r.taskId !== p.taskId ||
      r.before.taskId !== p.taskId ||
      r.after.taskId !== p.taskId ||
      referenceId(r.before.destination) !== p.laneId ||
      referenceId(r.after.destination) !== p.laneId
    )
      return false;
    const reason = transferConflict(p, r.before);
    const outcome = reason
      ? "conflict"
      : p.laneId === r.before.membership.laneId
        ? "unchanged"
        : "applied";
    if (r.reason !== reason || r.outcome !== outcome) return false;
    if (outcome !== "applied")
      return JSON.stringify(r.before) === JSON.stringify(r.after);
    return (
      r.after.version === r.before.version + 1 &&
      r.after.membership.revision === r.before.membership.revision + 1 &&
      r.after.membership.laneId === p.laneId &&
      r.after.membership.updatedAt === r.committedAt &&
      JSON.stringify(r.after.destination) ===
        JSON.stringify(r.before.destination) &&
      JSON.stringify(r.after.source) === JSON.stringify(r.before.destination)
    );
  }, "Inconsistent operation receipt");
export type TransferReceipt = z.infer<typeof transferReceiptSchema>;
export const observeInputSchema = z
  .object({
    op: z.literal("observe"),
    taskId: strictId,
    destinationLaneId: strictId.nullable(),
  })
  .strict();
export const operationInputSchema = z
  .object({ op: z.literal("operation"), operationId: z.uuid() })
  .strict();
export const newLaneReplySchema = z.union([
  z
    .object({
      kind: z.literal("observation"),
      observation: localObservationSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("transfer"), receipt: transferReceiptSchema })
    .strict(),
  z
    .object({
      kind: z.literal("operation"),
      operationId: z.uuid(),
      status: z.literal("found"),
      receipt: transferReceiptSchema,
    })
    .strict()
    .refine((r) => r.operationId === r.receipt.operationId),
  z
    .object({
      kind: z.literal("operation"),
      operationId: z.uuid(),
      status: z.literal("not_found"),
    })
    .strict(),
]);
export type NewLaneReply = z.infer<typeof newLaneReplySchema>;
export class LaneProtocolError extends Error {
  constructor(
    readonly code:
      | "invalid_observation"
      | "invalid_operation_record"
      | "operation_id_reused"
      | "task_missing"
      | "task_unknown",
    detail = "",
  ) {
    super(`${code}${detail ? ": " + detail : ""}`);
  }
}
export const laneInputSchema = z.discriminatedUnion("op", [
  observeInputSchema,
  transferInputSchema,
  operationInputSchema,
  z.object({ op: z.literal("membership"), taskId: idSchema }).strict(),
  z
    .object({
      op: z.literal("list"),
      state: z.enum(["active", "parked", "archived"]).optional(),
      ...page,
    })
    .strict(),
  z.object({ op: z.literal("get"), id: idSchema, ...page }).strict(),
  z
    .object({
      op: z.literal("create"),
      name: z.string().trim().min(1).max(160),
      goal: z.string().max(8000).default(""),
      ownerThreadId: idSchema.nullable().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("update"),
      id: idSchema,
      patch: lanePatchSchema.refine(
        (p) => Object.keys(p).length > 0,
        "Patch is empty",
      ),
      expectedRevision: revision,
    })
    .strict(),
  z
    .object({
      op: z.literal("assign"),
      taskId: idSchema,
      laneId: idSchema.nullable(),
      expectedRevision: revision,
    })
    .strict(),
  z.object({ op: z.literal("owner"), threadId: idSchema }).strict(),
]);
export type LaneInput = z.input<typeof laneInputSchema>;
