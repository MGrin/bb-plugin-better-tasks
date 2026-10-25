import { useEffect, useMemo, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { laneSelectClass } from "./lane-picker";
import type { LanesController } from "./use-lanes";
import type { Lane, LaneOwner } from "../lib/lanes/model";
import { STATUSES, STATUS_LABEL, type Row } from "../lib/model";
import type { Filters } from "../lib/view";

export function LaneNavigation({controller,filters,onFilters,rows,complete}:{
  controller:LanesController;filters:Filters;onFilters:(f:Filters)=>void;rows:ReadonlyMap<string,Row>;complete:boolean;
}){
  const [open,setOpen]=useState(false);
  const {store,error}=controller;
  const lanes=[...store.lanes.values()].sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
  const selected=filters.laneIds.length===1?store.lanes.get(filters.laneIds[0]!):undefined;
  return <>
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <Button variant="outline" size="sm" onClick={()=>setOpen(true)}>Lanes</Button>
      <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">Lane
        <select className={laneSelectClass+" min-w-0 max-w-64"} aria-label="Lane filter"
          value={filters.noLane?"none":filters.laneIds[0]??"all"}
          onChange={e=>onFilters({...filters,laneIds:e.target.value==="all"||e.target.value==="none"?[]:[e.target.value],noLane:e.target.value==="none"})}>
          <option value="all">All lanes</option><option value="none">No lane</option>
          {lanes.map(l=><option key={l.id} value={l.id}>{l.name} · {l.id.slice(0,8)} ({l.state})</option>)}
        </select>
      </label>
      {error?<span role="alert" className="text-xs text-destructive">Could not load lanes: {error} <button onClick={()=>void controller.refresh().catch(()=>{})}>Retry</button></span>:null}
    </div>
    {selected?<LaneSummary lane={selected} controller={controller} rows={rows} complete={complete}/>:null}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[90dvh] w-[calc(100%-2rem)] max-w-3xl flex-col overflow-y-auto">
        <DialogHeader><div className="flex items-center justify-between gap-2"><DialogTitle>Goal lanes</DialogTitle><Button variant="ghost" size="sm" onClick={()=>setOpen(false)}>Close lanes</Button></div><DialogDescription>Group tasks across projects. Labels stay independent.</DialogDescription></DialogHeader>
        <LaneManager controller={controller} rows={rows} complete={complete} onSelect={id=>{onFilters({...filters,laneIds:[id],noLane:false});setOpen(false);}}/>
      </DialogContent>
    </Dialog>
  </>;
}

function laneStats(lane:Lane,controller:LanesController,rows:ReadonlyMap<string,Row>){
  const counts=Object.fromEntries(STATUSES.map(s=>[s,0])) as Record<Row["status"],number>;
  let working=0,unloaded=0,total=0;
  for(const m of controller.store.memberships.values()){
    if(m.laneId!==lane.id)continue;
    total++;
    const row=rows.get(m.taskId);
    if(!row){unloaded++;continue;}
    counts[row.status]++;if(row.live.length)working++;
  }
  return {counts,working,unloaded,total,open:counts.backlog+counts.todo+counts.in_progress+counts.in_review};
}
function Owner({id,controller}:{id:string|null;controller:LanesController}){
  const [owner,setOwner]=useState<LaneOwner|null>(null);
  const navigate=useBbNavigate();
  useEffect(()=>{
    let live=true;setOwner(null);
    if(id)controller.rpc.call("lane",{op:"owner",threadId:id}).then(r=>{if(live&&r.kind==="owner")setOwner(r.owner);},()=>{if(live)setOwner({id,status:"unknown",title:null});});
    return()=>{live=false;};
  },[id,controller.rpc]);
  if(!id)return <span>No operator</span>;
  return <span className="break-all">
    {owner?.status==="available"||owner?.status==="archived"?<button className="underline" onClick={()=>navigate.toThread(id)}>{owner.title||id}</button>:id}
    {" · "}{owner?.status??"unknown"}
  </span>;
}
function LaneSummary({lane,controller,rows,complete}:{lane:Lane;controller:LanesController;rows:ReadonlyMap<string,Row>;complete:boolean}){
  const stats=laneStats(lane,controller,rows);
  return <section aria-label="Lane detail" className="shrink-0 space-y-1 border-b border-border px-4 py-3 text-sm">
    <div className="flex flex-wrap gap-2"><strong>{lane.name}</strong><span className="text-muted-foreground">{lane.state} · {lane.id}</span></div>
    {lane.goal?<p className="whitespace-pre-wrap break-words">{lane.goal}</p>:null}
    <div className="text-xs text-muted-foreground"><Owner id={lane.ownerThreadId} controller={controller}/></div>
    <p className="text-xs">{stats.total} members · {stats.working} working now{stats.unloaded>0?` · ${stats.unloaded} unavailable in this task view`:""}{!complete?" · Task counts still loading":""}</p>
    <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">{STATUSES.map(s=><span key={s}>{STATUS_LABEL[s]} {stats.counts[s]}</span>)}</p>
  </section>;
}

function LaneManager({controller,rows,complete,onSelect}:{
  controller:LanesController;rows:ReadonlyMap<string,Row>;complete:boolean;onSelect:(id:string)=>void;
}){
  const [query,setQuery]=useState("");
  const [state,setState]=useState("all");
  const [editing,setEditing]=useState<Lane|null|undefined>(undefined);
  const [name,setName]=useState(""),[goal,setGoal]=useState(""),[owner,setOwner]=useState("");
  const [ownerCheck,setOwnerCheck]=useState<LaneOwner|null>(null);
  const [error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false);
  const lanes=useMemo(()=>[...controller.store.lanes.values()].filter(l=>(state==="all"||l.state===state)&&
    (l.name+" "+l.goal+" "+l.id).toLowerCase().includes(query.toLowerCase())).sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id)),
    [controller.revision,controller.store,state,query]);
  function edit(l:Lane|null){setEditing(l);setName(l?.name??"");setGoal(l?.goal??"");setOwner(l?.ownerThreadId??"");setError(null);setOwnerCheck(null);}
  async function save(nextState?:Lane["state"]){
    setBusy(true);setError(null);
    try{
      const result=await controller.mutate(editing?{op:"update",id:editing.id,expectedRevision:editing.revision,
        patch:nextState?{state:nextState}:{name,goal,ownerThreadId:owner.trim()||null}}:{op:"create",name,goal,ownerThreadId:owner.trim()||null});
      if(result.kind==="create")edit(result.lane);
      if(result.kind==="update"&&result.result.ok)edit(result.result.value);
    }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  const current=editing?controller.store.lanes.get(editing.id):null;
  const stats=editing?laneStats(editing,controller,rows):null;
  return <div className="grid min-h-0 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
    <div className="min-w-0 space-y-2">
      <Button size="sm" variant="outline" onClick={()=>edit(null)}>New lane</Button>
      <Input aria-label="Search lanes" placeholder="Search names, goals, IDs" value={query} onChange={e=>setQuery(e.target.value)}/>
      <select aria-label="Lane lifecycle filter" className={laneSelectClass+" w-full"} value={state} onChange={e=>setState(e.target.value)}>
        <option value="all">All, including archived</option><option>active</option><option>parked</option><option>archived</option>
      </select>
      <ul className="max-h-64 space-y-1 overflow-y-auto sm:max-h-96">
        {lanes.map(l=><li key={l.id}><button type="button" aria-label={`Edit lane ${l.name}`} onClick={()=>edit(l)}
          className="w-full rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring">
          <strong className="block break-words">{l.name}</strong><span className="text-xs text-muted-foreground">{l.state} · {l.id.slice(0,8)}</span>
          <p className="truncate text-xs">{l.goal}</p>
        </button></li>)}
      </ul>
      {lanes.length===0?<p className="text-sm text-muted-foreground">No lanes match.</p>:null}
    </div>
    {editing!==undefined?<form className="min-w-0 space-y-3" onSubmit={e=>{e.preventDefault();void save();}}>
      <label className="block space-y-1 text-xs">Lane name<Input aria-label="Lane name" required maxLength={160} value={name} onChange={e=>setName(e.target.value)}/></label>
      <label className="block space-y-1 text-xs">Goal<textarea aria-label="Goal" maxLength={8000} value={goal} onChange={e=>setGoal(e.target.value)}
        className="min-h-24 w-full rounded-md border border-input bg-background p-2 text-sm focus-visible:ring-1 focus-visible:ring-ring"/></label>
      <label className="block space-y-1 text-xs">Operator thread ID (optional)<Input aria-label="Operator thread ID" maxLength={128} value={owner} onChange={e=>{setOwner(e.target.value);setOwnerCheck(null);}}/></label>
      <Button type="button" size="sm" variant="outline" disabled={!owner.trim()||busy} onClick={()=>void controller.rpc.call("lane",{op:"owner",threadId:owner.trim()}).then(r=>{if(r.kind==="owner")setOwnerCheck(r.owner);},()=>setOwnerCheck({id:owner,status:"unknown",title:null}))}>Check operator</Button>
      {ownerCheck?<p role="status" className="text-xs break-all">{ownerCheck.title||ownerCheck.id} · {ownerCheck.status}</p>:null}
      {editing?<><p aria-label="Lane lifecycle" className="text-xs">{current?.state??editing.state} · revision {current?.revision??editing.revision}</p>
        <Owner id={editing.ownerThreadId} controller={controller}/>
        <p className="text-xs">{stats?.total} members · {stats?.open} loaded open tasks{stats?.unloaded?` · ${stats.unloaded} unavailable`:""}{!complete?" · Counts loading":""}</p>
        <p className="text-xs text-muted-foreground">Parking and archiving preserve memberships, task statuses, and running threads.</p>
      </>:null}
      {error?<p role="alert" className="text-sm text-destructive">{error}</p>:null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy||!name.trim()}>{editing?"Save lane":"Create lane"}</Button>
        {editing?<><Button type="button" variant="outline" size="sm" disabled={busy} onClick={()=>onSelect(editing.id)}>View tasks</Button>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={()=>{if(current)edit(current);}}>Reload lane</Button>
          {editing.state==="active"?<Button type="button" variant="outline" size="sm" disabled={busy} onClick={()=>void save("parked")}>Park lane</Button>:<Button type="button" variant="outline" size="sm" disabled={busy} onClick={()=>void save("active")}>Restore lane</Button>}
          {editing.state!=="archived"?<Button type="button" variant="outline" size="sm" disabled={busy} onClick={()=>void save("archived")}>Archive lane ({stats?.open} open)</Button>:null}
        </>:null}
      </div>
    </form>:<p className="text-sm text-muted-foreground">Choose a lane or create one.</p>}
  </div>;
}
