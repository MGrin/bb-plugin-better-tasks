// The change feed: one WebSocket to bb's own realtime endpoint
// (`bb.server.loopbackBaseUrl` + `/ws`), subscribed to the Tasks plugin. A
// plugin's `useRealtime` only hears its own plugin's channels, so this is how
// another plugin learns which task changed.
//
// The Tasks plugin in bb 0.48 publishes no plugin signals. Every write calls
// `bb.rpc.experimental_invalidate(tags)`, and bb sends that only to sockets
// subscribed to the plugin, as `{type: "changed", entity: "plugin",
// pluginId: "tasks", tags}`; `tags: null` is the plugin's dispose or load.
// The feed turns those tags into task signals (MARCO-406, probe 2026-11-03),
// still accepts `plugin-signal` frames from a Tasks plugin that sends them,
// pings the server, drops a socket that stops answering, and can be told to
// reconnect.

export interface FeedHandlers {
  /**
   * One task change: `tasks:changed`, `threads:changed` or `comments:changed`
   * with `{ taskId }`, `tasks:changed` with `{}` when no task is named, or
   * `projects:changed`.
   */
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

/** The tag list of a plugin's `changed` frame: null for a restart, undefined if not one. */
function pluginChange(
  message: Record<string, unknown>,
  pluginId: string,
): readonly string[] | null | undefined {
  if (message.type !== "changed" || message.entity !== "plugin" || message.pluginId !== pluginId) {
    return undefined;
  }
  if (message.tags === null) return null;
  return Array.isArray(message.tags)
    ? message.tags.filter((tag): tag is string => typeof tag === "string")
    : undefined;
}

export interface TasksSignal {
  channel: string;
  payload: unknown;
}

function idsAfter(tags: readonly string[], prefix: string): string[] {
  return tags.filter((tag) => tag.startsWith(prefix)).map((tag) => tag.slice(prefix.length));
}

/**
 * Turn one Tasks plugin RPC invalidation into the narrowest task signals.
 * Its tags (bb 0.48 Tasks server): `task:<id>` for a task written,
 * `threads:<taskId>` and `comments:<taskId>` for its threads and comments,
 * `tasks` and `tasks:<projectId>` for task lists, `projects`,
 * `project:<id>` and `labels:<projectId>` for metadata. A write to named
 * tasks also lists `tasks` and often `projects`; only a frame without any
 * `task:` tag means a change that no task id covers.
 */
export function tasksSignalsFromTags(tags: readonly string[]): TasksSignal[] {
  const signals: TasksSignal[] = [];
  const add = (channel: string, ids: string[]) => {
    for (const taskId of new Set(ids)) signals.push({ channel, payload: { taskId } });
  };
  const tasks = idsAfter(tags, "task:");
  add("tasks:changed", tasks);
  add("threads:changed", idsAfter(tags, "threads:"));
  add("comments:changed", idsAfter(tags, "comments:"));
  if (tasks.length > 0) return signals;
  if (tags.some((tag) => tag === "tasks" || tag.startsWith("tasks:"))) {
    signals.push({ channel: "tasks:changed", payload: {} });
  }
  if (tags.some((tag) => tag === "projects" || tag.startsWith("labels:"))) {
    signals.push({ channel: "projects:changed", payload: {} });
  }
  return signals;
}

/** Everything one realtime frame means for the Tasks plugin. */
export function readTasksFrame(
  data: unknown,
  pluginId = "tasks",
): { signals: TasksSignal[]; restart: boolean } {
  const message = parse(data);
  if (message === null) return { signals: [], restart: false };
  if (
    message.type === "plugin-signal" &&
    message.pluginId === pluginId &&
    typeof message.channel === "string"
  ) {
    return { signals: [{ channel: message.channel, payload: message.payload }], restart: false };
  }
  const tags = pluginChange(message, pluginId);
  if (tags === null) return { signals: [], restart: true };
  return { signals: tags === undefined ? [] : tasksSignalsFromTags(tags), restart: false };
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
  // its Tasks plugin's broadcast signals still arrive, so stop sending it.
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
        const frame = readTasksFrame(event.data);
        if (frame.restart) handlers.onTasksPluginChanged?.();
        for (const { channel, payload } of frame.signals) handlers.onSignal(channel, payload);
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
