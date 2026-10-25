import { useRef, useState } from "react";
import type { Label, Project } from "../lib/model";
import type {
  ImportMapping,
  ImportPreview,
  ImportReceipt,
} from "../lib/lanes/import-model";
import type { Lane } from "../lib/lanes/model";
import { Input } from "./ui/input";
import type { LanesController } from "./use-lanes";
import { laneSelectClass } from "./lane-picker";
import { Button } from "./ui/button";

// Create has no idempotency key. Keep uncertain writes across dialog reopen and
// page reload in this tab; only an explicit destination selection can map them.
const journalKey = "better-tasks:lane-import-pending:v1";
type Pending = Record<string, { name: string }>;
function readPending(): Pending {
  const raw = sessionStorage.getItem(journalKey);
  if (!raw) return {};
  const value: unknown = JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.values(value).some((v) => !v || typeof v.name !== "string")
  )
    throw new Error("Cannot read pending lane creations.");
  return value as Pending;
}
const sourceKey = (label: Label) => JSON.stringify([label.projectId, label.id]);

export function LaneImport({
  controller,
  labels,
  projects,
  sourcesLoading = false,
}: {
  controller: LanesController;
  labels: readonly Label[];
  projects: readonly Project[];
  sourcesLoading?: boolean;
}) {
  const [mapping, setMapping] = useState<ImportMapping[]>([]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [receipt, setReceipt] = useState<ImportReceipt | null>(null);
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newSources, setNewSources] = useState<Record<string, boolean>>({});
  const [created, setCreated] = useState<Lane[]>([]);
  const [pending, setPending] = useState<Pending | null>(() => {
    try {
      return readPending();
    } catch {
      return null;
    }
  });
  const lanesById = new Map([
    ...created.map((l) => [l.id, l] as const),
    ...controller.store.lanes,
  ]);
  const lanes = [...lanesById.values()];
  const nameCounts = new Map<string, number>();
  for (const lane of lanes)
    nameCounts.set(lane.name, (nameCounts.get(lane.name) ?? 0) + 1);
  const sourceName = (l: Label) =>
    `${projects.find((p) => p.id === l.projectId)?.name ?? "Unknown project"} · ${l.name}`;
  const ready = !sourcesLoading && controller.store.version >= 0;
  function savePending(value: Pending) {
    sessionStorage.setItem(journalKey, JSON.stringify(value));
    setPending(value);
  }
  async function checkLanes() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      controller.store.snapshot(
        await controller.rpc.call("laneSnapshot", null),
      );
      setCreated([]);
    } catch {
      setError(
        "Could not check lanes. Reconnect and check again before choosing a destination.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function create(label: Label) {
    if (lock.current || !ready || !pending) return;
    const key = sourceKey(label);
    const name = (
      drafts[key] ?? label.name.replace(/^\s*lane:\s*/i, "")
    ).trim();
    if (!name || name.length > 160) return;
    lock.current = true;
    setBusy(true);
    setCreating(key);
    setError(null);
    let sent = false;
    try {
      const journal = readPending();
      if (journal[key]) {
        setPending(journal);
        return;
      }
      // Persist before sending: an unmount, reload, or lost response must not
      // turn an unknown outcome into another create request.
      savePending({ ...journal, [key]: { name } });
      sent = true;
      const result = await controller.rpc.call("lane", {
        op: "create",
        name,
        goal: "",
        ownerThreadId: null,
      });
      if (result.kind !== "create")
        throw new Error("Unexpected create response");
      setCreated((current) => [...current, result.lane]);
      map(label, result.lane.id);
      setNewSources((current) => ({ ...current, [key]: false }));
      const remaining = readPending();
      delete remaining[key];
      savePending(remaining);
      await controller
        .refresh()
        .then(() => setCreated([]))
        .catch(() =>
          setError(
            "Lane created. Could not refresh the lane list; check lanes again.",
          ),
        );
    } catch {
      setError(
        sent
          ? "Creation could not be confirmed. Check lanes again and choose the destination. Creating again is blocked to avoid duplicates."
          : "Could not save the creation check. No lane was requested; restore browser storage before trying again.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
      setCreating(null);
    }
  }
  const sources = labels.filter((l) => /^lane:/i.test(l.name.trim()));
  const laneName = (id: string) => {
    const l = lanesById.get(id);
    return l
      ? nameCounts.get(l.name)! > 1
        ? `${l.name} · ${id.slice(0, 8)}`
        : l.name
      : "Unavailable lane";
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
    if (lock.current || !ready) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setReceipt(null);
    try {
      setPreview(await controller.rpc.call("laneImportPreview", { mapping }));
      setResolutions({});
    } catch (e) {
      setError(String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function apply() {
    if (!preview || lock.current) return;
    lock.current = true;
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
      setError(
        String(e) +
          " Retry the same preview and choices after a connection failure.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="space-y-3 text-sm">
      <p>
        Choose a destination for each label you want to import, or create a new
        lane from that label. Same names never merge automatically.
      </p>
      <p className="text-xs text-muted-foreground">
        Creating a lane adds no tasks or operator and starts no threads. Review
        the preview before assigning tasks. Labels and statuses stay unchanged;
        future label edits do not change lanes.
      </p>
      {!ready ? <p role="status">Loading lanes and lane labels…</p> : null}
      {pending === null ? (
        <p role="alert">
          Cannot read pending lane creations. Restore browser storage before
          creating a destination.
        </p>
      ) : null}
      <div className="max-h-80 space-y-2 overflow-y-auto">
        {sources.map((l) => {
          const key = sourceKey(l);
          const selected =
            mapping.find(
              (m) => m.projectId === l.projectId && m.labelId === l.id,
            )?.laneId ?? "";
          const draft = drafts[key] ?? l.name.replace(/^\s*lane:\s*/i, "");
          const uncertain = pending?.[key];
          return (
            <fieldset
              key={key}
              className="min-w-0 rounded-md border border-border p-2"
            >
              <legend className="max-w-full break-words px-1">
                {sourceName(l)}
              </legend>
              <details className="text-xs text-muted-foreground">
                <summary>Source details</summary>
                <p className="break-all">
                  Project {l.projectId} · Label {l.id}
                </p>
              </details>
              <select
                disabled={busy || !ready}
                aria-label={`Destination for ${sourceName(l)}`}
                className={laneSelectClass + " mt-1 w-full"}
                value={newSources[key] && !uncertain ? "__create__" : selected}
                onChange={(e) => {
                  const value = e.target.value;
                  setNewSources((current) => ({
                    ...current,
                    [key]: value === "__create__",
                  }));
                  map(l, value === "__create__" ? "" : value);
                }}
              >
                <option value="">Do not import</option>
                {pending !== null && !uncertain ? (
                  <option value="__create__">Create a new lane…</option>
                ) : null}
                {lanes
                  .filter((l) => l.state !== "archived")
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {laneName(l.id)}
                    </option>
                  ))}
              </select>
              {(newSources[key] && !uncertain) || creating === key ? (
                <div className="mt-2 space-y-2">
                  <label className="block">
                    New lane name
                    <Input
                      aria-label={`New lane name for ${sourceName(l)}`}
                      value={draft}
                      maxLength={160}
                      disabled={busy}
                      onChange={(e) =>
                        setDrafts((current) => ({
                          ...current,
                          [key]: e.target.value,
                        }))
                      }
                    />
                  </label>
                  <Button
                    size="sm"
                    disabled={
                      busy ||
                      !ready ||
                      !draft.trim() ||
                      draft.trim().length > 160
                    }
                    onClick={() => void create(l)}
                  >
                    {creating === key ? "Creating lane…" : "Create lane"}
                  </Button>
                </div>
              ) : null}
              {uncertain && creating !== key ? (
                <p role="status" className="mt-2 break-words text-xs">
                  Creation could not be confirmed for “{uncertain.name}”. Check
                  lanes again and select a destination. Creating again is
                  blocked to avoid duplicates.
                </p>
              ) : null}
            </fieldset>
          );
        })}
        {ready && sources.length === 0 ? (
          <p>
            No lane labels found. Labels must start with “lane:”. You can create
            a lane in Manage lanes.
          </p>
        ) : null}
      </div>
      {error || (pending && Object.keys(pending).length > 0) ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void checkLanes()}
        >
          Check lanes again
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !ready || mapping.length === 0 || mapping.length > 20}
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
          <ol className="max-h-64 space-y-2 overflow-y-auto">
            {preview.effects.map((e) => (
              <li
                key={e.taskId}
                className="rounded-md border border-border p-2"
              >
                <strong>{e.key}</strong> · {e.title}
                <p className="text-xs">
                  {projects.find((p) => p.id === e.projectId)?.name ??
                    "Unknown project"}{" "}
                  ·{" "}
                  {e.labelIds
                    .map(
                      (id) =>
                        labels.find(
                          (l) => l.projectId === e.projectId && l.id === id,
                        )?.name ?? "Unavailable label",
                    )
                    .join(", ")}
                </p>
                <p className="text-xs">
                  Current:{" "}
                  {e.current.laneId ? laneName(e.current.laneId) : "No lane"}
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
          {receipt.applied} assigned · {receipt.skipped} kept.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
