import assert from "node:assert/strict";
import { test } from "node:test";
import { FeedControl, runFeed, tasksSignalsFromTags, type FeedHandlers } from "../lib/feed.ts";
import { FakeRealtime, until } from "./feed-fakes.ts";

function start(server: FakeRealtime, options: { idleMs?: number } = {}) {
  const opens: boolean[] = [];
  const restarts: number[] = [];
  const signals: string[] = [];
  const handlers: FeedHandlers = {
    onSignal: (channel) => signals.push(channel),
    onOpen: (reconnected) => opens.push(reconnected),
    onTasksPluginChanged: () => restarts.push(1),
  };
  const abort = new AbortController();
  const control = new FeedControl();
  const done = runFeed("ws://127.0.0.1:1/ws", handlers, abort.signal, {
    createSocket: server.createSocket,
    control,
    pingMs: 5,
    idleMs: options.idleMs ?? 60_000,
    backoffMs: [1],
  });
  const stop = async () => {
    abort.abort();
    await done;
  };
  return { opens, restarts, signals, control, stop };
}

test("on connect the feed subscribes to Tasks plugin lifecycle changes", async (t) => {
  const server = new FakeRealtime();
  const feed = start(server);
  t.after(feed.stop);
  await until(() => feed.opens.length === 1);
  assert.deepEqual(feed.opens, [false]);
  assert.deepEqual(JSON.parse(server.current.sent[0]!), {
    type: "subscribe",
    target: { kind: "plugin", pluginId: "tasks" },
  });
});

test("a Tasks plugin dispose or load is reported; other plugins are not", async (t) => {
  const server = new FakeRealtime();
  const feed = start(server);
  t.after(feed.stop);
  await until(() => feed.opens.length === 1);
  server.pluginChanged("github");
  server.pluginChanged("github", ["task:x"]);
  server.pluginChanged("tasks");
  server.signal("tasks:changed", { taskId: "x" });
  server.signal("tasks:changed", { taskId: "y" }, "github");
  assert.equal(feed.restarts.length, 1);
  assert.deepEqual(feed.signals, ["tasks:changed"]);
});

// Frames recorded from bb 0.48.1 on 2026-11-03 (MARCO-406 probe): the Tasks
// plugin publishes no plugin-signal; every write is an RPC tag invalidation.
const UPDATE_TAGS = ["task:T1", "tasks", "tasks:P1"];
const COMMENT_TAGS = ["comments:T1"];

test("Tasks RPC invalidations reach the handlers as task signals", async (t) => {
  const server = new FakeRealtime();
  const payloads: { channel: string; payload: unknown }[] = [];
  const abort = new AbortController();
  const done = runFeed(
    "ws://127.0.0.1:1/ws",
    {
      onSignal: (channel, payload) => payloads.push({ channel, payload }),
      onOpen: () => {},
    },
    abort.signal,
    { createSocket: server.createSocket, pingMs: 5, idleMs: 60_000, backoffMs: [1] },
  );
  t.after(async () => {
    abort.abort();
    await done;
  });
  await until(() => server.sockets[0]?.sent.length === 1);
  server.pluginChanged("tasks", [...UPDATE_TAGS, "comments:T1"]);
  server.pluginChanged("tasks", COMMENT_TAGS);
  assert.deepEqual(payloads, [
    { channel: "tasks:changed", payload: { taskId: "T1" } },
    { channel: "comments:changed", payload: { taskId: "T1" } },
    { channel: "comments:changed", payload: { taskId: "T1" } },
  ]);
});

test("tag invalidations map to the narrowest task signal", () => {
  const signals = (tags: string[]) =>
    tasksSignalsFromTags(tags).map(({ channel, payload }) => `${channel} ${JSON.stringify(payload)}`);
  // One task written: re-read that task only.
  assert.deepEqual(signals(UPDATE_TAGS), ['tasks:changed {"taskId":"T1"}']);
  // A thread attached, detached or changing live status.
  assert.deepEqual(signals(["threads:T1", "active-tasks", "task-meta", ...UPDATE_TAGS]), [
    'tasks:changed {"taskId":"T1"}',
    'threads:changed {"taskId":"T1"}',
  ]);
  // A board move touches several tasks and the project counts, not project metadata.
  assert.deepEqual(
    signals(["projects", "task-meta", ...UPDATE_TAGS, "task:T2", "tasks", "tasks:P1", "comments:T2"]),
    ['tasks:changed {"taskId":"T1"}', 'tasks:changed {"taskId":"T2"}', 'comments:changed {"taskId":"T2"}'],
  );
  // A single comment edit uses the singular tag; only the task's list matters.
  assert.deepEqual(signals(["comment:C1", "comments:T1"]), ['comments:changed {"taskId":"T1"}']);
  // A label created or renamed: reload project metadata only.
  assert.deepEqual(signals(["labels:P1"]), ["projects:changed {}"]);
  // A project renamed, re-prefixed or deleted, or a label deleted: no task id, so reload all.
  assert.deepEqual(signals(["projects", "project:P1", "tasks", "tasks:P1", "labels:P1", "task-meta"]), [
    "tasks:changed {}",
    "projects:changed {}",
  ]);
  assert.deepEqual(signals(["projects"]), ["projects:changed {}"]);
  // Nothing the board shows.
  assert.deepEqual(signals(["folders", "presets", "pull-requests:T1", "attachments:T1", "active-tasks"]), []);
});

test("a socket that goes silent is dropped and the feed reconnects", async (t) => {
  const server = new FakeRealtime();
  server.answerPings = false;
  server.silentClose = true;
  const feed = start(server, { idleMs: 20 });
  t.after(feed.stop);
  await until(() => feed.opens.length >= 2);
  assert.deepEqual(feed.opens.slice(0, 2), [false, true]);
  assert.ok(server.sockets.length >= 2);
});

test("a socket that answers pings stays open", async (t) => {
  const server = new FakeRealtime();
  const feed = start(server, { idleMs: 50 });
  t.after(feed.stop);
  await until(() => feed.opens.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(server.sockets.length, 1);
});

test("reconnect() resubscribes on a fresh socket", async (t) => {
  const server = new FakeRealtime();
  const feed = start(server);
  t.after(feed.stop);
  await until(() => feed.opens.length === 1);
  feed.control.reconnect();
  await until(() => feed.opens.length === 2);
  assert.deepEqual(feed.opens, [false, true]);
  assert.equal(server.sockets.length, 2);
  assert.equal(JSON.parse(server.current.sent[0]!).type, "subscribe");
});

test("a bb that rejects the subscribe frame keeps the signal feed without it", async (t) => {
  const server = new FakeRealtime();
  server.rejectSubscribe = true;
  const feed = start(server);
  t.after(feed.stop);
  await until(() => feed.opens.length === 2);
  server.rejectSubscribe = false;
  assert.ok(server.sockets[0]!.sent.some((frame) => frame.includes("subscribe")));
  assert.ok(!server.sockets[1]!.sent.some((frame) => frame.includes("subscribe")));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(server.sockets.length, 2, "no reconnect loop");
});
