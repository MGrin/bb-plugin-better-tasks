import { useEffect, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { CHANNEL_OPEN_COUNT, type OpenCountSignal } from "../lib/model";

// The sidebar badge: tasks not done and not cancelled across every project,
// the same number the built-in Tasks entry shows. The server publishes it
// whenever it changes; a read on each (re)connect covers missed signals.
export function SidebarOpenCount() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    if (connection !== "connected") return;
    let live = true;
    rpc.call("openCount", null).then(
      (result) => {
        if (live) setOpen(result.open);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [connection, rpc]);

  useRealtime(CHANNEL_OPEN_COUNT, (payload) => {
    const { open: next } = payload as OpenCountSignal;
    if (typeof next === "number") setOpen(next);
  });

  return open === null || open === 0 ? null : (
    <span className="text-muted-foreground tabular-nums">{open}</span>
  );
}
