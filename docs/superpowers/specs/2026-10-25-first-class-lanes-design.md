# First-class lanes in Better Tasks

Approved implementation defaults for MGrin/bb-plugin-better-tasks, inspected at a344bf7. Requested by Nikita on 2026-10-25. Repository invitation accepted; write access verified. Nikita explicitly opted out of design questions. These defaults govern implementation; this document is not a deployment receipt.

## Intended result

A lane becomes a durable unit of work in the plugin, alongside projects and labels. It expresses a goal, identifies its coordinating operator, groups tasks across boards, and records whether the lane is active, parked, or archived. Changing an operator or closing its thread does not destroy the lane. Labels remain independent tags.

Opening a lane shows its goal, owner thread, lifecycle, task counts by status, and member tasks in the existing list or board view. Working-now indicators remain derived from actual attached task-thread activity; an active lane is not proof that a worker is running.

## Authorized product defaults

I selected these defaults under Nikita’s request to implement lanes and skip design questions:

- Each task belongs to zero or one lane. A lane can span several task boards.
- A lane has one optional coordinating operator thread. Its tasks can still have multiple workers attached through core Tasks.
- Lane lifecycle is active, parked, or archived. Parking and archiving preserve membership and unfinished tasks. Restoring a lane is explicit.
- These operations change organizational metadata only. They do not start/stop/archive threads, change task status, trigger provider handover, grant authority, or enforce a universal five-lane cap.
- An archived lane remains viewable as history; new assignments to it require restoring it first. Existing memberships remain visible.

## Data ownership

Core Tasks remains the sole authority for tasks, statuses, projects, labels, comments, and task-thread attachments. Better Tasks stores only its new lane records and membership metadata in its own supported plugin SQLite database using bb.storage.database() and append-only migrations. It never reads or writes the core Tasks database directly.

Lane record: stable id, name, goal/description, state, nullable ownerThreadId, revision, createdAt, updatedAt. Membership record: stable core task ID, lane ID, revision, timestamps. A membership uses task IDs rather than movable keys or titles. Mutations retain sufficient audit metadata to identify changes; actor identity comes from the trusted request context where available, not invented attribution.

All mutating requests validate typed inputs and require the observed revision for updates. A conflict returns current state for review, with no blind overwrite. Membership replacement and its change record are transactional. Names do not define identity. A duplicate name is allowed only where the UI still distinguishes IDs/goals; import never merges by name automatically.

Unknown, missing, and archived owner threads are displayed explicitly. They never cause automatic reassignment. Absence from a partially loaded task cache is not proof of task deletion; membership is removed only after confirmed deletion or explicit unassignment.

## User interface

1. Lanes overview/navigation: active and parked groups, archived history, search, create/edit, goal, owner link, status counts, working-now indication.
2. Lane detail: editable metadata and the existing virtualized task list/board scoped to the lane, including cross-project tasks.
3. Task detail and filters: a distinct Lane picker and lane/no-lane filtering alongside existing project, label, status, and priority filters. Label behavior remains unchanged.
4. Lifecycle actions: park, archive, restore. The UI states that task statuses and running threads are unaffected; open-task counts remain visible when archiving.

Use the existing React/TypeScript structure, vendored controls, keyboard conventions, responsive layouts, and virtualization. No new frontend framework is needed.

## Agent and API contract

Expose typed plugin RPC plus a namespaced `bb better-tasks lane` CLI and plugin skill: list/get/create/update, archive/restore, assign/unassign tasks, owner replacement. Read outputs are bounded and paginated where necessary. Return revisions and stable IDs for safe subsequent changes. Do not shadow core `bb tasks` commands.

The CLI and UI share the same validation and mutation paths. No direct database interface is exposed to agents. Plugin backend implementation remains TypeScript, matching the existing repository and BB plugin runtime.

## Existing lane labels

Provide a previewed import from explicitly selected `lane:` labels. Show source project, label ID, proposed lane, affected tasks, existing membership, and conflicting multiple labels. Users can map labels from several boards to one lane when they represent the same goal. Same-name labels alone do not prove shared ownership.

Import is idempotent for its reviewed mapping and detects changes before applying. Ambiguous membership needs an explicit choice. It leaves original labels, task statuses, and attachments untouched. After import there is no continuous inference or dual-write between labels and lanes.

Our existing `marco tasks --lane` automation still edits labels. Adopting the new plugin API in that tooling is a separate integration change after the plugin contract is verified. No silent live migration is included in the plugin PR.

## Performance and recovery

Retain compact task rows and per-task deltas. Lane metadata and memberships use their own version/change stream, with bounded delta history and a full lane snapshot when a client falls behind. Lane-only changes must not trigger a full Tasks RPC reload. Apply versions monotonically and tolerate out-of-order or duplicate events. Restart reconstructs lane state from plugin storage and task state from existing supported Tasks RPC.

Update README and backup/uninstall guidance: the plugin will no longer be stateless. Removing its data can remove lane metadata while core tasks remain intact. Database migration must preserve existing task behavior on upgrade and be tested on a real prior-version fixture.

## Verification and delivery

Test persistence/reload, cross-board membership, rename/owner replacement, concurrent revision conflicts, park/archive/restore without task/thread effects, ambiguous and repeated import, absent-versus-deleted tasks, delta ordering/reconnect, and unchanged core-task RPC read counts. Verify keyboard and mobile interaction with synthetic data. Run repository tests, typecheck, plugin build, and focused browser checks. Review before merging; live installation/migration requires its concrete installation and data-preservation plan.

Deliver one coherent implementation PR in this repository, with design and operator/agent documentation. Keep changes scoped to first-class lanes; no task engine rewrite, automatic lane scheduling, provider switching, production changes, or unrelated SDK work.

## Review

A read-only architecture review confirmed the current cache/RPC shape and supported plugin-local SQLite storage in running BB0.47.1. It found the central choices to be lifecycle/owner metadata and one-lane-per-task semantics. Both are authorized defaults above. That review preceded implementation. The approved plan now governs the feature branch; live installation and live-data import remain separate integration steps.
