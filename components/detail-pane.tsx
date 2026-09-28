// A task's full detail, fetched on demand: the board itself never carries
// descriptions or comments.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Markdown, useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import type { TaskDetail } from "../server";
import { Icon } from "@/components/ui/icon";
import { ColorDot, LiveDot, PriorityGlyph, StatusGlyph } from "@/components/glyphs";
import { PriorityMenu, StatusMenu } from "@/components/menus";
import type { BoardActions } from "@/components/task-items";
import type { useBoard } from "@/components/use-board";
import { longDate, plainDate, shortAge } from "@/lib/format";
import { PRIORITY_LABEL, STATUS_LABEL, type Label, type Project, type Row } from "@/lib/model";
import { cn } from "@/lib/utils";

type Rpc = ReturnType<typeof useBoard>["rpc"];

const COMMENTS_SHOWN = 30;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="flex h-7 items-center text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-h-7 min-w-0 items-center gap-1.5 text-[13px]">{children}</dd>
    </>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="border-t border-border px-5 py-4">
      <h3 className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
        {count !== undefined ? <span className="tabular-nums">{count}</span> : null}
      </h3>
      {children}
    </section>
  );
}

/** Navigate inside the SPA to the built-in Tasks page for this task. */
function openInBuiltIn(event: React.MouseEvent<HTMLAnchorElement>) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  window.history.pushState(null, "", event.currentTarget.getAttribute("href"));
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function DetailPane({
  taskId,
  row,
  rows,
  project,
  labels,
  rpc,
  actions,
  onClose,
}: {
  taskId: string;
  row: Row | undefined;
  rows: ReadonlyMap<string, Row>;
  project: Project | undefined;
  labels: ReadonlyMap<string, Label>;
  rpc: Rpc;
  actions: BoardActions;
  onClose: () => void;
}) {
  const navigate = useBbNavigate();
  const [detail, setDetail] = useState<TaskDetail | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [allComments, setAllComments] = useState(false);
  const request = useRef(0);

  const fetchDetail = useCallback(() => {
    const id = ++request.current;
    rpc.call("detail", { taskId }).then(
      (result) => {
        if (id !== request.current) return;
        setDetail(result.detail);
        setError(null);
      },
      (cause: unknown) => {
        if (id !== request.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  }, [rpc, taskId]);

  useEffect(() => {
    setDetail(undefined);
    setAllComments(false);
    fetchDetail();
  }, [fetchDetail]);

  // The row changed (a delta): refresh the parts the row does not carry.
  const rev = row?.rev;
  const firstRev = useRef(rev);
  useEffect(() => {
    if (rev === firstRev.current) return;
    firstRev.current = rev;
    fetchDetail();
  }, [rev, fetchDetail]);

  useRealtime("touched", (payload) => {
    if ((payload as { taskId?: string }).taskId === taskId) fetchDetail();
  });

  const task = detail?.task;
  const status = row?.status ?? task?.status;
  const priority = row?.priority ?? task?.priority;
  const title = row?.title ?? task?.title ?? "";
  const key = row?.key ?? task?.key ?? "";
  const parent = (row?.parentTaskId ?? task?.parentTaskId) ? rows.get((row?.parentTaskId ?? task?.parentTaskId)!) : undefined;
  const labelIds = row?.labelIds ?? task?.labelIds ?? [];
  const liveIds = new Set(row?.live.map((thread) => thread.threadId) ?? []);
  const threads = detail?.threads ?? [];
  const comments = (detail?.comments ?? []).filter((comment) => comment.kind !== "system" || allComments);
  const shownComments = allComments ? comments : comments.slice(-COMMENTS_SHOWN);

  return (
    <aside
      aria-label={`Task ${key}`}
      className="flex w-[min(480px,45%)] min-w-80 shrink-0 flex-col border-l border-border bg-background"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        {project ? <ColorDot color={project.color} /> : null}
        <span className="font-mono text-xs text-muted-foreground">{key}</span>
        {project ? <span className="truncate text-xs text-muted-foreground">· {project.name}</span> : null}
        <span className="flex-1" />
        {key !== "" ? (
          <a
            href={`/plugins/tasks/tasks/task/${encodeURIComponent(key)}`}
            onClick={openInBuiltIn}
            title="Open in Tasks"
            aria-label="Open in Tasks"
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground"
          >
            <Icon name="ArrowUpRight" className="size-4" />
          </a>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close (Esc)"
          title="Close (Esc)"
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground"
        >
          <Icon name="X" className="size-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-5 pb-4 pt-5">
          <h2 className="text-lg font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">{title}</h2>
          <dl className="mt-4 grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-0.5">
            {status ? (
              <Field label="Status">
                <StatusMenu status={status} onChange={(next) => actions.setStatus(taskId, next)} className="-ml-1" />
                <span>{STATUS_LABEL[status]}</span>
              </Field>
            ) : null}
            {priority ? (
              <Field label="Priority">
                <PriorityMenu priority={priority} onChange={(next) => actions.setPriority(taskId, next)} className="-ml-1" />
                <span>{PRIORITY_LABEL[priority]}</span>
              </Field>
            ) : null}
            {labelIds.length > 0 ? (
              <Field label="Labels">
                <span className="flex flex-wrap gap-1">
                  {labelIds.map((id) => {
                    const label = labels.get(id);
                    return label ? (
                      <span key={id} className="inline-flex h-5 items-center gap-1 rounded-full border border-border px-2 text-xs">
                        <ColorDot color={label.color} className="size-1.5" />
                        {label.name}
                      </span>
                    ) : null;
                  })}
                </span>
              </Field>
            ) : null}
            {(row?.dueDate ?? task?.dueDate) ? (
              <Field label="Due">{plainDate((row?.dueDate ?? task?.dueDate)!)}</Field>
            ) : null}
            {parent ? (
              <Field label="Parent">
                <button
                  type="button"
                  onClick={() => actions.open(parent.id)}
                  className="flex min-w-0 items-center gap-1.5 rounded px-1 -mx-1 hover:bg-state-hover"
                >
                  <StatusGlyph status={parent.status} />
                  <span className="shrink-0 whitespace-nowrap font-mono text-xs text-muted-foreground">{parent.key}</span>
                  <span className="truncate">{parent.title}</span>
                </button>
              </Field>
            ) : null}
            {row ? (
              <>
                <Field label="Updated">
                  <span title={longDate(row.updatedAt)}>{shortAge(row.updatedAt)} ago</span>
                </Field>
                <Field label="Created">{longDate(row.createdAt)}</Field>
              </>
            ) : null}
          </dl>
        </div>

        {threads.length > 0 || liveIds.size > 0 ? (
          <Section title="Threads" count={threads.length}>
            <ul className="-mx-2 space-y-0.5">
              {[...threads]
                .sort((a, b) => Number(liveIds.has(b.threadId)) - Number(liveIds.has(a.threadId)))
                .map((thread) => {
                  const live = thread.liveStatus === "working" || thread.liveStatus === "starting";
                  return (
                    <li key={thread.threadId}>
                      <button
                        type="button"
                        onClick={() => navigate.toThread(thread.threadId)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-state-hover"
                      >
                        {live ? <LiveDot /> : <span className="size-2 shrink-0 rounded-full bg-muted-foreground/30" />}
                        <span className="min-w-0 flex-1 truncate">{thread.title || thread.threadId}</span>
                        <span className={cn("shrink-0 text-xs", live ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
                          {thread.liveStatus}
                        </span>
                      </button>
                    </li>
                  );
                })}
            </ul>
          </Section>
        ) : null}

        <Section title="Description">
          {detail === undefined && error === null ? (
            <div className="space-y-2" aria-busy="true">
              <div className="h-3 w-5/6 animate-pulse rounded bg-state-hover" />
              <div className="h-3 w-4/6 animate-pulse rounded bg-state-hover" />
              <div className="h-3 w-3/6 animate-pulse rounded bg-state-hover" />
            </div>
          ) : error !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : detail === null ? (
            <p className="text-sm text-muted-foreground">This task no longer exists.</p>
          ) : task && task.description.trim() !== "" ? (
            <Markdown content={task.description} className="text-[13px]" />
          ) : (
            <p className="text-sm text-muted-foreground">No description.</p>
          )}
        </Section>

        {detail && detail.subtasks.length > 0 ? (
          <Section title="Sub-tasks" count={detail.subtasks.length}>
            <ul className="-mx-2 space-y-0.5">
              {detail.subtasks.map((id) => {
                const sub = rows.get(id);
                if (!sub) return null;
                return (
                  <li key={id}>
                    <button
                      type="button"
                      onClick={() => actions.open(id)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-state-hover"
                    >
                      <PriorityGlyph priority={sub.priority} />
                      <StatusGlyph status={sub.status} />
                      <span className="shrink-0 whitespace-nowrap font-mono text-xs text-muted-foreground">{sub.key}</span>
                      <span className="min-w-0 flex-1 truncate">{sub.title}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Section>
        ) : null}

        {detail ? (
          <Section title="Activity" count={comments.length}>
            {comments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No comments.</p>
            ) : (
              <>
                {!allComments && (comments.length > COMMENTS_SHOWN || detail.comments.some((c) => c.kind === "system")) ? (
                  <button
                    type="button"
                    onClick={() => setAllComments(true)}
                    className="mb-2 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    Show all activity
                  </button>
                ) : null}
                <ol className="space-y-3">
                  {shownComments.map((comment) => (
                    <li key={comment.id} className={cn("text-[13px]", comment.kind === "system" && "text-muted-foreground")}>
                      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{comment.authorName}</span>
                        <span title={longDate(comment.createdAt)}>{shortAge(comment.createdAt)}</span>
                        {comment.threadId ? (
                          <button
                            type="button"
                            onClick={() => navigate.toThread(comment.threadId!)}
                            className="underline-offset-2 hover:text-foreground hover:underline"
                          >
                            thread
                          </button>
                        ) : null}
                      </div>
                      {comment.kind === "system" ? (
                        <p>{comment.body}</p>
                      ) : (
                        <div className="rounded-lg border border-border bg-card px-3 py-2">
                          <Markdown content={comment.body} className="text-[13px]" />
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              </>
            )}
          </Section>
        ) : null}
      </div>
    </aside>
  );
}
