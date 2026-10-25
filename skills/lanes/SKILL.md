---
name: lanes
description: Use when organizing cross-project goals in Better Tasks, assigning stable task IDs to lanes, changing lane lifecycle or operators, or importing selected legacy lane labels.
---

Use the namespaced command `bb better-tasks lane`. Core `bb tasks` still owns tasks, labels, statuses, and attached workers. A lane changes organizational metadata only; it never orchestrates threads.

1. Read lanes with `lane list --input '{"limit":100}'`. Follow `nextCursor` using `cursor`; limit is 1–500. Filter lifecycle with `state`.
2. Read a lane with `lane get --input '{"id":"LANE_ID","limit":100}'`. It returns the lane revision, owner availability, and paginated memberships by stable core task ID. Follow membership `nextCursor`.
3. Write with the observed revision. A conflict returns `current` and exits nonzero. Read again and review changes before retrying.
4. Import labels only through an explicit preview and reviewed apply. Never infer membership from label names or run an automatic migration.

Examples (replace IDs and revisions):

```sh
bb better-tasks lane create --input '{"name":"Credential release","goal":"Deliver the agreed release","ownerThreadId":null}'
bb better-tasks lane update --input '{"id":"LANE_ID","expectedRevision":1,"patch":{"goal":"Updated goal","ownerThreadId":"THREAD_ID"}}'
bb better-tasks lane assign --input '{"taskId":"STABLE_TASK_ID","laneId":"LANE_ID","expectedRevision":0}'
bb better-tasks lane unassign --input '{"taskId":"STABLE_TASK_ID","expectedRevision":1}'
bb better-tasks lane archive --input '{"id":"LANE_ID","expectedRevision":2}'
bb better-tasks lane restore --input '{"id":"LANE_ID","expectedRevision":3}'
bb better-tasks lane owner --input '{"threadId":"THREAD_ID"}'
```

Parking uses `update` with `patch:{"state":"parked"}`. Archiving preserves memberships and unfinished tasks; restore before new assignment. Restore returns the lane to active. Owner IDs survive archived, missing, or unavailable threads; no automatic replacement occurs.

Assignment revisions belong to each task's membership, not the lane or core task. Missing membership starts at revision 0. Unassignment retains a tombstone revision. Read the current membership or tombstone with `lane membership --input '{"taskId":"STABLE_TASK_ID"}'` before reassigning. The typed `laneSnapshot` RPC also includes tombstones.

Explicit legacy import:

```sh
bb better-tasks lane import preview --input '{"mapping":[{"projectId":"PROJECT_ID","labelId":"LABEL_ID","laneId":"LANE_ID"}]}'
bb better-tasks lane import apply --input '{"previewId":"REVIEW_ID","resolutions":[{"taskId":"STABLE_TASK_ID","laneId":"CHOSEN_LANE_ID"}]}'
```

Create destination lanes first. Map each project/label ID explicitly, even when several labels have the same name. Preview supports 20 selected labels, 500 affected tasks, and a bounded scan of 50,000 tasks. Every ambiguous or conflicting existing membership needs a resolution. A null resolution skips that task and preserves its current membership.

Apply rejects changed source labels, task identity/labels, lane revisions, or memberships. Preview expires after 24 hours. After a lost response, retry the exact preview ID and resolutions: its durable receipt returns the previous result before reading sources or replaying writes. Changing resolutions for a committed receipt fails.

No continuous label inference or dual-write follows import. Existing `marco tasks --lane` still edits labels; adopting this API there is separate work. Lane data lives in this plugin's supported SQLite storage; back it up consistently before uninstall or migration. Never access the core Tasks database.
