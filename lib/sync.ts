// Keeps a TaskCache in step with the Tasks plugin through its public RPC.
//
// Load once (open work first, then closed, then who is working on what),
// then patch one task at a time as the Tasks plugin announces changes. A
// full reload happens only when the change feed reconnects, because only
// then could an announcement have been missed.
import { TaskCache, type TaskFields } from "./cache.ts";
import {
  CHANNEL_DELTA,
  CHANNEL_META,
  CHANNEL_TOUCHED,
  CLOSED_STATUSES,
  OPEN_STATUSES,
  type Changes,
  type DeltaSignal,
  type Label,
  type LiveThread,
  type Project,
  type Status,
} from "./model.ts";

export interface TaskThreadFields {
  threadId: string;
  title: string;
  liveStatus: "starting" | "working" | "idle" | "completed" | "failed";
}

/** The slice of the Tasks plugin's RPC this plugin reads. */
export interface TasksApi {
  listTasks(input: {
    statuses?: Status[];
    activeOnly?: boolean;
    limit: number;
    cursor?: string;
  }): Promise<{ tasks: TaskFields[]; nextCursor: string | null }>;
  getTask(taskId: string): Promise<TaskFields | null>;
  listTaskThreads(taskId: string): Promise<TaskThreadFields[]>;
  listProjects(): Promise<Project[]>;
  listLabels(projectId: string): Promise<Label[]>;
}

export interface SyncStats {
  fullLoads: number;
  pagesRead: number;
  getTaskCalls: number;
  threadCalls: number;
  signalsReceived: number;
  flushes: number;
  cursorRestarts: number;
  failedLoads: number;
  lastFlushMs: number;
  lastFullLoadMs: number;
  openReadyMs: number | null;
}

const PAGE = 500;
const INLINE_ROWS_MAX = 300;
const CONCURRENCY = 8;
const STALE_CURSOR_RETRIES = 5;

function isStaleCursor(error: unknown): boolean {
  return String(error).includes("changed after this cursor was issued");
}

export function liveOnly(threads: readonly TaskThreadFields[]): LiveThread[] {
  const live: LiveThread[] = [];
  for (const thread of threads) {
    if (thread.liveStatus === "starting" || thread.liveStatus === "working") {
      live.push({
        threadId: thread.threadId,
        title: thread.title,
        liveStatus: thread.liveStatus,
      });
    }
  }
  return live;
}

async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await run(item);
    }
  });
  await Promise.all(workers);
}

export class TaskSync {
  readonly cache = new TaskCache();
  readonly stats: SyncStats = {
    fullLoads: 0,
    pagesRead: 0,
    getTaskCalls: 0,
    threadCalls: 0,
    signalsReceived: 0,
    flushes: 0,
    cursorRestarts: 0,
    failedLoads: 0,
    lastFlushMs: 0,
    lastFullLoadMs: 0,
    openReadyMs: null,
  };
  projects: Project[] = [];
  labels: Label[] = [];
  openReady: Promise<void>;
  allReady: Promise<void>;
  #resolveOpen!: () => void;
  #resolveAll!: () => void;
  #loaded = false;

  readonly #api: TasksApi;
  readonly #publish: (channel: string, payload: unknown) => void;
  readonly #debounceMs: number;
  readonly #log: (message: string) => void;
  readonly #taskQueue = new Set<string>();
  readonly #threadQueue = new Set<string>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #flushing: Promise<void> | null = null;
  #published = 0;
  #disposed = false;
  #touchedDuringLoad: Set<string> | null = null;
  #loading: Promise<void> | null = null;
  #reloadQueued = false;

  constructor(options: {
    api: TasksApi;
    publish: (channel: string, payload: unknown) => void;
    debounceMs?: number;
    log?: (message: string) => void;
  }) {
    this.#api = options.api;
    this.#publish = options.publish;
    this.#debounceMs = options.debounceMs ?? 25;
    this.#log = options.log ?? (() => {});
    this.openReady = new Promise((resolve) => (this.#resolveOpen = resolve));
    this.allReady = new Promise((resolve) => (this.#resolveAll = resolve));
  }

  get loaded(): boolean {
    return this.#loaded;
  }

  /**
   * Run a full load, or queue exactly one more if one is already running
   * (a reconnect during the load must still re-read afterwards).
   */
  requestFullLoad(): Promise<void> {
    if (this.#loading !== null) {
      this.#reloadQueued = true;
      return this.#loading;
    }
    this.#loading = (async () => {
      try {
        do {
          this.#reloadQueued = false;
          await this.fullLoad();
        } while (this.#reloadQueued && !this.#disposed);
      } finally {
        this.#loading = null;
      }
    })();
    return this.#loading;
  }

  /**
   * Read every task. The first call resolves `openReady` as soon as open work
   * is cached; later calls (a feed reconnect) diff against the cache and drop
   * tasks that no longer exist.
   */
  async fullLoad(): Promise<void> {
    const started = performance.now();
    this.stats.fullLoads += 1;
    const seen = new Set<string>();
    this.#touchedDuringLoad = new Set();
    try {
      await this.loadMeta();
      await this.#readPages({ statuses: [...OPEN_STATUSES] }, seen);
      if (this.stats.openReadyMs === null) {
        this.stats.openReadyMs = performance.now() - started;
      }
      this.#resolveOpen();
      this.#publishChanges();
      await this.#readPages({ statuses: [...CLOSED_STATUSES] }, seen);
      await this.#loadLive();
      const touched = this.#touchedDuringLoad;
      for (const id of [...this.cache.ids()]) {
        if (!seen.has(id) && !touched.has(id)) this.cache.remove(id);
      }
    } finally {
      this.#touchedDuringLoad = null;
    }
    this.#loaded = true;
    this.stats.lastFullLoadMs = performance.now() - started;
    this.#resolveAll();
    this.#publishChanges();
  }

  async loadMeta(): Promise<void> {
    const projects = await this.#api.listProjects();
    const labelLists = await Promise.all(
      projects.map((project) => this.#api.listLabels(project.id)),
    );
    this.projects = projects.map(({ id, name, prefix, color }) => ({
      id,
      name,
      prefix,
      color,
    }));
    this.labels = labelLists.flat().map(({ id, projectId, name, color }) => ({
      id,
      projectId,
      name,
      color,
    }));
  }

  /** A Tasks plugin realtime signal, as heard on the change feed. */
  onSignal(channel: string, payload: unknown): void {
    if (this.#disposed) return;
    const taskId =
      typeof payload === "object" && payload !== null
        ? (payload as { taskId?: unknown }).taskId
        : undefined;
    if (channel === "projects:changed") {
      void this.loadMeta().then(
        () => this.#publish(CHANNEL_META, { projects: this.projects, labels: this.labels }),
        (error: unknown) => this.#log(`meta reload failed: ${String(error)}`),
      );
      return;
    }
    if (typeof taskId !== "string") return;
    this.stats.signalsReceived += 1;
    if (channel === "tasks:changed") this.#taskQueue.add(taskId);
    else if (channel === "threads:changed") this.#threadQueue.add(taskId);
    else if (channel === "comments:changed") {
      this.#publish(CHANNEL_TOUCHED, { taskId, what: "comments" });
      return;
    } else return;
    this.#touchedDuringLoad?.add(taskId);
    this.#schedule();
  }

  /** Apply a task the caller already holds (the result of our own write). */
  applyTask(task: TaskFields): void {
    this.#touchedDuringLoad?.add(task.id);
    this.cache.upsert(task);
    this.#publishChanges();
  }

  /** Resolve once every queued signal has been applied. For tests and writes. */
  async settle(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
      await this.#flush();
    }
    while (this.#flushing !== null) await this.#flushing;
  }

  changesSince(since: number): Changes | null {
    return this.cache.changesSince(since);
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#flush();
    }, this.#debounceMs);
  }

  async #flush(): Promise<void> {
    if (this.#flushing !== null) {
      await this.#flushing;
      if (this.#taskQueue.size + this.#threadQueue.size > 0) this.#schedule();
      return;
    }
    const started = performance.now();
    const tasks = [...this.#taskQueue];
    const threads = [...this.#threadQueue];
    this.#taskQueue.clear();
    this.#threadQueue.clear();
    const run = async () => {
      await eachLimited(tasks, CONCURRENCY, async (taskId) => {
        this.stats.getTaskCalls += 1;
        try {
          const task = await this.#api.getTask(taskId);
          if (task === null) this.cache.remove(taskId);
          else this.cache.upsert(task);
        } catch (error) {
          this.#log(`getTask ${taskId} failed: ${String(error)}`);
        }
      });
      await eachLimited(threads, CONCURRENCY, async (taskId) => {
        if (this.cache.get(taskId) === undefined) return;
        this.stats.threadCalls += 1;
        try {
          this.cache.setLive(taskId, liveOnly(await this.#api.listTaskThreads(taskId)));
        } catch (error) {
          this.#log(`listTaskThreads ${taskId} failed: ${String(error)}`);
        }
        this.#publish(CHANNEL_TOUCHED, { taskId, what: "threads" });
      });
      this.stats.flushes += 1;
      this.stats.lastFlushMs = performance.now() - started;
      this.#publishChanges();
    };
    this.#flushing = run().finally(() => {
      this.#flushing = null;
    });
    await this.#flushing;
  }

  async #readPages(filter: { statuses: Status[] }, seen: Set<string>): Promise<void> {
    await this.#paginate(filter, (tasks) => {
      for (const task of tasks) {
        seen.add(task.id);
        this.cache.upsert(task);
      }
    });
  }

  /**
   * Page through listTasks. The Tasks plugin invalidates a cursor when any
   * task changes mid-read; that restarts the pass from the top (upserts are
   * idempotent), a bounded number of times.
   */
  async #paginate(
    filter: { statuses?: Status[]; activeOnly?: boolean },
    onPage: (tasks: TaskFields[]) => void,
  ): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      let cursor: string | undefined;
      try {
        do {
          const page = await this.#api.listTasks({
            ...filter,
            limit: PAGE,
            ...(cursor === undefined ? {} : { cursor }),
          });
          this.stats.pagesRead += 1;
          onPage(page.tasks);
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined && !this.#disposed);
        return;
      } catch (error) {
        if (!isStaleCursor(error) || attempt >= STALE_CURSOR_RETRIES) throw error;
        this.stats.cursorRestarts += 1;
      }
    }
  }

  async #loadLive(): Promise<void> {
    const active = new Set<string>();
    await this.#paginate({ activeOnly: true }, (tasks) => {
      for (const task of tasks) active.add(task.id);
    });
    for (const id of this.cache.ids()) {
      const row = this.cache.get(id);
      if (row !== undefined && row.live.length > 0 && !active.has(id)) {
        this.cache.setLive(id, []);
      }
    }
    await eachLimited([...active], CONCURRENCY, async (taskId) => {
      this.stats.threadCalls += 1;
      this.cache.setLive(taskId, liveOnly(await this.#api.listTaskThreads(taskId)));
    });
  }

  #publishChanges(): void {
    const version = this.cache.version;
    if (version === this.#published) return;
    const changes = this.cache.changesSince(this.#published);
    const signal: DeltaSignal =
      changes === null
        ? { kind: "range", from: this.#published, to: version }
        : changes.upserts.length + changes.removes.length <= INLINE_ROWS_MAX
        ? { kind: "rows", ...changes }
        : { kind: "range", from: changes.from, to: changes.to };
    this.#published = version;
    this.#publish(CHANNEL_DELTA, signal);
  }
}
