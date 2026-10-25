// Manual acceptance fixture. Bind only loopback, ephemeral port; all content synthetic.
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { task } from "./fixtures.ts";
const items = [
  task({
    id: "preview-a",
    key: "DEMO-1",
    title: "Synthetic first board task",
    labelIds: ["lane-label-a"],
  }),
  task({
    id: "preview-b",
    key: "OTHER-1",
    projectId: "other",
    title: "Synthetic cross-board task",
    status: "in_progress",
    labelIds: ["lane-label-b"],
  }),
  task({ id: "preview-c", key: "DEMO-2", title: "Synthetic unassigned task" }),
];
const labels = [
  {
    id: "lane-label-a",
    projectId: items[0]!.projectId,
    name: "lane: synthetic",
    color: "blue",
  },
  {
    id: "lane-label-b",
    projectId: "other",
    name: "lane: synthetic",
    color: "blue",
  },
];
const { bb, harness } = createFakePluginHost({
  sdk: {
    plugins: {
      callRpc: async ({ method, input }: any) => {
        if (method === "getTask")
          return { task: items.find((t) => t.id === input.taskId) ?? null };
        if (method === "listProjects")
          return { projects: [{ id: items[0]!.projectId }, { id: "other" }] };
        if (method === "listLabels")
          return {
            labels: labels.filter((l) => l.projectId === input.projectId),
          };
        if (method === "listTasks")
          return {
            tasks: items.filter(
              (t) => !input.projectId || t.projectId === input.projectId,
            ),
            nextCursor: null,
          };
        throw new Error("Unsupported fixture RPC " + method);
      },
    },
    threads: {
      get: async ({ threadId }: any) =>
        makeThreadResponse({
          id: threadId,
          title: "Synthetic coordinator",
          archivedAt: threadId === "archived" ? 123 : null,
        }),
    },
  },
});
plugin(bb);
const created: any = await harness.behavior.callRpc("lane", {
  op: "create",
  name: "Synthetic cross-board goal",
  goal: "Verify lane behavior",
  ownerThreadId: "operator",
});
await harness.behavior.callRpc("lane", {
  op: "assign",
  taskId: "preview-a",
  laneId: created.lane.id,
  expectedRevision: 0,
});
await harness.behavior.callRpc("lane", {
  op: "assign",
  taskId: "preview-b",
  laneId: created.lane.id,
  expectedRevision: 0,
});
await build({
  entryPoints: ["test/preview.tsx"],
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile: ".superpowers/sdd/2026-10-25-first-class-lanes/preview.js",
  define: { "process.env.NODE_ENV": '"development"' },
  alias: { "@": "." },
});
const counts = {
  backlog: 0,
  todo: 2,
  in_progress: 1,
  in_review: 0,
  done: 0,
  canceled: 0,
};
const snapshot = {
  version: 1,
  rows: items.map((t) => ({
    ...t,
    rev: 1,
    live:
      t.id === "preview-b"
        ? [
            {
              threadId: "worker",
              title: "Synthetic worker",
              liveStatus: "working",
            },
          ]
        : [],
  })),
  projects: [],
  labels,
  counts,
  complete: true,
};
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic lanes acceptance</title><style>@layer theme,base,components,utilities;</style><link rel="stylesheet" href="/style.css"><style>@layer base{*{box-sizing:border-box;border:0 solid}button,input,textarea,select{font:inherit;color:inherit}button{background:transparent}ul{list-style:none;margin:0;padding:0}p,h2{margin:0}}:root{--background:#fff;--foreground:#171717;--card:#fff;--muted-foreground:#626262;--border:#ddd;--input:#ccc;--ring:#999;--state-hover:#eee;--state-active:#e5e5e5;--destructive:#c22}html,body,#root{height:100%;margin:0}body{font:14px system-ui}#root{display:flex;flex-direction:column}body>div{height:100%}</style></head><body data-bb-plugin-root><script type="module" src="/preview.js"></script></body></html>`;
const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw);
      const method = req.url!.split("/").at(-1)!;
      const data =
        method === "snapshot"
          ? { ...snapshot, rows: input.part === "closed" ? [] : snapshot.rows }
          : method === "changes"
            ? { changes: { from: 1, to: 1, upserts: [], removes: [] } }
            : method === "detail"
              ? {
                  detail: {
                    task: {
                      ...items[0],
                      description: "Synthetic fixture only",
                    },
                    threads: [],
                    comments: [],
                    subtasks: [],
                  },
                }
              : method === "search"
                ? { ids: [], truncated: false }
                : await harness.behavior.callRpc(method, input);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          req.url!.includes("/api/") ? { ok: true, result: data } : data,
        ),
      );
      return;
    }
    if (req.url === "/preview.js") {
      res.setHeader("content-type", "text/javascript");
      res.end(
        readFileSync(
          ".superpowers/sdd/2026-10-25-first-class-lanes/preview.js",
        ),
      );
      return;
    }
    if (req.url === "/style.css") {
      res.setHeader("content-type", "text/css");
      res.end(readFileSync("dist/app.css"));
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(html);
  } catch (e) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: String(e) }));
  }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address() as { port: number };
  const info = { port: address.port, pid: process.pid };
  writeFileSync(
    process.env.BB_THREAD_STORAGE + "/lanes-preview.json",
    JSON.stringify(info),
  );
  console.log(JSON.stringify(info));
});
process.on("SIGTERM", () =>
  server.close(async () => {
    await harness.lifecycle.dispose();
    process.exit(0);
  }),
);
