import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { task } from "./fixtures.ts";

function host(){
  const h=createFakePluginHost({sdk:{
    plugins:{callRpc:async({method}: {method:string})=>{
      if(method==="getTask") return {task:task({id:"task"})};
      throw new Error("Unexpected core Tasks call: "+method);
    }},
    threads:{get:async({threadId}:{threadId:string})=>makeThreadResponse({id:threadId,archivedAt:123})},
  }});
  plugin(h.bb);return h;
}
test("RPC and CLI share revisions without full Tasks reads or orchestration",async()=>{
  const {harness}=host();
  const created:any=await harness.behavior.callRpc("lane",{op:"create",name:"A",ownerThreadId:"archived-owner"});
  const lane=created.lane;
  const run=await harness.behavior.runCli(["lane","assign","--input",JSON.stringify({taskId:"task",laneId:lane.id,expectedRevision:0})]);
  assert.equal(run.exitCode,0);
  assert.equal(harness.realtimeSignals.filter(s=>s.channel==="lanes").length,2);
  const conflict:any=await harness.behavior.callRpc("lane",{op:"assign",taskId:"task",laneId:null,expectedRevision:0});
  assert.equal(conflict.result.ok,false);
  const result:any=await harness.behavior.callRpc("lane",{op:"get",id:lane.id});
  assert.equal(result.owner.status,"archived");
  await harness.behavior.callRpc("lane",{op:"update",id:lane.id,patch:{state:"archived"},expectedRevision:1});
  const calls=harness.inspection.sdk.calls;
  assert.equal(calls.filter(c=>c.path==="plugins.callRpc").length,1);
  assert.equal(calls.filter(c=>c.path.startsWith("threads.")&&c.path!=="threads.get").length,0);
  await harness.lifecycle.dispose();
});
test("CLI help is safe, unknown flags fail, stale edits exit nonzero",async()=>{
  const {harness}=host();
  const help=await harness.behavior.runCli(["lane","create","--help"]);
  assert.equal(help.exitCode,0);
  assert.match(help.stdout,/input/);
  assert.equal((await harness.behavior.runCli(["lane","create","--wat"])).exitCode,1);
  const l:any=await harness.behavior.callRpc("lane",{op:"create",name:"A"});
  const run=await harness.behavior.runCli(["lane","archive","--input",JSON.stringify({id:l.lane.id,expectedRevision:0})]);
  assert.equal(run.exitCode,1);
  const changes:any=await harness.behavior.callRpc("laneChanges",{since:0});
  assert.equal(changes.changes.events.length,1);
  await harness.lifecycle.dispose();
});
test("reload preserves lane metadata and lane changes stay independent",async()=>{
  const {harness}=host();
  await harness.behavior.callRpc("lane",{op:"create",name:"Persistent"});
  const next=await harness.lifecycle.reload(plugin);
  const s:any=await next.harness.behavior.callRpc("laneSnapshot",null);
  assert.equal(s.lanes[0].name,"Persistent");
  assert.equal(s.version,1);
  await next.harness.lifecycle.dispose();
  assert.equal(harness.inspection.sdk.calls.filter(c=>c.path==="plugins.callRpc").length,0);
});
