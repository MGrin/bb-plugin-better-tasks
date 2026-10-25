import { z } from "zod";
export const idSchema=z.string().trim().min(1).max(128);
const revision=z.number().int().nonnegative();
export const lanePatchSchema=z.object({
  name:z.string().trim().min(1).max(160).optional(),
  goal:z.string().max(8000).optional(),
  ownerThreadId:idSchema.nullable().optional(),
  state:z.enum(["active","parked","archived"]).optional(),
}).strict();
const page={limit:z.number().int().min(1).max(500).default(100),cursor:idSchema.optional()};
export const laneInputSchema=z.discriminatedUnion("op",[
  z.object({op:z.literal("list"),state:z.enum(["active","parked","archived"]).optional(),...page}).strict(),
  z.object({op:z.literal("get"),id:idSchema,...page}).strict(),
  z.object({op:z.literal("create"),name:z.string().trim().min(1).max(160),goal:z.string().max(8000).default(""),ownerThreadId:idSchema.nullable().optional()}).strict(),
  z.object({op:z.literal("update"),id:idSchema,patch:lanePatchSchema.refine(p=>Object.keys(p).length>0,"Patch is empty"),expectedRevision:revision}).strict(),
  z.object({op:z.literal("assign"),taskId:idSchema,laneId:idSchema.nullable(),expectedRevision:revision}).strict(),
  z.object({op:z.literal("owner"),threadId:idSchema}).strict(),
]);
export type LaneInput=z.input<typeof laneInputSchema>;
