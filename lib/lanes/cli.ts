import { cliCommand, defineCli } from "@get-bb/plugin-sdk";
import type { LaneService } from "./service.ts";

export function laneCli(service:LaneService){
  function command(op:string){
    return cliCommand({
      summary:`Lane ${op}. Input is a JSON object; writes require expectedRevision.`,
      options:{input:{type:"string",description:"JSON input, max 64 KiB; list/get limit 1–500",default:"{}"}},
      async run(input){
        if(input.options.input.length>65536)throw new Error("Input exceeds 64 KiB");
        const fields:unknown=JSON.parse(input.options.input);
        if(!fields||typeof fields!=="object"||Array.isArray(fields))throw new Error("Input must be an object");
        const data=fields as Record<string,unknown>;
        let request:Record<string,unknown>={...data,op};
        if(op==="archive"||op==="restore")request={...data,op:"update",patch:{state:op==="archive"?"archived":"active"}};
        if(op==="unassign")request={...data,op:"assign",laneId:null};
        const result=await service.execute(request);
        const conflict=("result" in result && !result.result.ok);
        return {exitCode:conflict?1:0,stdout:JSON.stringify(result)+"\n"};
      },
    });
  }
  return defineCli({
    name:"better-tasks",summary:"First-class cross-project goal lanes; labels remain independent.",
    commands:{
      "lane list":command("list"),"lane get":command("get"),"lane create":command("create"),
      "lane update":command("update"),"lane archive":command("archive"),"lane restore":command("restore"),
      "lane assign":command("assign"),"lane unassign":command("unassign"),"lane owner":command("owner"),
    },
  });
}
