import type { LaneRepository } from "./repository.ts";
import type { LaneOwner, LaneReply } from "./model.ts";
import { z } from "zod";
import {
  laneInputSchema,
  canonicalTransfer,
  LaneProtocolError,
} from "./contract.ts";
import { heldTasks } from "../guards.ts";
export interface LaneAdapters {
  getTask: (id: string) => Promise<unknown | null>;
  getOwner: (id: string) => Promise<LaneOwner>;
}
export class LaneService {
  readonly r: LaneRepository;
  readonly a: LaneAdapters;
  readonly changed: (version: number) => void;
  constructor(
    r: LaneRepository,
    a: LaneAdapters,
    changed: (version: number) => void = () => {},
  ) {
    this.r = r;
    this.a = a;
    this.changed = changed;
  }

  async execute(raw: unknown): Promise<LaneReply> {
    const input = laneInputSchema.parse(raw);
    // These paths own their publication decision. A global clock delta across await
    // can belong to an unrelated writer and must never publish for a read or replay.
    if (input.op === "observe")
      return {
        kind: "observation",
        observation: this.r.observe(input.taskId, input.destinationLaneId),
      };
    if (input.op === "operation") {
      const receipt = this.r.operation(input.operationId);
      return receipt
        ? {
            kind: "operation",
            operationId: input.operationId,
            status: "found",
            receipt,
          }
        : {
            kind: "operation",
            operationId: input.operationId,
            status: "not_found",
          };
    }
    if (input.op === "transfer") {
      const request = canonicalTransfer(input);
      const prior = this.r.replay(request);
      if (prior) return { kind: "transfer", receipt: prior };
      let failure: LaneProtocolError | null = null;
      if (input.laneId !== null) {
        try {
          const task = await this.a.getTask(input.taskId);
          if (task === null) failure = new LaneProtocolError("task_missing");
          else if (
            !task ||
            typeof task !== "object" ||
            !("id" in task) ||
            task.id !== input.taskId
          )
            failure = new LaneProtocolError("task_unknown");
        } catch {
          failure = new LaneProtocolError("task_unknown");
        }
      }
      const { receipt, changed } = this.r.transfer(request, failure);
      if (changed) this.changed(receipt.after.version);
      return { kind: "transfer", receipt };
    }
    const before = this.r.version;
    const result = await this.#execute(input);
    if (this.r.version > before) this.changed(this.r.version);
    return result;
  }
  async #execute(
    input: Exclude<
      z.output<typeof laneInputSchema>,
      { op: "observe" | "operation" | "transfer" }
    >,
  ): Promise<LaneReply> {
    switch (input.op) {
      case "membership":
        return {
          kind: "membership",
          membership: this.r.membership(input.taskId),
        };
      case "list": {
        const all = this.r
          .list()
          .filter(
            (l) =>
              (!input.state || l.state === input.state) &&
              (!input.cursor || l.id > input.cursor),
          );
        const lanes = all.slice(0, input.limit);
        return {
          kind: "list",
          lanes,
          nextCursor: all.length > lanes.length ? lanes.at(-1)!.id : null,
        };
      }
      case "get": {
        const lane = this.r.get(input.id);
        const all = lane
          ? this.r
              .snapshot()
              .memberships.filter(
                (m) =>
                  m.laneId === lane.id &&
                  (!input.cursor || m.taskId > input.cursor),
              )
          : [];
        const memberships = all.slice(0, input.limit);
        const owner = lane?.ownerThreadId
          ? await this.a.getOwner(lane.ownerThreadId)
          : null;
        return {
          kind: "detail",
          lane,
          owner,
          memberships,
          nextCursor:
            all.length > memberships.length ? memberships.at(-1)!.taskId : null,
        };
      }
      case "create":
        return { kind: "create", lane: this.r.create(input) };
      case "update": {
        const lane = this.r.get(input.id);
        if (
          input.patch.state === "archived" &&
          lane &&
          lane.state !== "archived" &&
          lane.revision === input.expectedRevision
        ) {
          // Archive guard: open members must move first. No override.
          const members = this.r.memberIds(lane.id);
          const openTasks = await heldTasks(members, this.a.getTask);
          if (openTasks.length > 0)
            return {
              kind: "update",
              result: { ok: false, code: "open_tasks", current: lane, openTasks },
            };
          return {
            kind: "update",
            result: this.r.update(input.id, input.patch, input.expectedRevision, members),
          };
        }
        return {
          kind: "update",
          result: this.r.update(input.id, input.patch, input.expectedRevision),
        };
      }
      case "assign":
        // Cache absence is never deletion evidence. Only the public authoritative lookup may reject assignment.
        // Explicit unassignment also works for confirmed-deleted tasks.
        if (
          input.laneId !== null &&
          (await this.a.getTask(input.taskId)) === null
        )
          throw new Error("Task does not exist");
        return {
          kind: "assign",
          result: this.r.setMembership(
            input.taskId,
            input.laneId,
            input.expectedRevision,
          ),
        };
      case "owner":
        return { kind: "owner", owner: await this.a.getOwner(input.threadId) };
    }
  }
}
