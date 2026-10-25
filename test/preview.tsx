// Isolated browser fixture: no installed plugin or live Tasks data.
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
const methods=["snapshot","changes","detail","search","lane","laneSnapshot","laneChanges","laneImportPreview","laneImportApply"];
const rpc=Object.fromEntries(methods.map(method=>[method,async(input:unknown)=>{
  const response=await fetch("/fixture-rpc/"+method,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});
  const body=await response.json();if(!response.ok)throw new Error(body.error);return body;
}]));
const app=await loadPluginApp(()=>import("../app"));
const slot=renderSlot(app.navPanels[0]!,{subPath:new URLSearchParams(location.search).get("task")?"task/DEMO-1":""},{rpc});
Object.assign(window,{fixture:slot});
