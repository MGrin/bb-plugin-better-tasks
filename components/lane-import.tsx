import { useState } from "react";
import type { Label, Project } from "../lib/model";
import type {
  ImportMapping,
  ImportPreview,
  ImportReceipt,
} from "../lib/lanes/import-model";
import type { LanesController } from "./use-lanes";
import { laneSelectClass } from "./lane-picker";
import { Button } from "./ui/button";

export function LaneImport({
  controller,
  labels,
  projects,
}: {
  controller: LanesController;
  labels: readonly Label[];
  projects: readonly Project[];
}) {
  const [mapping, setMapping] = useState<ImportMapping[]>([]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [receipt, setReceipt] = useState<ImportReceipt | null>(null);
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const lanes = [...controller.store.lanes.values()];
  const sources = labels.filter((l) => /^lane:/i.test(l.name.trim()));
  const laneName = (id: string) => {
    const l = controller.store.lanes.get(id);
    return l ? `${l.name} · ${id.slice(0, 8)}` : id;
  };
  function map(label: Label, laneId: string) {
    setMapping((current) => [
      ...current.filter(
        (m) => m.projectId !== label.projectId || m.labelId !== label.id,
      ),
      ...(laneId
        ? [{ projectId: label.projectId, labelId: label.id, laneId }]
        : []),
    ]);
    setPreview(null);
    setReceipt(null);
    setError(null);
  }
  async function inspect() {
    setBusy(true);
    setError(null);
    setReceipt(null);
    try {
      setPreview(await controller.rpc.call("laneImportPreview", { mapping }));
      setResolutions({});
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await controller.rpc.call("laneImportApply", {
        previewId: preview.id,
        resolutions: Object.entries(resolutions).map(([taskId, laneId]) => ({
          taskId,
          laneId: laneId === "skip" ? null : laneId,
        })),
      });
      setReceipt(result);
      await controller.refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-3 text-sm">
      <p>
        Select each source label and its destination lane explicitly. Create
        destination lanes first. Same names never merge automatically.
      </p>
      <p className="text-xs text-muted-foreground">
        Labels, statuses, and task threads stay unchanged. Import runs once for
        the reviewed mapping; future label edits do not change lanes.
      </p>
      <div className="max-h-52 space-y-2 overflow-y-auto">
        {sources.map((l) => (
          <label
            key={l.projectId + ":" + l.id}
            className="block min-w-0 rounded-md border border-border p-2"
          >
            <span className="block break-words">
              {projects.find((p) => p.id === l.projectId)?.name ?? l.projectId}{" "}
              · {l.name}
            </span>
            <span className="block break-all text-xs text-muted-foreground">
              Label {l.id}
            </span>
            <select
              disabled={busy}
              aria-label={`Target lane for ${l.projectId} / ${l.id}`}
              className={laneSelectClass + " mt-1 w-full"}
              value={
                mapping.find(
                  (m) => m.projectId === l.projectId && m.labelId === l.id,
                )?.laneId ?? ""
              }
              onChange={(e) => map(l, e.target.value)}
            >
              <option value="">Do not import</option>
              {lanes
                .filter((l) => l.state !== "archived")
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {laneName(l.id)}
                  </option>
                ))}
            </select>
          </label>
        ))}
        {sources.length === 0 ? (
          <p>
            No lane: labels loaded. Wait for projects to finish loading before
            importing.
          </p>
        ) : null}
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={busy || mapping.length === 0 || mapping.length > 20}
        onClick={() => void inspect()}
      >
        Preview import
      </Button>
      {preview ? (
        <div className="space-y-2">
          <p>
            {preview.effects.length} affected tasks ·{" "}
            {preview.effects.filter((e) => e.conflict).length} conflicts
          </p>
          <p className="break-all text-xs text-muted-foreground">
            Review {preview.id}
          </p>
          <ol className="max-h-64 space-y-2 overflow-y-auto">
            {preview.effects.map((e) => (
              <li
                key={e.taskId}
                className="rounded-md border border-border p-2"
              >
                <strong>{e.key}</strong> · {e.title}
                <p className="text-xs">
                  Project {e.projectId} · labels {e.labelIds.join(", ")}
                </p>
                <p className="text-xs">
                  Current:{" "}
                  {e.current.laneId ? laneName(e.current.laneId) : "No lane"} ·
                  revision {e.current.revision}
                </p>
                {e.conflict ? (
                  <select
                    aria-label={`Resolve ${e.key}`}
                    className={laneSelectClass + " mt-1 w-full"}
                    value={resolutions[e.taskId] ?? ""}
                    disabled={busy || !!receipt}
                    onChange={(event) => {
                      const value = event.target.value;
                      setResolutions((r) => ({ ...r, [e.taskId]: value }));
                    }}
                  >
                    <option value="" disabled>
                      Choose a resolution
                    </option>
                    <option value="skip">Skip; keep current membership</option>
                    {e.candidates.map((id) => (
                      <option key={id} value={id}>
                        {laneName(id)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="text-xs">
                    Proposed: {laneName(e.candidates[0]!)}
                  </p>
                )}
              </li>
            ))}
          </ol>
          <Button
            size="sm"
            disabled={
              busy ||
              !!receipt ||
              preview.effects.some((e) => e.conflict && !resolutions[e.taskId])
            }
            onClick={() => void apply()}
          >
            Apply reviewed import
          </Button>
        </div>
      ) : null}
      {receipt ? (
        <p role="status">
          {receipt.applied} assigned · {receipt.skipped} kept. Receipt{" "}
          {receipt.previewId}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="break-words text-destructive">
          {error} Retry the same preview and choices after a connection failure.
        </p>
      ) : null}
    </section>
  );
}
