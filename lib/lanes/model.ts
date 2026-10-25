export type LaneState = "active" | "parked" | "archived";
export interface Lane {
  id: string;
  name: string;
  goal: string;
  state: LaneState;
  ownerThreadId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface LaneMembership {
  taskId: string;
  laneId: string | null;
  revision: number;
  updatedAt: string;
}
export type LanePatch = Partial<
  Pick<Lane, "name" | "goal" | "state" | "ownerThreadId">
>;
export type WriteResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "conflict"; current: T | null };
export type LaneEvent =
  | { version: number; kind: "lane"; value: Lane }
  | { version: number; kind: "membership"; value: LaneMembership };
export interface LaneSnapshot {
  version: number;
  lanes: Lane[];
  memberships: LaneMembership[];
}
export interface LaneChanges {
  from: number;
  to: number;
  events: LaneEvent[];
}
export interface LaneOwner {
  id: string;
  status: "available" | "archived" | "missing" | "unknown";
  title: string | null;
}
export type LaneReply =
  | import("./contract.ts").NewLaneReply
  | { kind: "membership"; membership: LaneMembership }
  | { kind: "list"; lanes: Lane[]; nextCursor: string | null }
  | {
      kind: "detail";
      lane: Lane | null;
      owner: LaneOwner | null;
      memberships: LaneMembership[];
      nextCursor: string | null;
    }
  | { kind: "create"; lane: Lane }
  | { kind: "update"; result: WriteResult<Lane> }
  | { kind: "assign"; result: WriteResult<LaneMembership> }
  | { kind: "owner"; owner: LaneOwner };
