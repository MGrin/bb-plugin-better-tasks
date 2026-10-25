# First-class Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in your BB-managed worktree. Steps use checkbox syntax.

**Goal:** Make lanes persistent first-class cross-project work groups alongside labels, usable by people and agents.

**Architecture:** Core Tasks retains task ownership. The Better Tasks plugin owns lane metadata and stable task-ID memberships in its supported SQLite store, publishes independent versioned deltas, and presents lane management and scoped task views through existing React controls. No automatic thread or task-state orchestration.

**Tech Stack:** Existing TypeScript, React, Zod, BB Plugin SDK and supported plugin-local SQLite; retain established package/build patterns.

**Spec:** `docs/superpowers/specs/2026-10-25-first-class-lanes-design.md` (copy the supplied reviewed design into the worktree). Nikita explicitly opted out of further design questions and authorized using our existing lane rules. Execute natively in one repo worker because the storage, RPC, cache and UI interfaces are coupled; independent read-only whole-branch review before PR. No further execution-method or plan approval question.

## Global constraints

- Stable lane identity; one nullable lane per stable task ID; cross-project membership; optional coordinator thread.
- Lane states active, parked, archived. No hardcoded five-slot limit. No core task status/label/thread mutation from lifecycle actions.
- Labels stay independent. Import is explicit, previewed, conflict-aware and idempotent; no name-only merge or continuous dual-write.
- Use only public Tasks/SDK calls; store lanes only in this plugin's own database. Never inspect or mutate live BB/core Tasks databases.
- Use existing TypeScript/React conventions. Preserve virtualized rendering and incremental task reads.
- Canonical checkout stays main. Commits only here, author MarcoFlare <marco@withflare.co>. Parent owns live install and integration; no live data import or public release during worker verification.

## Review focus

- Partially loaded or disconnected task cache must not delete memberships (Task1/2).
- Concurrent lane and membership edits must reject stale revisions without changing another writer's result (Task1).
- Renamed/moved task keys and archived/deleted owner threads must preserve lane identity and display truthful availability (Task2/3).
- Same-name labels in different projects and tasks with multiple lane labels need explicit mapping/conflict resolution (Task4).
- Out-of-order events/reconnect and lane-only edits must not silently corrupt UI state or reload every core task (Task2/3).

## File structure and interfaces

Follow existing files, adding focused units rather than putting all storage/UI in server.ts/app.tsx. Proposed names below are implementation defaults; adjust locally only when existing SDK contracts require it, consistently in all callers and tests.

- `lib/lanes/model.ts`: Lane, LaneMembership, LaneSnapshot, LaneChanges, typed inputs/results.
- `lib/lanes/repository.ts`: SQLite migrations, transactions, revision checks, persisted change cursor.
- `lib/lanes/service.ts`: public core-task and owner lookup adapter, validation, import preview/apply.
- `lib/lanes/client.ts`: client lane snapshot/delta application, no core task duplication.
- `server.ts`: typed lane RPC registrations using service; separate small lane realtime channel; disposal.
- `lib/lanes/cli.ts`, `skills/lanes/SKILL.md`: namespaced `bb better-tasks lane` commands through same service.
- `components/lanes.tsx`, `components/lane-picker.tsx`: lane overview/detail/metadata controls and task assignment.
- `app.tsx`, `components/toolbar.tsx`, `components/detail-pane.tsx`, `lib/view.ts`: lane routing/filtering and integration.
- `test/lanes-repository.test.ts`, `test/lanes-service.test.ts`, `test/lanes-client.test.ts`, existing test fixtures: behavior tests; use synthetic data only.
- `README.md`, `package.json`: feature/API/backup documentation and skill registration; add dependency only if actually necessary.

### Task 1: Durable lane records and membership

Interfaces: `Lane {id,name,goal,state,ownerThreadId,revision,createdAt,updatedAt}`; `LaneMembership {taskId,laneId,revision}`. `LaneRepository` provides `list`, `get`, `create`, `update(id,patch,expectedRevision)`, `setMembership(taskId,laneId,expectedRevision)`, `snapshot`, `changesSince(cursor)`. Persist membership revision/tombstone after unassignment so stale assignment cannot silently win. Return typed conflict/current value, not success on stale input. Store change cursor transactionally with effects. Use generated stable IDs.

- [x] Write failing repository tests: reopen persistence, cross-project IDs, rename/owner replacement preserve membership, stale update/assignment conflict, unassign/reassign stale conflict, archived lane rejects new assignment, lifecycle leaves all core task/thread state untouched.
- [x] Run `node --test test/lanes-repository.test.ts`; verify failures describe missing behavior.
- [x] Implement model/repository with supported append-only migrations and transactional CAS; archive/restore are state updates, never hard deletes.
- [x] Run repository tests green, including a prior-version database migration fixture; commit exact changed files.

### Task 2: Validated RPC, CLI and incremental client contract

Interfaces: service consumes repository plus injected public `getTask(taskId)` and `getThread(threadId)` adapters. Export typed RPC operations list/get/create/update/setMembership/snapshot/changes. Owner lookup returns available/archived/missing/unknown explicitly without erasing ID. Lane deltas are separate from task-cache revisions; stale clients receive a lane snapshot reset when retained deltas cannot answer. CLI uses `bb better-tasks lane list|get|create|update|archive|restore|assign|unassign`; writes require observed revision, reads bounded/paginated. Match installed SDK registration declarations and preserve existing supported minimum version where possible.

- [x] Write failing service/client/CLI contract tests: invalid IDs/input, core task lookup failure, known deleted vs unloaded task, missing owner, bounded pagination, stale revision, out-of-order duplicate delta, reconnect/reset, no extra whole-task-list request after lane edits.
- [x] Run those focused tests red.
- [x] Implement shared mutation service, RPC/CLI registrations and lane client store. No direct Tasks DB or command shadowing. Dispose registered background resources; no new periodic full reload.
- [x] Run focused tests and existing cache/sync/client suites green; commit exact files.

### Task 3: Lane management and task views

Interfaces: components consume LaneSnapshot/changes from Task2 and existing task rows. Lane filter state adds selected lane IDs plus explicit no-lane option; lifecycle filtering is separate from task status. `LanePicker` uses current membership revision. Owner control uses supported thread lookup/picker, displaying archived or missing state accurately. Lane detail shows goal, coordinator link, lifecycle, counts by task status and actual member-task live activity. Keep archived lanes discoverable.

- [x] Add failing pure view/store tests for cross-board lane filtering, no-lane selection, simultaneous label/lane filters, revision-conflict refresh, missing owner, unchanged task statuses on park/archive/restore.
- [x] Run focused tests red.
- [x] Implement lane overview/detail/navigation, metadata editing, task Lane field, filters and links with existing UI primitives. Retain list/board virtualization, row identity, keyboard behavior, mobile layouts and accessible labels.
- [x] Run tests/typecheck/build; exercise synthetic lane creation, rename, owner replacement, assignments, parked/archive/restore and mobile/keyboard paths in a contained preview. Do not install over the live managed plugin or import live labels. Commit.

### Task 4: Reviewed legacy-label import and coherent delivery

Interfaces: `previewImport(mapping, observed memberships/labels)` returns deterministic proposed effects, conflicts and an opaque review identity. `applyImport(preview, resolutions)` revalidates all cited label/task/membership facts; transactionally applies lane-side changes only and records an idempotency receipt. Unknown commit outcomes reconcile receipt before any replay. Same names are candidates only; a task cannot be auto-assigned through two incompatible label mappings.

- [x] Write failing import tests: identical label names across boards, two lane labels on one task, existing membership, changed source after preview, repeated apply/ambiguous receipt, label disappearance, unchanged core labels/statuses/attachments.
- [x] Run import tests red.
- [x] Implement preview/resolution/apply through shared service and UI/CLI; no automatic live cutover and no continuous label-to-lane inference.
- [x] Update README/stateless claim, backup/uninstall notes, agent skill, and design/plan docs. Document that marco tasks --lane is a separate later integration and still uses labels.
- [x] Run `npm test`, `npm run typecheck`, `bb plugin build .`, diff check, focused browser acceptance. Report exact counts and genuine skips. Run a read-only independent whole-branch review; resolve substantive findings with regression tests.
- [ ] Publish one PR through marco comms with scope, validation and limitations. If no upstream CI exists, report that accurately rather than invent checks. Parent owns merge/install decisions. Keep task in_progress until merged/verified when applicable.

## Self-review

Spec coverage maps data/lifecycle to Task1, APIs/performance/recovery to Task2, user workflow to Task3, and legacy labels/delivery to Task4. Each review-focus failure is covered by a named test above. Types and revision ownership are shared across tasks; core task and lane revisions never substitute for each other. Remaining implementation defaults belong to the worker, not another sponsor question.

## Delivery evidence

Implementation and independent review are complete. The reviewed branch passes 56 tests with zero skips, typecheck, and plugin build. Browser acceptance used synthetic SDK storage at desktop and 390px mobile widths. The two review findings have red/green regressions. PR publication is blocked by the required communication adapter: it rejects MGrin/bb-plugin-better-tasks with `expected Flarexyz/repository`. The worker retained the exact authorized PR request for the parent; no direct posting bypass, live installation, or live import occurred.
