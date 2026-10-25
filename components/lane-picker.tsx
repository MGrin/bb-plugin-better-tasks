import type { Lane, LaneMembership } from "../lib/lanes/model";
export const laneSelectClass =
  "min-h-8 max-w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function LanePicker({
  lanes,
  membership,
  onChange,
  disabled = false,
}: {
  lanes: Iterable<Lane>;
  membership: LaneMembership | undefined;
  onChange: (id: string | null, revision: number) => void;
  disabled?: boolean;
}) {
  return (
    <select
      className={laneSelectClass}
      aria-label="Task lane"
      value={membership?.laneId ?? ""}
      disabled={disabled}
      onChange={(e) =>
        onChange(e.target.value || null, membership?.revision ?? 0)
      }
    >
      <option value="">No lane</option>
      {[...lanes]
        .sort(
          (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
        )
        .map((l) => (
          <option key={l.id} value={l.id} disabled={l.state === "archived"}>
            {l.name} · {l.id.slice(0, 8)}
            {l.state !== "active" ? ` (${l.state})` : ""}
          </option>
        ))}
    </select>
  );
}
