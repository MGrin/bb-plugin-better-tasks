// Real board/filter interactions against synthetic RPC data; no installed plugin access.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { task } from "./fixtures.ts";
import type { Lane } from "../lib/lanes/model.ts";

const lane = (id: string, name: string, state: Lane["state"] = "active"): Lane => ({
  id, name, state, goal: "Synthetic goal", ownerThreadId: null, revision: 1,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
});
const lanes = [lane("alpha", "Alpha"), lane("parked", "Shared", "parked"),
  lane("archived", "Shared", "archived"), lane("long", "A very long synthetic lane name for narrow screens")];

test("lane checkboxes compose, persist, reset and retain archived or missing selections", async () => {
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
  const { screen, waitFor } = await import("@testing-library/react");
  const { default: userEvent } = await import("@testing-library/user-event");
  const user = userEvent.setup({ document: dom.window.document });
  const app = await loadPluginApp(() => import("../app.tsx"));
  const tasks = [task({ id: "a", title: "Alpha work", projectId: "p" }),
    task({ id: "b", title: "Archived work", projectId: "q" }),
    task({ id: "c", title: "Unassigned work", projectId: "p" }),
    task({ id: "d", title: "Alpha other project", projectId: "q" })];
  let snapshotState: "ready" | "loading" | "error" | "empty" = "ready";
  let release: (() => void) | undefined;
  const mount = () => renderSlot(app.navPanels[0]!, { subPath: "" }, { pluginId: "better-tasks", rpc: {
    snapshot: () => ({ version: 1, rows: tasks.map(t => ({ ...t, rev: 1, live: [] })),
      projects: [{ id: "p", name: "Project P", prefix: "P", color: "blue" }, { id: "q", name: "Project Q", prefix: "Q", color: "red" }], labels: [],
      counts: { todo: 4, backlog: 0, in_progress: 0, in_review: 0, done: 0, canceled: 0 }, complete: true }),
    changes: () => ({ changes: { from: 1, to: 1, upserts: [], removes: [] } }),
    laneSnapshot: async () => {
      if (snapshotState === "loading") await new Promise<void>(resolve => { release = resolve; });
      if (snapshotState === "error") throw new Error("Synthetic offline");
      return { version: 1, lanes: snapshotState === "empty" ? [] : lanes,
        memberships: [{ taskId: "a", laneId: "alpha", revision: 1, updatedAt: "" }, { taskId: "b", laneId: "archived", revision: 1, updatedAt: "" },
          { taskId: "d", laneId: "alpha", revision: 1, updatedAt: "" }] };
    },
    laneChanges: () => ({ changes: { from: 1, to: 1, events: [] } }),
    search: () => ({ ids: [], truncated: false }),
  } });
  let slot = mount();
  const checkbox = (name: string | RegExp) => screen.getByRole("menuitemcheckbox", { name });
  const saved = () => JSON.parse(localStorage.getItem("better-tasks:ui:v1")!).filters;
  try {
    await user.click(await screen.findByRole("button", { name: "Lanes" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /Alpha.*active/i }));
    assert.deepEqual(saved().laneIds, ["alpha"]);
    assert.equal(checkbox(/Alpha.*active/i).getAttribute("aria-checked"), "true");
    assert.ok(screen.getByText("Alpha work"));
    assert.equal(screen.queryByText("Unassigned work"), null);
    assert.match(screen.getByRole("region", { name: "Lane detail", hidden: true }).textContent!, /Alpha/);
    await user.click(checkbox("No lane"));
    assert.ok(screen.getByText("Unassigned work"));
    assert.equal(screen.queryByRole("region", { name: "Lane detail", hidden: true }), null);
    await user.click(checkbox(/Shared.*archived/i));
    assert.ok(screen.getByText("Archived work"));
    assert.deepEqual(saved().laneIds, ["alpha", "archived"]);
    assert.equal(saved().noLane, true);
    assert.match(screen.getByRole("button", { name: "Lanes", hidden: true }).textContent!, /2 lanes \+ No lane/);
    assert.match(checkbox(/Shared.*parked/i).textContent!, /parked/);
    assert.doesNotMatch(checkbox(/Alpha.*active/i).textContent!, /alpha/);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Projects" }));
    await user.click(checkbox(/Project P/));
    await user.keyboard("{Escape}");
    assert.equal(screen.queryByText("Archived work"), null);
    assert.equal(screen.queryByText("Alpha other project"), null);
    await user.click(screen.getByRole("button", { name: "Filter" }));
    await user.click(checkbox("Todo"));
    await user.keyboard("{Escape}");
    await user.type(screen.getByRole("textbox", { name: "Search tasks" }), "Alpha");
    assert.ok(screen.getByText("Alpha work"));
    assert.equal(screen.queryByText("Unassigned work"), null);
    await user.click(screen.getByRole("button", { name: "Lanes" }));
    await user.click(checkbox("All lanes"));
    assert.deepEqual(saved().laneIds, []);
    assert.equal(saved().noLane, false);
    assert.deepEqual(saved().projectIds, ["p"]);
    assert.equal(saved().search, "Alpha");
    assert.deepEqual(saved().statuses, ["todo"]);
    await user.click(checkbox("No lane"));
    await user.keyboard("{Escape}");
    await user.clear(screen.getByRole("textbox", { name: "Search tasks" }));
    assert.ok(screen.getByText("Unassigned work"));
    assert.equal(screen.queryByText("Alpha work"), null);
    // Persisted archived and unknown IDs must survive reload and remain removable.
    slot.lifecycle.unmount();
    localStorage.setItem("better-tasks:ui:v1", JSON.stringify({ filters: { laneIds: ["archived", "missing-id"] } }));
    slot = mount();
    await user.click(await screen.findByRole("button", { name: "Lanes" }));
    await waitFor(() => assert.equal(checkbox(/Shared.*archived/i).getAttribute("aria-checked"), "true"));
    await user.click(checkbox(/Unavailable lane/));
    assert.deepEqual(saved().laneIds, ["archived"]);
    assert.ok(screen.getByRole("region", { name: "Lane detail", hidden: true }));
    await user.keyboard("{Escape}");
    // Keyboard opening, navigation, toggling and focus return use the shared menu.
    const trigger = screen.getByRole("button", { name: "Lanes" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    await waitFor(() => assert.equal(document.activeElement, checkbox("All lanes")));
    await user.keyboard("{ArrowDown}{Enter}");
    assert.equal(saved().noLane, true);
    await user.keyboard("{Escape}");
    await waitFor(() => assert.equal(document.activeElement, trigger));
    // Loading, error/retry and empty states must keep management available.
    slot.lifecycle.unmount();
    localStorage.clear();
    snapshotState = "loading";
    slot = mount();
    await user.click(await screen.findByRole("button", { name: "Lanes" }));
    assert.ok(screen.getByText("Loading lanes…"));
    snapshotState = "error";
    release!();
    await screen.findByText(/Could not load lanes/);
    snapshotState = "empty";
    await user.click(screen.getByRole("menuitem", { name: "Retry lanes" }));
    await screen.findByText("No lanes yet.");
    assert.ok(screen.getByRole("menuitem", { name: "Manage lanes" }));
    assert.equal(slot.inspection.rpcCalls.some(c => c.method === "lane" || c.method === "mutate"), false);
  } finally {
    slot.lifecycle.unmount();
    dom.window.close();
  }
});
