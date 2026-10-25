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

## Coherent observation and attributable transfer

Use `observe` for one stable task and at most two lane rows from one local SQLite transaction:

```sh
bb better-tasks lane observe --input '{"taskId":"STABLE_TASK_ID","destinationLaneId":"DESTINATION_ID"}'
```

`destinationLaneId` is required; null requests no destination. The reply contains `schemaVersion:1`, `taskId`, local `version`, `membership`, `source`, and `destination`. A lane reference is `none`, `missing` with an ID, or `present` with the lane. Only an absent membership SQL row becomes revision 0 with null lane and empty timestamp. A stored tombstone keeps its positive revision. Corrupt rows fail with `invalid_observation`; read failures never mean unassigned.

For a reviewed transfer, persist a caller-generated UUID and the complete request in a private journal **before** sending. Bind the observed membership revision/source ID and both exact lane revisions, states, and required nullable owner references. Use null bindings exactly for null source/destination IDs. Same-lane bindings must agree.

```sh
bb better-tasks lane transfer --input '{"operationId":"11111111-1111-4111-8111-111111111111","taskId":"STABLE_TASK_ID","laneId":"DESTINATION_ID","expected":{"membershipRevision":3,"fromLaneId":"SOURCE_ID","source":{"id":"SOURCE_ID","revision":4,"state":"active","ownerThreadId":"SOURCE_OWNER"},"destination":{"id":"DESTINATION_ID","revision":7,"state":"active","ownerThreadId":"DESTINATION_OWNER"}}}'
bb better-tasks lane operation --input '{"operationId":"11111111-1111-4111-8111-111111111111"}'
```

Transfer replies contain an immutable receipt with `request`, `before`, `after`, `committedAt`, and outcome `applied`, `unchanged`, or `conflict`. Applied/unchanged exit 0; conflict exits 1 **with receipt JSON on stdout**. Parse that JSON even on nonzero exit. Conflicts compare membership, source, destination, then archived-destination policy. They preserve the coherent observation and make no membership change. Real moves to parked or ownerless lanes are valid metadata; moves to archived destinations conflict. Removal from archived sources is allowed. Validated same-lane and null-to-null requests are unchanged and preserve revisions, including archived same-lane membership and absent/tombstone null memberships.

After a lost reply, look up the same operation ID. Found returns its historical receipt; compare its complete request with the journal. `not_found` means no receipt at that read; an in-flight request may still commit. Retry only the **same ID and exact request**, including expected bindings. A used ID with different intent fails `operation_id_reused`. Unavailable or corrupt lookup is unknown, never not_found. Do not infer attribution from current lane/revision, compensate, reset the journal, refresh bindings silently, or use a new ID to hide uncertainty. Reconcile the previous outcome before reviewing new intent. Conflict and unchanged receipts are retained too. Receipts have no expiry in V1 and survive event-feed compaction.

Observe, lookup, replay, unchanged, and conflict never publish lane invalidations. A changed transfer publishes after membership/event/receipt commit; publication failure can leave a committed result, recoverable by ID. Missing/unknown task preflight, corrupt storage, busy databases and transport errors create no terminal receipt. Explicit null unassignment skips task existence checks. Lane versions order local metadata only.

These operations cover plugin-local rows and owner references. They grant no permission, reservation, worker admission, or cross-store atomicity. Separately check live BB owner availability, ancestry, scope, and authority. BB archive/unarchive ABA has no authoritative generation here and cannot be detected from equal rereads or lane revisions. Legacy assign/unassign/import/UI keep their existing shapes and guarantees; they do not create transfer receipts or honor reservations. Receipt replay is historical and does not verify current membership. Restored/replaced databases can lose local history. Process-crash recovery does not establish power-loss durability; that needs a verified SQLite/storage policy. No automatic caller migration is included.
