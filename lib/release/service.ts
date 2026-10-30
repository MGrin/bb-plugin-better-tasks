import {
  releaseReadSchema,
  releaseSetSchema,
  ReleaseError,
  type ReleaseReply,
} from "./model.ts";
import type { ReleaseRepository } from "./repository.ts";

export interface ReleaseAdapters {
  /** Authoritative lookup: null means deleted, a throw means unknown. */
  getTask: (id: string) => Promise<unknown | null>;
}

export class ReleaseService {
  readonly r: ReleaseRepository;
  readonly a: ReleaseAdapters;
  readonly changed: (taskId: string) => void;
  constructor(
    r: ReleaseRepository,
    a: ReleaseAdapters,
    changed: (taskId: string) => void = () => {},
  ) {
    this.r = r;
    this.a = a;
    this.changed = changed;
  }

  /** Reads only: the board and other plugins can never write a stage. */
  read(raw: unknown): ReleaseReply {
    const input = releaseReadSchema.parse(raw);
    switch (input.op) {
      case "get":
        return { kind: "record", record: this.r.get(input.taskId) };
      case "list":
        return { kind: "list", ...this.r.list(input) };
      case "history":
        return {
          kind: "history",
          taskId: input.taskId,
          entries: this.r.history(input.taskId, input.limit),
        };
      case "operation":
        return {
          kind: "operation",
          operationId: input.operationId,
          receipt: this.r.operation(input.operationId),
        };
    }
  }

  /** Train tooling's write. Never reads or writes the task status. */
  async set(raw: unknown, actorThreadId: string | null): Promise<ReleaseReply> {
    const request = releaseSetSchema.parse(raw);
    const prior = this.r.replay(request);
    if (prior) return { kind: "set", receipt: prior };
    let task: unknown;
    try {
      task = await this.a.getTask(request.taskId);
    } catch {
      throw new ReleaseError("task_unknown", request.taskId);
    }
    if (task === null) throw new ReleaseError("task_missing", request.taskId);
    if (!task || typeof task !== "object" || !("id" in task) || task.id !== request.taskId)
      throw new ReleaseError("task_unknown", request.taskId);
    const { receipt, changed } = this.r.set(request, actorThreadId);
    if (changed) this.changed(request.taskId);
    return { kind: "set", receipt };
  }
}
