import type { LaneRepository } from "./repository.ts";
import type { LaneOwner, LaneReply } from "./model.ts";
import { z } from "zod";
import { laneInputSchema } from "./contract.ts";
export interface LaneAdapters {
  getTask:(id:string)=>Promise<unknown|null>;
  getOwner:(id:string)=>Promise<LaneOwner>;
}
export class LaneService {
  readonly r:LaneRepository; readonly a:LaneAdapters;
  readonly changed:(version:number)=>void;
  constructor(r:LaneRepository,a:LaneAdapters,changed:(version:number)=>void=()=>{}){this.r=r;this.a=a;this.changed=changed;}

  async execute(raw:unknown):Promise<LaneReply>{
    const input=laneInputSchema.parse(raw);
    const before=this.r.version;
    const result=await this.#execute(input);
    if(this.r.version>before)this.changed(this.r.version);
    return result;
  }
  async #execute(input:z.output<typeof laneInputSchema>):Promise<LaneReply>{
    switch(input.op){
      case "list": {
        const all=this.r.list().filter(l=>(!input.state||l.state===input.state)&&(!input.cursor||l.id>input.cursor));
        const lanes=all.slice(0,input.limit);
        return {kind:"list",lanes,nextCursor:all.length>lanes.length?lanes.at(-1)!.id:null};
      }
      case "get": {
        const lane=this.r.get(input.id);
        const all=lane?this.r.snapshot().memberships.filter(m=>m.laneId===lane.id&&(!input.cursor||m.taskId>input.cursor)):[];
        const memberships=all.slice(0,input.limit);
        const owner=lane?.ownerThreadId?await this.a.getOwner(lane.ownerThreadId):null;
        return {kind:"detail",lane,owner,memberships,nextCursor:all.length>memberships.length?memberships.at(-1)!.taskId:null};
      }
      case "create": return {kind:"create",lane:this.r.create(input)};
      case "update": return {kind:"update",result:this.r.update(input.id,input.patch,input.expectedRevision)};
      case "assign":
        // Cache absence is never deletion evidence. Only the public authoritative lookup may reject assignment.
        // Explicit unassignment also works for confirmed-deleted tasks.
        if(input.laneId!==null && await this.a.getTask(input.taskId)===null) throw new Error("Task does not exist");
        return {kind:"assign",result:this.r.setMembership(input.taskId,input.laneId,input.expectedRevision)};
      case "owner": return {kind:"owner",owner:await this.a.getOwner(input.threadId)};
    }
  }
}
