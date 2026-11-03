// The board's "stale since" banner against synthetic RPC data; no installed plugin access.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { task } from "./fixtures.ts";

test("the board shows when the server cache has been stale for a while", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  for (const key of ["window", "document", "HTMLElement", "Element", "Node", "MutationObserver",
    "Event", "CustomEvent", "KeyboardEvent", "MouseEvent", "getComputedStyle", "localStorage",
    "HTMLInputElement", "HTMLSelectElement", "DocumentFragment", "NodeFilter"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  Object.defineProperty(globalThis, "requestAnimationFrame", { value: (fn: () => void) => setTimeout(fn, 0), configurable: true });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { value: clearTimeout, configurable: true });
  Object.defineProperty(globalThis, "ResizeObserver", { value: class { observe() {} disconnect() {} unobserve() {} }, configurable: true });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as any;
  globalThis.fetch = async () => { throw new Error("No live fixture data"); };
  const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  const { screen } = await import("@testing-library/react");
  const app = await loadPluginApp(() => import("../app.tsx"));
  const rows = [task({ id: "a", title: "Synthetic work", projectId: "p" })].map((t) => ({ ...t, rev: 1, live: [] }));
  const staleSince = new Date(Date.now() - 5 * 60_000).toISOString();
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { pluginId: "better-tasks", rpc: {
    snapshot: () => ({ version: 1, rows, projects: [{ id: "p", name: "Project P", prefix: "P", color: "blue" }], labels: [],
      counts: { todo: 1, backlog: 0, in_progress: 0, in_review: 0, done: 0, canceled: 0 }, complete: true }),
    changes: () => ({ changes: { from: 1, to: 1, upserts: [], removes: [] } }),
    health: () => ({ staleSince, reason: "tasks plugin restarted", syncedAt: null }),
    laneSnapshot: () => ({ version: 1, lanes: [], memberships: [] }),
    laneChanges: () => ({ changes: { from: 1, to: 1, events: [] } }),
    search: () => ({ ids: [], truncated: false }),
  } });
  try {
    const banner = await screen.findByText(/Tasks may be out of date since .* \(tasks plugin restarted\)/);
    assert.equal(banner.getAttribute("role"), "status");
    assert.ok(await screen.findByText("Synthetic work"), "the cached board still shows");
  } finally {
    slot.unmount();
  }
});
