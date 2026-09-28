// The page's data: one ClientStore per page load, filled open-work-first
// and kept current by the server's delta signals.
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { DeltaSignal, Label, Project } from "@/lib/model";
import { ClientStore } from "@/lib/store";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

/** Timings the page records about itself, readable as `window.__betterTasks`. */
export interface BoardMetrics {
  startedAt: number;
  openRowsAt: number | null;
  closedRowsAt: number | null;
  openRows: number;
  allRows: number;
  deltasApplied: number;
  pulls: number;
  snapshots: number;
  lastDeltaAt: number | null;
}

// Module scope: navigating away and back keeps the board, so a revisit is
// instant and only pulls what changed while the page was closed.
const store = new ClientStore();
const metrics: BoardMetrics = {
  startedAt: 0,
  openRowsAt: null,
  closedRowsAt: null,
  openRows: 0,
  allRows: 0,
  deltasApplied: 0,
  pulls: 0,
  snapshots: 0,
  lastDeltaAt: null,
};
let loading: Promise<void> | null = null;
let error: string | null = null;
(globalThis as { __betterTasks?: unknown }).__betterTasks = metrics;

function idle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: 200 });
    else setTimeout(resolve, 0);
  });
}

async function load(rpc: Rpc): Promise<void> {
  metrics.startedAt = performance.now();
  const open = await rpc.call("snapshot", { part: "open" });
  metrics.snapshots += 1;
  store.applySnapshot(open, "open");
  metrics.openRowsAt = performance.now();
  metrics.openRows = open.rows.length;
  // Closed work is 93% of the board; fetch it once the open view is up.
  await idle();
  const closed = await rpc.call("snapshot", { part: "closed" });
  metrics.snapshots += 1;
  store.applySnapshot(closed, "closed");
  metrics.closedRowsAt = performance.now();
  metrics.allRows = store.rows.size;
}

function start(rpc: Rpc): void {
  error = null;
  loading = load(rpc).catch((cause: unknown) => {
    error = cause instanceof Error ? cause.message : String(cause);
    loading = null;
    store.touch();
  });
  store.touch();
}

let pulling: Promise<void> | null = null;
let pullAgain = false;

function pull(rpc: Rpc): Promise<void> {
  if (pulling !== null) {
    pullAgain = true;
    return pulling;
  }
  pulling = (async () => {
    try {
      do {
        pullAgain = false;
        metrics.pulls += 1;
        const { changes } = await rpc.call("changes", { since: Math.max(0, store.version) });
        if (changes !== null) store.applyChanges(changes);
        else {
          // The server's change log no longer reaches back: take it all again.
          const all = await rpc.call("snapshot", { part: "all" });
          metrics.snapshots += 1;
          store.replaceAll(all);
        }
      } while (pullAgain);
    } finally {
      pulling = null;
    }
  })();
  return pulling;
}

export function useBoard() {
  const rpc = useRpc<typeof rpcContract>();
  const revision = useSyncExternalStore(store.subscribe, store.getRevision);
  const connection = useRealtimeConnectionState();
  const lastConnection = useRef(connection);

  useEffect(() => {
    if (loading === null) start(rpc);
    else if (store.version >= 0) {
      // A revisit: catch up on what changed while the page was closed.
      void pull(rpc);
    }
  }, [rpc]);

  useEffect(() => {
    const previous = lastConnection.current;
    lastConnection.current = connection;
    // Signals are not replayed, so reconcile after every reconnect.
    if (previous !== "connected" && connection === "connected" && store.version >= 0) {
      void pull(rpc);
    }
  }, [connection, rpc]);

  useRealtime("delta", (payload) => {
    metrics.lastDeltaAt = performance.now();
    metrics.deltasApplied += 1;
    if (store.onDelta(payload as DeltaSignal) === "pull") void pull(rpc);
  });

  useRealtime("meta", (payload) => {
    const meta = payload as { projects: Project[]; labels: Label[] };
    store.setMeta(meta.projects, meta.labels);
  });

  const retry = useCallback(() => start(rpc), [rpc]);

  return { rpc, store, revision, metrics, error, retry };
}
