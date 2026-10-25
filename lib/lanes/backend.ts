import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { laneInputSchema } from "./contract.ts";
import type { LaneChanges, LaneReply, LaneSnapshot } from "./model.ts";
import { LaneRepository, MIGRATIONS } from "./repository.ts";
import { LaneService, type LaneAdapters } from "./service.ts";
import { laneCli } from "./cli.ts";

export const laneRpcMethods={
  lane:{input:laneInputSchema,output:z.custom<LaneReply>()},
  laneSnapshot:{input:z.null(),output:z.custom<LaneSnapshot>()},
  laneChanges:{input:z.object({since:z.number().int().nonnegative()}).strict(),output:z.object({changes:z.custom<LaneChanges>().nullable()})},
};
export function laneBackend(bb:BbPluginApi,adapters:LaneAdapters){
  const db=bb.storage.database();bb.storage.migrate(db,MIGRATIONS);
  const repo=new LaneRepository(db);
  const service=new LaneService(repo,adapters,version=>bb.realtime.publish("lanes",{version}));
  // SDK owns the database handle and closes it on disposal/reload.
  bb.cli.register(laneCli(service));
  return {
    async lane(input:z.input<typeof laneInputSchema>){
      return service.execute(input);
    },
    laneSnapshot(){return repo.snapshot();},
    laneChanges({since}:{since:number}){return {changes:repo.changesSince(since)};},
  };
}
