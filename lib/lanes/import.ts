import { createHash, randomUUID } from "node:crypto";
import type { TaskFields } from "../cache.ts";
import type { Label } from "../model.ts";
import type { LaneRepository } from "./repository.ts";
import {
  previewInputSchema,
  applyInputSchema,
  type ImportMapping,
  type ImportPreview,
  type ImportReceipt,
  type ImportResolution,
} from "./import-model.ts";

export interface ImportAdapters {
  listLabels: (projectId: string) => Promise<Label[]>;
  listTasks: (input: {
    projectId: string;
    limit: number;
    cursor?: string;
  }) => Promise<{ tasks: TaskFields[]; nextCursor: string | null }>;
}
interface SavedPreview {
  preview: ImportPreview;
  fingerprint: string;
}
function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function resolutionKey(resolutions: ImportResolution[]) {
  return JSON.stringify(
    [...resolutions].sort((a, b) => a.taskId.localeCompare(b.taskId)),
  );
}
export class LaneImporter {
  readonly r: LaneRepository;
  readonly a: ImportAdapters;
  readonly changed: (v: number) => void;
  constructor(
    r: LaneRepository,
    a: ImportAdapters,
    changed: (v: number) => void = () => {},
  ) {
    this.r = r;
    this.a = a;
    this.changed = changed;
  }

  async #source(mapping: ImportMapping[]) {
    const sources: ImportPreview["sources"] = [];
    const tasks: Pick<
      TaskFields,
      "id" | "key" | "title" | "projectId" | "labelIds"
    >[] = [];
    let scanned = 0;
    for (const projectId of [
      ...new Set(mapping.map((m) => m.projectId)),
    ].sort()) {
      const selected = mapping.filter((m) => m.projectId === projectId);
      const labels = await this.a.listLabels(projectId);
      for (const m of selected) {
        const label = labels.find(
          (l) => l.id === m.labelId && l.projectId === projectId,
        );
        if (!label)
          throw new Error("Selected label no longer exists; preview changed");
        if (!/^lane:/i.test(label.name.trim()))
          throw new Error("Select only explicit lane: labels");
        sources.push({ projectId, labelId: label.id, name: label.name });
      }
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await this.a.listTasks({
          projectId,
          limit: 500,
          ...(cursor ? { cursor } : {}),
        });
        scanned += page.tasks.length;
        if (scanned > 50000)
          throw new Error(
            "Import scan exceeds 50,000 tasks; select fewer projects",
          );
        for (const t of page.tasks) {
          if (t.projectId !== projectId)
            throw new Error("Task source returned a different project");
          if (!selected.some((m) => t.labelIds.includes(m.labelId))) continue;
          tasks.push({
            id: t.id,
            key: t.key,
            title: t.title,
            projectId: t.projectId,
            labelIds: [...t.labelIds].sort(),
          });
          if (tasks.length > 500)
            throw new Error(
              "Import affects more than 500 tasks; select fewer labels",
            );
        }
        cursor = page.nextCursor ?? undefined;
        if (cursor) {
          if (seen.has(cursor))
            throw new Error("Task source pagination repeated; preview again");
          seen.add(cursor);
        }
      } while (cursor);
    }
    sources.sort(
      (a, b) =>
        a.projectId.localeCompare(b.projectId) ||
        a.labelId.localeCompare(b.labelId),
    );
    tasks.sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(tasks.map((t) => t.id)).size !== tasks.length)
      throw new Error("Task source changed while scanning; preview again");
    return { sources, tasks };
  }

  async preview(raw: unknown): Promise<ImportPreview> {
    const { mapping } = previewInputSchema.parse(raw);
    mapping.sort(
      (a, b) =>
        a.projectId.localeCompare(b.projectId) ||
        a.labelId.localeCompare(b.labelId),
    );
    if (
      new Set(mapping.map((m) => JSON.stringify([m.projectId, m.labelId])))
        .size !== mapping.length
    )
      throw new Error("Map each project/label ID once");
    const source = await this.#source(mapping);
    return this.r.atomic(() => {
      const targets = [...new Set(mapping.map((m) => m.laneId))].map((id) => {
        const l = this.r.get(id);
        if (!l) throw new Error("Mapped lane does not exist");
        if (l.state === "archived")
          throw new Error("Restore archived lanes before import");
        return l;
      });
      const effects = source.tasks.map((t) => {
        const labelIds = mapping
          .filter(
            (m) =>
              m.projectId === t.projectId && t.labelIds.includes(m.labelId),
          )
          .map((m) => m.labelId);
        const candidates = [
          ...new Set(
            mapping
              .filter(
                (m) =>
                  m.projectId === t.projectId && labelIds.includes(m.labelId),
              )
              .map((m) => m.laneId),
          ),
        ].sort();
        const current = this.r.membership(t.id);
        return {
          taskId: t.id,
          key: t.key,
          title: t.title,
          projectId: t.projectId,
          labelIds,
          candidates,
          current,
          conflict:
            candidates.length > 1 ||
            (current.laneId !== null && !candidates.includes(current.laneId)),
        };
      });
      const preview: ImportPreview = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        mapping,
        targets,
        sources: source.sources,
        effects,
      };
      const saved: SavedPreview = { preview, fingerprint: hash(source) };
      this.r.db
        .prepare(
          "DELETE FROM lane_imports WHERE receipt IS NULL AND json_extract(preview,'$.preview.createdAt')<?",
        )
        .run(new Date(Date.now() - 86400000).toISOString());
      this.r.db
        .prepare("INSERT INTO lane_imports VALUES (?,?,NULL)")
        .run(preview.id, JSON.stringify(saved));
      return preview;
    });
  }

  #receipt(id: string, key: string): ImportReceipt | null {
    const row = this.r.db
      .prepare("SELECT receipt FROM lane_imports WHERE id=?")
      .get(id) as { receipt: string | null } | undefined;
    if (!row?.receipt) return null;
    const saved = JSON.parse(row.receipt) as {
      key: string;
      value: ImportReceipt;
    };
    if (saved.key !== key)
      throw new Error("Import receipt exists for different resolutions");
    return saved.value;
  }

  async apply(raw: unknown): Promise<ImportReceipt> {
    const input = applyInputSchema.parse(raw);
    const key = resolutionKey(input.resolutions);
    const prior = this.#receipt(input.previewId, key);
    if (prior) return prior; // Reconcile a lost response before reading core data or replaying writes.
    const row = this.r.db
      .prepare("SELECT preview FROM lane_imports WHERE id=?")
      .get(input.previewId) as { preview: string } | undefined;
    if (!row) throw new Error("Preview does not exist; preview again");
    const saved = JSON.parse(row.preview) as SavedPreview;
    const { preview } = saved;
    if (Date.now() - Date.parse(preview.createdAt) > 86400000)
      throw new Error("Preview expired; preview again");
    const source = await this.#source(preview.mapping);
    if (hash(source) !== saved.fingerprint)
      throw new Error("Label or task source changed; preview again");
    const before = this.r.version;
    const receipt = this.r.atomic(() => {
      const prior = this.#receipt(input.previewId, key);
      if (prior) return prior;
      for (const l of preview.targets)
        if (this.r.get(l.id)?.revision !== l.revision)
          throw new Error("Lane changed; preview again");
      for (const e of preview.effects)
        if (this.r.membership(e.taskId).revision !== e.current.revision)
          throw new Error("Membership changed; preview again");
      const resolutions = new Map(
        input.resolutions.map((r) => [r.taskId, r.laneId]),
      );
      if (resolutions.size !== input.resolutions.length)
        throw new Error("Duplicate resolution");
      for (const id of resolutions.keys())
        if (!preview.effects.some((e) => e.taskId === id))
          throw new Error("Resolution is outside preview");
      let applied = 0,
        skipped = 0;
      for (const e of preview.effects) {
        if (e.conflict && !resolutions.has(e.taskId))
          throw new Error("Explicit resolution required for " + e.key);
        const target = resolutions.has(e.taskId)
          ? resolutions.get(e.taskId)!
          : e.candidates[0]!;
        if (
          target !== null &&
          !e.candidates.includes(target) &&
          target !== e.current.laneId
        )
          throw new Error("Resolution must use a reviewed lane or skip");
        if (target === null || target === e.current.laneId) {
          skipped++;
          continue;
        }
        const result = this.r.setMembership(
          e.taskId,
          target,
          e.current.revision,
        );
        if (!result.ok) throw new Error("Membership changed; preview again");
        applied++;
      }
      const receipt = {
        previewId: preview.id,
        applied,
        skipped,
        at: new Date().toISOString(),
      };
      this.r.db
        .prepare("UPDATE lane_imports SET receipt=? WHERE id=?")
        .run(JSON.stringify({ key, value: receipt }), preview.id);
      return receipt;
    });
    if (this.r.version > before) this.changed(this.r.version);
    return receipt;
  }
}
