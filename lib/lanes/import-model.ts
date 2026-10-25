import { z } from "zod";
import { idSchema } from "./contract.ts";
import type { Lane, LaneMembership } from "./model.ts";
export const importMappingSchema = z
  .object({ projectId: idSchema, labelId: idSchema, laneId: idSchema })
  .strict();
export const previewInputSchema = z
  .object({ mapping: z.array(importMappingSchema).min(1).max(20) })
  .strict();
export const applyInputSchema = z
  .object({
    previewId: idSchema,
    resolutions: z
      .array(
        z.object({ taskId: idSchema, laneId: idSchema.nullable() }).strict(),
      )
      .max(500)
      .default([]),
  })
  .strict();
export type ImportMapping = z.infer<typeof importMappingSchema>;
export type ImportResolution = z.infer<
  typeof applyInputSchema
>["resolutions"][number];
export interface ImportEffect {
  taskId: string;
  key: string;
  title: string;
  projectId: string;
  labelIds: string[];
  candidates: string[];
  current: LaneMembership;
  conflict: boolean;
}
export interface ImportPreview {
  id: string;
  createdAt: string;
  mapping: ImportMapping[];
  targets: Lane[];
  sources: { projectId: string; labelId: string; name: string }[];
  effects: ImportEffect[];
}
export interface ImportReceipt {
  previewId: string;
  applied: number;
  skipped: number;
  at: string;
}
