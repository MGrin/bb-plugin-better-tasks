// The change feed: one WebSocket to bb's own realtime endpoint
// (`bb.server.loopbackBaseUrl` + `/ws`), filtered to the Tasks plugin's
// signals. A plugin's `useRealtime` only hears its own plugin's channels, so
// this is how another plugin learns which task changed.
//
// bb broadcasts plugin signals to every socket, and announces a plugin's
// dispose and load to sockets subscribed to that plugin. The feed subscribes
// to the Tasks plugin so a restart of it is heard, pings the server and
// drops a socket that stops answering, and can be told to reconnect.

export interface FeedHandlers {
  /** Every plugin signal the Tasks plugin publishes. */
  onSignal(channel: string, payload: unknown): void;
  /** Fired on every successful connect; `reconnected` is false the first time. */
  onOpen(reconnected: boolean): void;
  /** The Tasks plugin was disposed or loaded (a restart sends both). */
  onTasksPluginChanged?(): void;
  log?(message: string): void;
}

/** The part of a WebSocket the feed uses; tests pass a fake. */
export interface FeedSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface FeedOptions {
  createSocket?: (url: string) => FeedSocket;
  control?: FeedControl;
  pingMs?: number;
  /** Drop the socket when no frame (pongs included) arrives for this long. */
  idleMs?: number;
  backoffMs?: readonly number[];
}

/** Lets the owner force a fresh connection, and so a fresh subscription. */
export class FeedControl {
  #drop: ((reason: string) => void) | null = null;

  /** Drop the current socket; the feed reconnects and fires `onOpen(true)`. */
  reconnect(reason = "reconnect requested"): void {
    this.#drop?.(reason);
  }

  /** @internal */
  attach(drop: ((reason: string) => void) | null): void {
    this.#drop = drop;
  }
}

const PING_MS = 25_000;
const IDLE_MS = 3 * PING_MS;
const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000];
/** bb closes a socket with 1008 when it does not understand a frame. */
const POLICY_VIOLATION = 1008;

export function feedUrl(loopbackBaseUrl: string): string {
  const url = new URL(loopbackBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function parse(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string") return null;
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  return typeof message === "object" && message !== null
    ? (message as Record<string, unknown>)
    : null;
}

/** Parse one realtime frame; returns the Tasks signal or null. */
export function parseTasksSignal(
  data: unknown,
  pluginId = "tasks",
): { channel: string; payload: unknown } | null {
  const message = parse(data);
  if (message === null) return null;
  const { type, pluginId: from, channel, payload } = message;
  if (type !== "plugin-signal" || from !== pluginId || typeof channel !== "string") {
    return null;
  }
  return { channel, payload };
}

/**
 * Whether a frame announces the plugin's dispose or load. `tags: null` is
 * the whole plugin; a tag list is only an RPC cache invalidation.
 */
export function isPluginRestart(data: unknown, pluginId = "tasks"): boolean {
  const message = parse(data);
  return (
    message !== null &&
    message.type === "changed" &&
    message.entity === "plugin" &&
    message.pluginId === pluginId &&
    message.tags === null
  );
}

const SUBSCRIBE = JSON.stringify({
  type: "subscribe",
  target: { kind: "plugin", pluginId: "tasks" },
});

/**
 * Hold the feed open until `signal` aborts, reconnecting with backoff.
 * Resolves when aborted, so it fits `bb.background.service`.
 */
export async function runFeed(
  url: string,
  handlers: FeedHandlers,
  signal: AbortSignal,
  options: FeedOptions = {},
): Promise<void> {
  const createSocket =
    options.createSocket ?? ((target: string) => new WebSocket(target) as unknown as FeedSocket);
  const pingMs = options.pingMs ?? PING_MS;
  const idleMs = options.idleMs ?? IDLE_MS;
  const backoff = options.backoffMs ?? BACKOFF_MS;
  let attempt = 0;
  let connectedBefore = false;
  // An older bb without plugin subscriptions closes the socket on the frame;
  // the signal feed works without it, so stop sending it.
  let subscribe = true;
  while (!signal.aborted) {
    const opened = await new Promise<boolean>((resolve) => {
      let didOpen = false;
      let subscribedHere = false;
      let finished = false;
      let lastFrame = Date.now();
      const socket = createSocket(url);
      let ping: ReturnType<typeof setInterval> | null = null;
      const finish = (code?: number) => {
        if (finished) return;
        finished = true;
        if (ping !== null) clearInterval(ping);
        signal.removeEventListener("abort", onAbort);
        options.control?.attach(null);
        socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
        if (code === POLICY_VIOLATION && subscribedHere) {
          subscribe = false;
          handlers.log?.("bb rejected the Tasks plugin subscription; feed continues without it");
        }
        resolve(didOpen);
      };
      // Close, and do not wait on a peer that may never answer.
      const drop = (reason: string) => {
        handlers.log?.(`change feed: ${reason}; reconnecting`);
        try {
          socket.close();
        } catch {
          // Already closing.
        }
        finish();
      };
      const onAbort = () => drop("stopping");
      signal.addEventListener("abort", onAbort, { once: true });
      options.control?.attach(drop);
      socket.onopen = () => {
        didOpen = true;
        attempt = 0;
        lastFrame = Date.now();
        if (subscribe) {
          subscribedHere = true;
          socket.send(SUBSCRIBE);
        }
        handlers.onOpen(connectedBefore);
        connectedBefore = true;
        ping = setInterval(() => {
          if (Date.now() - lastFrame > idleMs) {
            drop(`no frame for ${idleMs} ms`);
            return;
          }
          socket.send('{"type":"ping"}');
        }, pingMs);
      };
      socket.onmessage = (event) => {
        lastFrame = Date.now();
        const parsed = parseTasksSignal(event.data);
        if (parsed !== null) handlers.onSignal(parsed.channel, parsed.payload);
        else if (isPluginRestart(event.data)) handlers.onTasksPluginChanged?.();
      };
      socket.onerror = () => handlers.log?.("change feed socket error");
      socket.onclose = (event) => finish(event.code);
    });
    if (signal.aborted) return;
    if (!opened) attempt += 1;
    const delay = backoff[Math.min(attempt, backoff.length - 1)]!;
    handlers.log?.(`change feed closed; reconnecting in ${delay} ms`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, delay);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    });
  }
}
