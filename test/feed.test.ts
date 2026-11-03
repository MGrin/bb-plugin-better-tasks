import assert from "node:assert/strict";
import { test } from "node:test";
import { FeedControl, runFeed, type FeedHandlers } from "../lib/feed.ts";
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

test("a Tasks plugin dispose or load is reported; RPC tag invalidations and other plugins are not", async (t) => {
  const server = new FakeRealtime();
  const feed = start(server);
  t.after(feed.stop);
  await until(() => feed.opens.length === 1);
  server.pluginChanged("tasks", ["tasks"]);
  server.pluginChanged("github");
  server.pluginChanged("tasks");
  server.signal("tasks:changed", { taskId: "x" });
  server.signal("tasks:changed", { taskId: "y" }, "github");
  assert.equal(feed.restarts.length, 1);
  assert.deepEqual(feed.signals, ["tasks:changed"]);
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
