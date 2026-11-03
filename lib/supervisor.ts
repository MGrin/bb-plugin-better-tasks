// Keeps the cache honest when the change feed cannot.
//
// The feed tells the sync when to distrust the cache (a reconnect, a Tasks
// plugin restart); the sync marks itself stale on failed reads. This loop
// reloads whenever the cache is stale, retrying with backoff while the Tasks
// plugin is down, and reconciles on a timer even when nothing looks wrong.
// A timed reconcile that finds rows the feed never delivered means the
// subscription died quietly: it logs that and asks for a fresh connection.
import type { FeedHandlers } from "./feed.ts";
import type { TaskSync } from "./sync.ts";

export const RECONCILE_MS = 10 * 60_000;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

export interface SupervisorLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** The feed side of the wiring: signals in, staleness on reconnect or restart. */
export function feedHandlers(sync: TaskSync, log: SupervisorLog): FeedHandlers {
  return {
    onSignal: (channel, payload) => sync.onSignal(channel, payload),
    // Signals are not replayed, so whatever was sent before this socket
    // opened (the first time: before it ever opened) must be re-read.
    onOpen: (reconnected) =>
      sync.markStale(reconnected ? "change feed reconnected" : "change feed connected"),
    onTasksPluginChanged: () => sync.markStale("tasks plugin restarted"),
    log: (message) => log.info(message),
  };
}

/** Sleep `ms`, cut short by an abort or, when given, by the cache going stale. */
function wait(ms: number, signal: AbortSignal, sync?: TaskSync): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const unsubscribe = sync?.onStale(done);
    function done() {
      clearTimeout(timer);
      unsubscribe?.();
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Run until `signal` aborts. Never throws, so it fits `bb.background.service`. */
export async function superviseSync(
  options: {
    sync: TaskSync;
    log: SupervisorLog;
    /** A fresh connection: the feed resubscribes and the cache reloads. */
    onDrift: (drift: number) => void;
    intervalMs?: number;
    backoffMs?: readonly number[];
  },
  signal: AbortSignal,
): Promise<void> {
  const { sync, log, onDrift } = options;
  const intervalMs = options.intervalMs ?? RECONCILE_MS;
  const backoff = options.backoffMs ?? BACKOFF_MS;
  let attempt = 0;
  while (!signal.aborted) {
    const expected = sync.health().staleSince === null && sync.loaded;
    let drift: number;
    try {
      await sync.requestFullLoad();
      drift = sync.stats.lastDrift;
      attempt = 0;
    } catch (error) {
      sync.stats.failedLoads += 1;
      const delay = backoff[Math.min(attempt, backoff.length - 1)]!;
      attempt += 1;
      log.error(`full load failed, retrying in ${delay} ms: ${String(error)}`);
      await wait(delay, signal);
      continue;
    }
    // A timed reconcile on a cache that looked current found missed rows:
    // the subscription is not delivering. Reconnecting resubscribes.
    if (expected && drift > 0 && sync.health().staleSince === null) {
      log.warn(`reconcile repaired ${drift} rows the change feed never delivered; resubscribing`);
      onDrift(drift);
    }
    // Checked and subscribed in one synchronous step, so no mark is missed.
    if (sync.health().staleSince !== null) continue;
    await wait(intervalMs, signal, sync);
  }
}
