# Zero-lane import implementation plan

> **For agentic workers:** implement inline in the assigned BB worktree; use test-driven-development and verification-before-completion.

**Goal:** Start a reviewed label import with no existing lanes.
**Architecture:** Keep the TypeScript/React UI and existing lane/create, preview/apply APIs. Add a source-specific create action with synchronous duplicate protection. Persist uncertain create attempts in the browser session; reconcile through an authoritative lane snapshot and require explicit destination choice, never automatic name matching or a blind create retry.
**Spec:** BTASK-2 worker brief and parent evidence in thread storage.

## Constraints and review focus

Preserve backend schemas, source project/label IDs, task fields, revisions, conflict choices, and import receipts. No live import/install. Lane creation starts no threads. Check zero/partial loading, duplicate clicks, lost responses/remount, same-name sources, and keyboard/mobile controls.

## Steps

- [x] Write and run failing synthetic zero-lane import UI regression, including create/mapping/preview/apply and cross-project independence.
- [x] Add empty manager import entry, inline create controls, readable source names and meaningful loading/empty/error states.
- [x] Test create duplicate protection and uncertain-result reconciliation across remount; preserve explicit selection.
- [x] Run focused tests, full tests/typecheck/build and synthetic mobile/keyboard browser acceptance; obtain independent readonly review.
- [x] Commit/push reviewed head, retain paused PR request, release claims and report to parent.

Validation: original empty-state regression failed before implementation; focused UI 2/2 and full suite 58/58 passed. Typecheck/build passed. Independent readonly review found zero critical/important issues. Deferred minor polish is retained separately. No GitHub workflows exist. Parent owns merge and live installation; publication remains paused.
