import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FILTERS, groupRows, parseFilters } from "../lib/view.ts";
import { task } from "./fixtures.ts";
import { LaneClient } from "../lib/lanes/client.ts";
const rows=[{...task({id:"a",projectId:"one",labelIds:["tag"]}),rev:1,live:[]},{...task({id:"b",projectId:"two",labelIds:["tag"]}),rev:1,live:[]},{...task({id:"c",projectId:"two"}),rev:1,live:[]}];
const members=new Map([["a",{taskId:"a",laneId:"goal",revision:1,updatedAt:""}],["b",{taskId:"b",laneId:"goal",revision:1,updatedAt:""}]]);
test("lane filtering spans boards and combines with labels and no-lane",()=>{
  assert.equal(groupRows(rows,{...DEFAULT_FILTERS,laneIds:["goal"]},undefined,members).todo.length,2);
  assert.equal(groupRows(rows,{...DEFAULT_FILTERS,noLane:true},undefined,members).todo[0]?.id,"c");
  assert.equal(groupRows(rows,{...DEFAULT_FILTERS,laneIds:["goal"],labelIds:["other"]},undefined,members).todo.length,0);
  assert.equal(groupRows(rows,{...DEFAULT_FILTERS,laneIds:["goal"],projectIds:["two"],labelIds:["tag"]},undefined,members).todo[0]?.id,"b");
  assert.equal(groupRows(rows,{...DEFAULT_FILTERS,laneIds:["goal"],noLane:true},undefined,members).todo.length,3);
});
test("persisted lane filters reject malformed values",()=>{
  const f=parseFilters({laneIds:["goal",3],noLane:true});
  assert.deepEqual(f.laneIds,["goal"]);
  assert.equal(f.noLane,true);
});
test("lane lifecycle changes never mutate core rows or lose unloaded memberships",()=>{
  const c=new LaneClient();
  const l={id:"goal",name:"A",goal:"",state:"active" as const,ownerThreadId:"gone",revision:1,createdAt:"",updatedAt:""};
  c.snapshot({version:1,lanes:[l],memberships:[...members.values(),{taskId:"not-loaded",laneId:"goal",revision:1,updatedAt:""}]});
  for(const [i,state] of (["parked","archived","active"] as const).entries())c.changes({from:i+1,to:i+2,events:[{version:i+2,kind:"lane",value:{...l,state,revision:i+2}}]});
  assert.equal(c.memberships.size,3);
  assert.equal(rows.every(r=>r.status==="todo"),true);
});
