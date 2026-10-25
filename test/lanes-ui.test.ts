// Synthetic frontend acceptance uses the SDK renderer and real plugin-owned SQLite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { task } from "./fixtures.ts";
test("people create, rename, park, archive and restore a lane through accessible controls", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });
  for (const key of [
    "window",
    "document",
    "HTMLElement",
    "Element",
    "Node",
    "MutationObserver",
    "Event",
    "CustomEvent",
    "KeyboardEvent",
    "MouseEvent",
    "getComputedStyle",
    "localStorage",
    "HTMLInputElement",
    "HTMLSelectElement",
    "DocumentFragment",
    "NodeFilter",
  ]) {
    Object.defineProperty(globalThis, key, {
      value: (dom.window as any)[key],
      configurable: true,
      writable: true,
    });
  }
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    value: (fn: () => void) => setTimeout(fn, 0),
    configurable: true,
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    value: clearTimeout,
    configurable: true,
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    value: class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
    configurable: true,
  });
  dom.window.matchMedia = () =>
    ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }) as any;
  globalThis.fetch = async () => {
    throw new Error("No live data in synthetic acceptance");
  };
  const { createFakePluginHost } = await import("@get-bb/plugin-sdk/testing");
  const { loadPluginApp, renderSlot } =
    await import("@get-bb/plugin-sdk/testing/app");
  const { default: plugin } = await import("../server.ts");
  const { harness, bb } = createFakePluginHost();
  plugin(bb);
  const row = { ...task({ id: "demo" }), rev: 1, live: [] };
  const coreSnapshot = {
    version: 1,
    rows: [row],
    projects: [],
    labels: [],
    counts: {
      todo: 1,
      backlog: 0,
      in_progress: 0,
      in_review: 0,
      done: 0,
      canceled: 0,
    },
    complete: true,
  };
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        snapshot: () => coreSnapshot,
        changes: () => ({
          changes: { from: 1, to: 1, upserts: [], removes: [] },
        }),
        lane: (input: unknown) => harness.behavior.callRpc("lane", input),
        laneSnapshot: () => harness.behavior.callRpc("laneSnapshot", null),
        laneChanges: (input: unknown) =>
          harness.behavior.callRpc("laneChanges", input),
      },
    },
  );
  const { default: userEvent } = await import("@testing-library/user-event");
  const { screen, waitFor } = await import("@testing-library/react");
  const user = userEvent.setup({ document: dom.window.document });
  await user.click(await slot.findByRole("button", { name: "Lanes" }));
  await user.click(screen.getByRole("button", { name: "New lane" }));
  await user.type(screen.getByLabelText("Lane name"), "Synthetic goal");
  await user.type(screen.getByLabelText("Goal"), "Ship useful work");
  await user.click(screen.getByRole("button", { name: "Create lane" }));
  await waitFor(() =>
    assert.ok(screen.getByRole("button", { name: "Edit lane Synthetic goal" })),
  );
  await user.click(
    screen.getByRole("button", { name: "Edit lane Synthetic goal" }),
  );
  await user.clear(screen.getByLabelText("Lane name"));
  await user.type(screen.getByLabelText("Lane name"), "Renamed goal");
  await user.click(screen.getByRole("button", { name: "Save lane" }));
  await waitFor(() =>
    assert.ok(screen.getByRole("button", { name: "Edit lane Renamed goal" })),
  );
  const saved: any = await harness.behavior.callRpc("lane", { op: "list" });
  const changedLane = saved.lanes[0];
  await harness.behavior.callRpc("lane", {
    op: "update",
    id: changedLane.id,
    expectedRevision: changedLane.revision,
    patch: { goal: "External goal" },
  });
  await user.click(screen.getByRole("button", { name: "Save lane" }));
  await waitFor(() =>
    assert.match(
      screen.getByRole("alert").textContent ?? "",
      /another session/,
    ),
  );
  await user.click(screen.getByRole("button", { name: "Reload lane" }));
  assert.equal(
    (screen.getByLabelText("Goal") as HTMLTextAreaElement).value,
    "External goal",
  );
  await user.click(screen.getByRole("button", { name: "Park lane" }));
  await waitFor(() =>
    assert.match(
      screen.getByLabelText("Lane lifecycle").textContent ?? "",
      /parked/,
    ),
  );
  await user.click(screen.getByRole("button", { name: /Archive lane/ }));
  await waitFor(() =>
    assert.match(
      screen.getByLabelText("Lane lifecycle").textContent ?? "",
      /archived/,
    ),
  );
  await user.click(screen.getByRole("button", { name: "Restore lane" }));
  await waitFor(() =>
    assert.match(
      screen.getByLabelText("Lane lifecycle").textContent ?? "",
      /active/,
    ),
  );
  assert.equal(row.status, "todo");
  assert.equal(
    slot.inspection.rpcCalls.filter((c) => c.method === "snapshot").length,
    2,
  );
  slot.lifecycle.unmount();
  await harness.lifecycle.dispose();
  dom.window.close();
});
