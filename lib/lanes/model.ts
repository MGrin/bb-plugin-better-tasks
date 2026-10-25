export type LaneState = "active" | "parked" | "archived";
export interface Lane { id:string; name:string; goal:string; state:LaneState; ownerThreadId:string|null; revision:number; createdAt:string; updatedAt:string }
export interface LaneMembership { taskId:string; laneId:string|null; revision:number; updatedAt:string }
export type LanePatch = Partial<Pick<Lane,"name"|"goal"|"state"|"ownerThreadId">>;
export type WriteResult<T> = {ok:true; value:T} | {ok:false; code:"conflict"; current:T|null};
export type LaneEvent = {version:number; kind:"lane"; value:Lane} | {version:number;kind:"membership";value:LaneMembership};
export interface LaneSnapshot { version:number; lanes:Lane[]; memberships:LaneMembership[] }
export interface LaneChanges { from:number; to:number; events:LaneEvent[] }
