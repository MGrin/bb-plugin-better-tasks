// A fake bb realtime endpoint for the change feed. Synthetic frames only.
import type { FeedSocket } from "../lib/feed.ts";

export class FakeSocket implements FeedSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(readonly server: FakeRealtime) {}

  send(data: string): void {
    if (this.closed) return;
    this.sent.push(data);
    const message = JSON.parse(data) as { type?: string };
    if (message.type === "ping" && this.server.answerPings) {
      queueMicrotask(() => this.frame({ type: "pong" }));
    }
    if (message.type === "subscribe" && this.server.rejectSubscribe) {
      queueMicrotask(() => this.drop(1008));
    }
  }

  close(): void {
    // A half-dead peer never completes the close handshake.
    if (this.server.silentClose) return;
    this.drop(1000);
  }

  open(): void {
    this.onopen?.();
  }

  frame(message: unknown): void {
    if (!this.closed) this.onmessage?.({ data: JSON.stringify(message) });
  }

  drop(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({ code });
  }
}

/** Every socket the feed opened, newest last; opens each one on the next tick. */
export class FakeRealtime {
  sockets: FakeSocket[] = [];
  answerPings = true;
  rejectSubscribe = false;
  silentClose = false;

  createSocket = (): FakeSocket => {
    const socket = new FakeSocket(this);
    this.sockets.push(socket);
    setTimeout(() => socket.open(), 0);
    return socket;
  };

  get current(): FakeSocket {
    return this.sockets.at(-1)!;
  }

  /** What bb broadcasts when a plugin is disposed or loaded. */
  pluginChanged(pluginId: string, tags: string[] | null = null): void {
    this.current.frame({ type: "changed", entity: "plugin", pluginId, tags });
  }

  signal(channel: string, payload: unknown, pluginId = "tasks"): void {
    this.current.frame({ type: "plugin-signal", pluginId, channel, payload });
  }
}

export async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
