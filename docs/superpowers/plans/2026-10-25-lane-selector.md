# Lane selector parity implementation plan

**Goal:** Put lane filtering beside Projects using its shared dropdown and compact trigger.

**Architecture:** Extract the existing toolbar menu, pass a lane filter control into the toolbar,
and retain lane management and the conditional summary below it. Keep existing filter state,
membership semantics and persistence unchanged.

**Stack:** Existing TypeScript, React, Radix and node:test with SDK synthetic renderer.

**Spec:** BTASK-4 and the supplied worker brief; design questions explicitly skipped.

## Review focus

- Multiple lane IDs and No lane form a union, composed with all other filters.
- Archived lanes and unavailable persisted selections remain visible and removable.
- Duplicate names are distinguishable without adding IDs to ordinary names.
- Loading, retry and empty states do not silently reset selections.
- Keyboard focus and narrow screens follow the shared Projects menu.

## Steps

1. Add failing rendered interaction tests for lane selection, persistence, composition,
   summary accuracy, archived/duplicate choices and keyboard behavior.
2. Extract Menu/ToolbarButton; add lane dropdown, retaining management/import access.
   Remove the separate lane filter row and show the summary only for one lane alone.
3. Verify loading/error/empty states and unknown selected IDs with focused interactions.
4. Extend the synthetic browser fixture; inspect desktop, 390px mobile and keyboard flows.
5. Run full tests, typecheck and build; obtain independent readonly review, fix findings,
   push and create one scoped PR. Parent owns merge and live update.
