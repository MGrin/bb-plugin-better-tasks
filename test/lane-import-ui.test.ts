import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { task } from "./fixtures.ts";

function setupDom() {
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
    "sessionStorage",
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

  return dom;
}

test("zero-lane import creates explicit destinations and preserves reviewed import", async () => {
  const dom = setupDom();
  const { createFakePluginHost } = await import("@get-bb/plugin-sdk/testing");
  const { loadPluginApp, renderSlot } = await import(
    "@get-bb/plugin-sdk/testing/app"
  );
  const { default: plugin } = await import("../server.ts");
  const labels = [
    { id: "label-a", projectId: "a", name: "lane: shared", color: "blue" },
    { id: "label-b", projectId: "b", name: "lane: shared", color: "blue" },
    { id: "label-c", projectId: "a", name: "lane: uncertain", color: "blue" },
  ];
  const tasks = [
    task({ id: "task-a", projectId: "a", labelIds: ["label-a"] }),
    task({ id: "task-b", projectId: "b", labelIds: ["label-b"] }),
  ];
  const original = JSON.stringify({ tasks, labels });
  const projects = [
    { id: "a", name: "Board A", prefix: "A", color: "blue" },
    { id: "b", name: "Board B", prefix: "B", color: "blue" },
  ];
  const { bb, harness } = createFakePluginHost({
    sdk: {
      plugins: {
        callRpc: async ({ method, input }: any) => {
          if (method === "listLabels")
            return {
              labels: labels.filter((l) => l.projectId === input.projectId),
            };
          if (method === "listTasks")
            return {
              tasks: tasks.filter((t) => t.projectId === input.projectId),
              nextCursor: null,
            };
          if (method === "listProjects") return { projects };
          throw new Error("Unexpected source RPC " + method);
        },
      },
    },
  });
  plugin(bb);
  let createCalls = 0;
  let holdCreate: (() => void) | undefined;
  let loseResponse = false;
  let snapshotOffline = false;
  let loseApply = false;
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        snapshot: () => ({
          version: 1,
          rows: tasks.map((t) => ({ ...t, rev: 1, live: [] })),
          labels,
          projects,
          counts: {
            todo: 2,
            backlog: 0,
            in_progress: 0,
            in_review: 0,
            done: 0,
            canceled: 0,
          },
          complete: true,
        }),
        changes: () => ({
          changes: { from: 1, to: 1, upserts: [], removes: [] },
        }),
        laneSnapshot: () => {
          if (snapshotOffline) throw new Error("Snapshot offline");
          return harness.behavior.callRpc("laneSnapshot", null);
        },
        laneChanges: (input: unknown) =>
          harness.behavior.callRpc("laneChanges", input),
        laneImportPreview: (input: unknown) =>
          harness.behavior.callRpc("laneImportPreview", input),
        laneImportApply: async (input: unknown) => {
          const receipt = await harness.behavior.callRpc(
            "laneImportApply",
            input,
          );
          if (loseApply) throw new Error("Apply response lost");
          return receipt;
        },
        lane: async (input: any) => {
          if (input.op === "create") {
            createCalls++;
            await new Promise<void>((resolve) => {
              holdCreate = resolve;
            });
            const result = await harness.behavior.callRpc("lane", input);
            if (loseResponse) throw new Error("Response lost");
            return result;
          }
          return harness.behavior.callRpc("lane", input);
        },
      },
    },
  );
  const { default: userEvent } = await import("@testing-library/user-event");
  const { screen, within, waitFor, act } = await import(
    "@testing-library/react"
  );
  const user = userEvent.setup({ document: dom.window.document });
  try {
    await user.click(await slot.findByRole("button", { name: "Lanes" }));
    await screen.findByText("No lanes yet.");
    await user.click(
      screen.getByRole("button", { name: "Import lanes from labels" }),
    );
    const a = within(
      screen.getByRole("group", { name: "Board A · lane: shared" }),
    );
    const b = within(
      screen.getByRole("group", { name: "Board B · lane: shared" }),
    );
    assert.equal(
      (
        screen.getByRole("button", {
          name: "Preview import",
        }) as HTMLButtonElement
      ).disabled,
      true,
    );
    await user.selectOptions(a.getByRole("combobox"), "__create__");
    assert.equal((a.getByRole("textbox") as HTMLInputElement).value, "shared");
    await user.dblClick(a.getByRole("button", { name: "Create lane" }));
    await waitFor(() => assert.equal(createCalls, 1));
    assert.equal(
      (a.getByRole("button", { name: "Creating lane…" }) as HTMLButtonElement)
        .disabled,
      true,
    );
    await act(async () => holdCreate!());
    await waitFor(() =>
      assert.notEqual(
        (a.getByRole("combobox") as HTMLSelectElement).value,
        "__create__",
      ),
    );
    const aId = (a.getByRole("combobox") as HTMLSelectElement).value;
    assert.ok(aId);
    assert.equal((b.getByRole("combobox") as HTMLSelectElement).value, "");
    await user.selectOptions(b.getByRole("combobox"), "__create__");
    await user.click(b.getByRole("button", { name: "Create lane" }));
    await waitFor(() => assert.equal(createCalls, 2));
    await act(async () => holdCreate!());
    await waitFor(() =>
      assert.notEqual(
        (b.getByRole("combobox") as HTMLSelectElement).value,
        "__create__",
      ),
    );
    const bId = (b.getByRole("combobox") as HTMLSelectElement).value;
    assert.notEqual(aId, bId);
    const before: any = await harness.behavior.callRpc("laneSnapshot", null);
    assert.equal(before.memberships.length, 0);
    assert.ok(before.lanes.every((l: any) => l.ownerThreadId === null));
    await user.click(screen.getByRole("button", { name: "Preview import" }));
    await screen.findByText(/2 affected tasks/);
    const previewCall = slot.inspection.rpcCalls.find(
      (c) => c.method === "laneImportPreview",
    );
    assert.deepEqual((previewCall?.input as any).mapping, [
      { projectId: "a", labelId: "label-a", laneId: aId },
      { projectId: "b", labelId: "label-b", laneId: bId },
    ]);
    await user.click(
      screen.getByRole("button", { name: "Apply reviewed import" }),
    );
    await screen.findByText(/2 assigned · 0 kept/);
    const after: any = await harness.behavior.callRpc("laneSnapshot", null);
    assert.equal(
      after.memberships.find((m: any) => m.taskId === "task-a").laneId,
      aId,
    );
    assert.equal(
      after.memberships.find((m: any) => m.taskId === "task-b").laneId,
      bId,
    );
    assert.equal(JSON.stringify({ tasks, labels }), original);
    // A subsequent conflicting mapping still requires a decision. A lost apply
    // response retries the exact reviewed preview and choices through its receipt.
    await user.selectOptions(a.getByRole("combobox"), bId);
    await user.click(screen.getByRole("button", { name: "Preview import" }));
    await screen.findByText(/2 affected tasks · 1 conflicts/);
    assert.equal(
      (
        screen.getByRole("button", {
          name: "Apply reviewed import",
        }) as HTMLButtonElement
      ).disabled,
      true,
    );
    await user.selectOptions(
      screen.getByLabelText("Resolve " + tasks[0]!.key),
      "skip",
    );
    loseApply = true;
    await user.click(
      screen.getByRole("button", { name: "Apply reviewed import" }),
    );
    await waitFor(() =>
      assert.match(
        screen.getByRole("alert").textContent ?? "",
        /Retry the same preview/,
      ),
    );
    loseApply = false;
    await user.dblClick(
      screen.getByRole("button", { name: "Apply reviewed import" }),
    );
    await screen.findByText(/0 assigned · 2 kept/);
    const applies = slot.inspection.rpcCalls.filter(
      (c) => c.method === "laneImportApply",
    );
    assert.deepEqual(applies.at(-1)?.input, applies.at(-2)?.input);
    const kept: any = await harness.behavior.callRpc("laneSnapshot", null);
    assert.deepEqual(kept.memberships, after.memberships);
    assert.equal(JSON.stringify({ tasks, labels }), original);
    const c = within(
      screen.getByRole("group", { name: "Board A · lane: uncertain" }),
    );
    await user.selectOptions(c.getByRole("combobox"), "__create__");
    loseResponse = true;
    await user.click(c.getByRole("button", { name: "Create lane" }));
    await waitFor(() => assert.equal(createCalls, 3));
    snapshotOffline = true;
    await act(async () => holdCreate!());
    await waitFor(() =>
      assert.match(
        screen.getByRole("alert").textContent ?? "",
        /Creation could not be confirmed/,
      ),
    );
    await user.click(screen.getByRole("button", { name: "Manage lanes" }));
    await user.click(
      screen.getByRole("button", { name: "Import lane labels" }),
    );
    const reopened = within(
      screen.getByRole("group", { name: "Board A · lane: uncertain" }),
    );
    assert.equal(reopened.queryByRole("button", { name: "Create lane" }), null);
    assert.equal(
      reopened.queryByRole("option", { name: "Create a new lane…" }),
      null,
    );
    snapshotOffline = false;
    await user.click(screen.getByRole("button", { name: "Check lanes again" }));
    await waitFor(() =>
      assert.ok(reopened.getByRole("option", { name: "uncertain" })),
    );
    const recovered: any = await harness.behavior.callRpc("laneSnapshot", null);
    const recoveredId = recovered.lanes.find(
      (l: any) => l.name === "uncertain",
    ).id;
    assert.equal(
      (reopened.getByRole("combobox") as HTMLSelectElement).value,
      "",
    );
    await user.selectOptions(reopened.getByRole("combobox"), recoveredId);
    assert.equal(createCalls, 3);
  } finally {
    slot.lifecycle.unmount();
    await harness.lifecycle.dispose();
    dom.window.close();
  }
});

test("import distinguishes loading and empty labels and reconciles without replaying create", async () => {
  const dom = setupDom();
  const { createElement } = await import("react");
  const { render, within, waitFor } = await import("@testing-library/react");
  const { default: userEvent } = await import("@testing-library/user-event");
  const { LaneImport } = await import("../components/lane-import.tsx");
  const { LaneClient } = await import("../lib/lanes/client.ts");
  const store = new LaneClient();
  store.snapshot({ version: 0, lanes: [], memberships: [] });
  let creates = 0;
  let offline = false;
  let unknown = false;
  const lane = {
    id: "acknowledged",
    name: "goal",
    goal: "",
    state: "active" as const,
    ownerThreadId: null,
    revision: 1,
    createdAt: "",
    updatedAt: "",
  };
  const controller = {
    store,
    revision: 0,
    error: null,
    refresh: async () => {
      throw new Error("Refresh offline");
    },
    mutate: async () => {
      throw new Error("Create must not conflate acknowledgement and refresh");
    },
    rpc: {
      call: async (method: string) => {
        if (method === "lane") {
          creates++;
          if (unknown)
            throw new Error("Connection failed before acknowledgement");
          return { kind: "create", lane };
        }
        if (method === "laneSnapshot") {
          if (offline) throw new Error("Offline");
          return { version: 0, lanes: [], memberships: [] };
        }
        throw new Error("Unexpected method " + method);
      },
    },
  } as unknown as import("../components/use-lanes.ts").LanesController;
  const labels = [
    { id: "source", projectId: "project", name: "lane: goal", color: "blue" },
  ];
  const projects = [
    { id: "project", name: "Board", prefix: "BOARD", color: "blue" },
  ];
  const props = {
    controller,
    labels: [] as typeof labels,
    projects,
    sourcesLoading: true,
  };
  const view = render(createElement(LaneImport, props));
  const q = within(view.container);
  const user = userEvent.setup({ document: dom.window.document });
  try {
    assert.ok(q.getByText("Loading lanes and lane labels…"));
    assert.equal(q.queryByText(/No lane labels found/), null);
    view.rerender(
      createElement(LaneImport, { ...props, sourcesLoading: false }),
    );
    assert.ok(q.getByText(/No lane labels found/));
    assert.equal(q.queryByText(/Loading lanes/), null);
    view.rerender(
      createElement(LaneImport, { ...props, labels, sourcesLoading: true }),
    );
    assert.equal((q.getByRole("combobox") as HTMLSelectElement).disabled, true);
    view.rerender(
      createElement(LaneImport, { ...props, labels, sourcesLoading: false }),
    );
    await user.selectOptions(q.getByRole("combobox"), "__create__");
    await user.clear(q.getByRole("textbox"));
    assert.equal(
      (q.getByRole("button", { name: "Create lane" }) as HTMLButtonElement)
        .disabled,
      true,
    );
    await user.type(q.getByRole("textbox"), "goal");
    await user.click(q.getByRole("button", { name: "Create lane" }));
    await waitFor(() =>
      assert.match(q.getByRole("alert").textContent ?? "", /Lane created/),
    );
    assert.equal((q.getByRole("combobox") as HTMLSelectElement).value, lane.id);
    assert.equal(
      (q.getByRole("button", { name: "Preview import" }) as HTMLButtonElement)
        .disabled,
      false,
    );
    assert.equal(creates, 1);
    // A successful acknowledgement is usable even if the following read fails.
    assert.equal(
      sessionStorage.getItem("better-tasks:lane-import-pending:v1"),
      "{}",
    );
    view.unmount();
    unknown = true;
    const second = render(
      createElement(LaneImport, { controller, labels, projects }),
    );
    const r = within(second.container);
    await user.selectOptions(r.getByRole("combobox"), "__create__");
    await user.click(r.getByRole("button", { name: "Create lane" }));
    await waitFor(() =>
      assert.match(
        r.getByRole("alert").textContent ?? "",
        /Creation could not be confirmed/,
      ),
    );
    offline = true;
    await user.click(r.getByRole("button", { name: "Check lanes again" }));
    await waitFor(() =>
      assert.match(
        r.getByRole("alert").textContent ?? "",
        /Could not check lanes/,
      ),
    );
    second.unmount();
    const third = render(
      createElement(LaneImport, { controller, labels, projects }),
    );
    const t = within(third.container);
    offline = false;
    await user.click(t.getByRole("button", { name: "Check lanes again" }));
    await waitFor(() =>
      assert.equal(
        (
          t.getByRole("button", {
            name: "Check lanes again",
          }) as HTMLButtonElement
        ).disabled,
        false,
      ),
    );
    assert.equal(t.queryByRole("option", { name: "Create a new lane…" }), null);
    assert.equal(creates, 2); // Even an empty authoritative read cannot prove an unknown write won't finish later.
    third.unmount();
    sessionStorage.setItem("better-tasks:lane-import-pending:v1", "corrupt");
    const fourth = render(
      createElement(LaneImport, { controller, labels, projects }),
    );
    const f = within(fourth.container);
    assert.match(f.getByRole("alert").textContent ?? "", /Cannot read pending/);
    assert.equal(f.queryByRole("option", { name: "Create a new lane…" }), null);
    fourth.unmount();
  } finally {
    view.unmount();
    dom.window.close();
  }
});
