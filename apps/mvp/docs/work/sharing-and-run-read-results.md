---
title: Keep delayed sharing and run reads attached to their requests
status: done
area: mvp
owner: Codex
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/5287
---

Sharing replies must belong to the current dialog opening and the latest request for their row.
When a local missing run prompts a cloud lookup, the cloud response determines the page state and read record.

The regressions cover switching branches, reopening the same branch, overlapping changes and closing the dialog,
plus unavailable, not-started and refused cloud responses and retention of a previously read page.

Verification: the original source failed 15 of the 16 new cases; all 16 passed with the fix. Both changed test
files passed (77 tests) within a broader run with 276 passing tests. The app typecheck and lint of the three
changed production files passed. Sharing actions and store reached 100% coverage in every category.

The broader graph assertion failure and unchanged run-store cache-eviction coverage gaps are tracked in
[#5453](https://github.com/smithersai/smithers/issues/5453). No coverage thresholds were lowered.

The change uses the existing durable `FlowDispatch` through `@smthrs/flow` and collections through
`@smthrs/effect-tanstack-db`.
