// The change feed: one WebSocket to bb's own realtime endpoint
// (`bb.server.loopbackBaseUrl` + `/ws`), filtered to the Tasks plugin's
// signals. A plugin's `useRealtime` only hears its own plugin's channels, so
// this is how another plugin learns which task changed.

export interface FeedHandlers {
  /** Every plugin signal the Tasks plugin publishes. */
  onSignal(channel: string, payload: unknown): void;
  /** Fired on every successful connect; `reconnected` is false the first time. */
  onOpen(reconnected: boolean): void;
  log?(message: string): void;
}

const PING_MS = 25_000;
const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000];

export function feedUrl(loopbackBaseUrl: string): string {
  const url = new URL(loopbackBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Parse one realtime frame; returns the Tasks signal or null. */
export function parseTasksSignal(
  data: unknown,
  pluginId = "tasks",
): { channel: string; payload: unknown } | null {
  if (typeof data !== "string") return null;
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof message !== "object" || message === null) return null;
  const { type, pluginId: from, channel, payload } = message as Record<string, unknown>;
  if (type !== "plugin-signal" || from !== pluginId || typeof channel !== "string") {
    return null;
  }
  return { channel, payload };
}

/**
 * Hold the feed open until `signal` aborts, reconnecting with backoff.
 * Resolves when aborted, so it fits `bb.background.service`.
 */
export async function runFeed(
  url: string,
  handlers: FeedHandlers,
  signal: AbortSignal,
): Promise<void> {
  let attempt = 0;
  let connectedBefore = false;
  while (!signal.aborted) {
    const opened = await new Promise<boolean>((resolve) => {
      let didOpen = false;
      const socket = new WebSocket(url);
      let ping: ReturnType<typeof setInterval> | null = null;
      const finish = () => {
        if (ping !== null) clearInterval(ping);
        signal.removeEventListener("abort", onAbort);
        resolve(didOpen);
      };
      const onAbort = () => socket.close();
      signal.addEventListener("abort", onAbort, { once: true });
      socket.onopen = () => {
        didOpen = true;
        attempt = 0;
        handlers.onOpen(connectedBefore);
        connectedBefore = true;
        ping = setInterval(() => socket.send('{"type":"ping"}'), PING_MS);
      };
      socket.onmessage = (event) => {
        const parsed = parseTasksSignal(event.data);
        if (parsed !== null) handlers.onSignal(parsed.channel, parsed.payload);
      };
      socket.onerror = () => handlers.log?.("change feed socket error");
      socket.onclose = finish;
    });
    if (signal.aborted) return;
    if (!opened) attempt += 1;
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
    handlers.log?.(`change feed closed; reconnecting in ${delay} ms`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
