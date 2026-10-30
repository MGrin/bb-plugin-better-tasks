---
name: release
description: Use when reading or recording a task's release stage in Better Tasks (merged-dev, nominated, boarded, go, live, verified), or when building release-train tooling that tracks tasks to production.
---

Use `bb better-tasks release`. The release stage says where a task's merged change is on its way to production. It is separate from the task status: the lane owns the status, train tooling owns the stage. A stage write never changes the status, and a status change never changes the stage.

Stages, in order: `merged-dev`, `nominated`, `boarded`, `go`, `live`, `verified`. `boarded`, `go`, `live` and `verified` carry a `train` ID (no spaces); `merged-dev` and `nominated` carry `train: null`.

## Reading (anyone)

```sh
bb better-tasks release get --input '{"taskId":"STABLE_TASK_ID"}'
bb better-tasks release list --input '{"train":"TRAIN_ID","stage":"live","limit":100}'
bb better-tasks release history --input '{"taskId":"STABLE_TASK_ID"}'
bb better-tasks release operation --input '{"operationId":"UUID"}'
```

`get` returns `record: null` when no stage is recorded. `list` pages by task ID; follow `nextCursor`. `history` lists applied writes, newest first. The typed `release` RPC accepts the same read operations and nothing else.

## Writing (train tooling only)

Only train tooling writes, with `writer: "marco-train"`. Lanes, workers and people never set a stage by hand. The writer field is an audit guardrail, not a credential; every write also records the calling thread.

```sh
bb better-tasks release set --input '{"operationId":"UUID","taskId":"STABLE_TASK_ID","stage":"boarded","train":"TRAIN_ID","expectedRevision":2,"writer":"marco-train","evidence":"train TRAIN_ID built at SHA"}'
```

1. Read the current record; `expectedRevision` is its `revision`, or 0 when none.
2. Persist a fresh UUID with the request before sending. After a lost reply, retry the same ID and exact request, or look it up with `release operation`.
3. Outcome `applied` or `unchanged` exits 0. `conflict` exits 1 with the receipt JSON on stdout; read `receipt.reason`.

Rules, checked in one SQLite transaction:

- `revision_changed`: someone wrote since your read. Read again.
- `not_boarded`: `go`, `live` or `verified` need the task boarded on a train first.
- `train_mismatch`: `go`, `live` and `verified` stay on the boarded train. Board again to switch trains.
- `stage_skipped`: train stages advance one step at a time: boarded, go, live, verified.
- `evidence_required`: stepping back (dropped, rebuilt, rolled back) needs non-empty `evidence`.

`boarded` may start or restart a train from any stage. A stage is never deleted; step back to `nominated` or `merged-dev` with evidence instead. Closing the task (`done`) after `live` plus passing post-deploy checks is the train tooling's separate status write through the board's own workflow.
