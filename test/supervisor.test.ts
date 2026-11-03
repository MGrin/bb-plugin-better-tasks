// A fake Tasks plugin restart end to end: fake realtime socket, fake Tasks
// RPC, the real feed, sync and supervisor wired the way server.ts wires them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FeedControl, runFeed } from "../lib/feed.ts";
import { feedHandlers, superviseSync } from "../lib/supervisor.ts";
import { TaskSync } from "../lib/sync.ts";
import { FakeRealtime, until } from "./feed-fakes.ts";
import { FakeTasks, task } from "./fixtures.ts";

function boot(options: { intervalMs?: number } = {}) {
  const fake = new FakeTasks();
  const server = new FakeRealtime();
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
  const sync = new TaskSync({ api: fake, publish: () => {}, debounceMs: 1, log: log.warn });
  const control = new FeedControl();
  const abort = new AbortController();
  const feed = runFeed("ws://127.0.0.1:1/ws", feedHandlers(sync, log), abort.signal, {
    createSocket: server.createSocket,
    control,
    pingMs: 5,
    backoffMs: [1],
  });
  const supervisor = superviseSync({
    sync,
    log,
    intervalMs: options.intervalMs ?? 60_000,
    backoffMs: [5],
    onDrift: () => control.reconnect("reconcile found missed changes"),
  }, abort.signal);
  const stop = async () => {
    abort.abort();
    sync.dispose();
    await Promise.all([feed, supervisor]);
  };
  const matches = () =>
    sync.cache.size === fake.tasks.size &&
    [...fake.tasks.values()].every((item) => sync.cache.get(item.id)?.status === item.status);
  return { fake, server, sync, logs, stop, matches };
}

test("a Tasks plugin restart reloads once it is back, and the board matches", async (t) => {
  const { fake, server, sync, logs, stop, matches } = boot();
  t.after(stop);
  const kept = task();
  fake.add(kept, task());
  await until(() => sync.loaded && sync.health().staleSince === null);
  const loadsBefore = sync.stats.fullLoads;

  // The core plugin goes down: bb announces the dispose, reads answer 503,
  // and changes made around the restart are never signalled.
  fake.down = true;
  server.pluginChanged("tasks");
  fake.tasks.set(kept.id, { ...kept, status: "done" });
  fake.add(task(), task());
  await until(() => sync.stats.failedLoads >= 1);
  assert.ok(sync.health().staleSince !== null);
  assert.equal(sync.health().reason, "tasks plugin restarted");

  // It comes back: bb announces the load, and the retry reads everything.
  fake.down = false;
  server.pluginChanged("tasks");
  await until(() => sync.health().staleSince === null);
  assert.ok(sync.stats.fullLoads > loadsBefore + 1);
  assert.ok(matches(), "cache matches the Tasks plugin");
  assert.ok(logs.some((line) => line.startsWith("cache back in step")));
});

test("a subscription that silently stops delivering is caught by the reconcile and resubscribed", async (t) => {
  const { fake, server, sync, logs, stop, matches } = boot({ intervalMs: 30 });
  t.after(stop);
  const item = task();
  fake.add(item);
  await until(() => sync.loaded && sync.health().staleSince === null);
  const sockets = server.sockets.length;

  // The socket stays open but no signal arrives for these changes.
  fake.tasks.set(item.id, { ...item, status: "in_review" });
  fake.add(task());
  await until(matches);
  await until(() => server.sockets.length > sockets);
  assert.ok(sync.stats.driftRepaired >= 2);
  assert.ok(logs.some((line) => /reconcile repaired 2 rows/.test(line)));
  await until(() => server.current.sent.some((frame) => frame.includes("subscribe")));
});

test("a quiet board reconciles without reconnecting or changing the cache", async (t) => {
  const { fake, server, sync, stop } = boot({ intervalMs: 10 });
  t.after(stop);
  fake.add(task(), task());
  await until(() => sync.loaded);
  const loads = sync.stats.fullLoads;
  const version = sync.cache.version;
  const sockets = server.sockets.length;
  await until(() => sync.stats.fullLoads >= loads + 3);
  assert.equal(sync.cache.version, version);
  assert.equal(server.sockets.length, sockets);
});

test("a feed reconnect triggers a reload", async (t) => {
  const { fake, server, sync, stop, matches } = boot();
  t.after(stop);
  fake.add(task());
  await until(() => sync.loaded && sync.health().staleSince === null);
  fake.add(task());
  server.current.drop(1006);
  await until(matches);
  assert.equal(sync.health().staleSince, null);
});

test("a task written on bb 0.48 reaches the cache from its RPC invalidation, with no reconcile", async (t) => {
  // The timed reconcile never runs here: only the feed can deliver the change.
  const { fake, server, sync, logs, stop } = boot({ intervalMs: 60_000 });
  t.after(stop);
  const item = task();
  fake.add(item);
  await until(() => sync.loaded && sync.health().staleSince === null);
  const loads = sync.stats.fullLoads;
  const added = task();

  fake.tasks.set(item.id, { ...item, status: "in_review" });
  server.pluginChanged("tasks", [`task:${item.id}`, "tasks", `tasks:${item.projectId}`]);
  fake.add(added);
  server.pluginChanged("tasks", [`task:${added.id}`, "tasks", `tasks:${added.projectId}`]);

  await until(() => sync.cache.get(item.id)?.status === "in_review" && sync.cache.get(added.id) !== undefined);
  assert.equal(sync.stats.fullLoads, loads, "targeted reads only, no full reload");
  assert.equal(sync.stats.signalsReceived, 2);
  assert.ok(!logs.some((line) => /reconcile repaired/.test(line)));
});
