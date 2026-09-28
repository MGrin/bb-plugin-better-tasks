// Status and priority marks, drawn inline so a row costs no icon lookups.
import { memo } from "react";
import type { Priority, Status } from "@/lib/model";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<Status, string> = {
  backlog: "text-muted-foreground",
  todo: "text-muted-foreground",
  in_progress: "text-amber-500",
  in_review: "text-violet-500",
  done: "text-emerald-500",
  canceled: "text-muted-foreground",
};

export const StatusGlyph = memo(function StatusGlyph({
  status,
  className,
}: {
  status: Status;
  className?: string;
}) {
  const tone = STATUS_TONE[status];
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={cn("size-3.5 shrink-0", tone, className)}
    >
      {status === "backlog" ? (
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 2.2" />
      ) : status === "todo" ? (
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      ) : status === "in_progress" ? (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 4.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" />
        </>
      ) : status === "in_review" ? (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 4.5a3.5 3.5 0 1 1-3.5 3.5H8z" fill="currentColor" />
        </>
      ) : status === "done" ? (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path d="M5 8.2l2 2 4-4.2" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" opacity="0.55" />
          <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
});

export const PriorityGlyph = memo(function PriorityGlyph({
  priority,
  className,
}: {
  priority: Priority;
  className?: string;
}) {
  if (priority === "urgent") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className={cn("size-3.5 shrink-0 text-orange-500", className)}>
        <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="currentColor" />
        <path d="M8 4.5v4.2" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="8" cy="11.3" r="1" fill="white" />
      </svg>
    );
  }
  if (priority === "none") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className={cn("size-3.5 shrink-0 text-muted-foreground/60", className)}>
        <path d="M3.5 8h1.5M7.25 8h1.5M11 8h1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  const filled = priority === "high" ? 3 : priority === "medium" ? 2 : 1;
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={cn("size-3.5 shrink-0 text-foreground/75", className)}>
      {[0, 1, 2].map((bar) => (
        <rect
          key={bar}
          x={2.5 + bar * 4}
          y={10 - bar * 3}
          width="3"
          height={4 + bar * 3}
          rx="0.8"
          fill="currentColor"
          opacity={bar < filled ? 1 : 0.25}
        />
      ))}
    </svg>
  );
});

/** A green pulse for "an agent is on this right now". */
export function LiveDot({ className }: { className?: string }) {
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)} aria-hidden="true">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />
      <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
    </span>
  );
}

// Tailwind only emits classes it can see in source, so every palette name
// the Tasks plugin may store is spelled out here.
const DOT: Record<string, string> = {
  slate: "bg-slate-500",
  gray: "bg-gray-500",
  zinc: "bg-zinc-500",
  neutral: "bg-neutral-500",
  stone: "bg-stone-500",
  red: "bg-red-500",
  orange: "bg-orange-500",
  amber: "bg-amber-500",
  yellow: "bg-yellow-500",
  lime: "bg-lime-500",
  green: "bg-green-500",
  emerald: "bg-emerald-500",
  teal: "bg-teal-500",
  cyan: "bg-cyan-500",
  sky: "bg-sky-500",
  blue: "bg-blue-500",
  indigo: "bg-indigo-500",
  violet: "bg-violet-500",
  purple: "bg-purple-500",
  fuchsia: "bg-fuchsia-500",
  pink: "bg-pink-500",
  rose: "bg-rose-500",
};

export function ColorDot({ color, className }: { color: string; className?: string }) {
  const known = DOT[color];
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2 shrink-0 rounded-full", known ?? "bg-muted-foreground", className)}
      style={known === undefined && /^#[0-9a-f]{3,8}$/iu.test(color) ? { backgroundColor: color } : undefined}
    />
  );
}
