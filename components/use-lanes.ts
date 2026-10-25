import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { LaneInput } from "../lib/lanes/contract";
import { LaneClient } from "../lib/lanes/client";

export function useLanes() {
  const [store] = useState(() => new LaneClient());
  const rpc = useRpc<typeof rpcContract>();
  const revision = useSyncExternalStore(store.subscribe, store.getRevision);
  const [error, setError] = useState<string | null>(null);
  const connection = useRealtimeConnectionState();
  const pulling = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const full = useRef(false);
  const previousConnection = useRef(connection);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (pulling.current) {
      again.current = true;
      return pulling.current;
    }
    pulling.current = (async () => {
      do {
        again.current = false;
        if (store.version < 0 || full.current) {
          full.current = false;
          store.snapshot(await rpc.call("laneSnapshot", null), true);
        } else {
          const { changes } = await rpc.call("laneChanges", {
            since: store.version,
          });
          if (changes === null)
            store.snapshot(await rpc.call("laneSnapshot", null), true);
          else if (store.changes(changes) === "pull")
            store.snapshot(await rpc.call("laneSnapshot", null));
        }
      } while (again.current && mounted.current);
      if (mounted.current) setError(null);
    })()
      .catch((e: unknown) => {
        if (mounted.current)
          setError(e instanceof Error ? e.message : String(e));
        throw e;
      })
      .finally(() => {
        pulling.current = null;
      });
    return pulling.current;
  }, [rpc, store]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (
      previousConnection.current !== "connected" &&
      connection === "connected"
    )
      full.current = true;
    previousConnection.current = connection;
    void refresh().catch(() => {});
  }, [connection, refresh]);
  useRealtime("lanes", () => {
    void refresh().catch(() => {});
  });
  const mutate = useCallback(
    async (input: LaneInput) => {
      const result = await rpc.call("lane", input);
      await refresh();
      if ("result" in result && !result.result.ok)
        throw new Error(
          "Lane changed in another session. Reload and review the latest values.",
        );
      return result;
    },
    [rpc, refresh],
  );
  return { store, revision, error, refresh, mutate, rpc };
}
export type LanesController = ReturnType<typeof useLanes>;
