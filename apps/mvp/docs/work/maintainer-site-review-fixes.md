---
title: Maintainer site decision and path corrections
status: done
area: process
owner: Codex
updated: 2026-11-13
links: [https://github.com/smithersai/smithers/issues/5425, maintainer-site.md, will-decision-queue.md]
---

The review found duplicate standing decisions, malformed site paths returning server errors,
and a screenshot check that accepted missing home-page counts.

The fix refuses another answer while the current item is hidden by a standing answer.
Undo, a curator re-addition and an expired snooze allow another answer.
Answers record the item's `addedAt` generation, so clock skew does not permit a duplicate.
Historical answer stacks remain readable and undoable using their original timestamps.
Malformed percent-encoding returns `400` with `bad path` on both site and file routes.
The home screenshot check requires exactly three positive counts.

Validation: all `127` package tests pass on `Node 26.5.0`, including real Chromium queue
tests and the built home. The built-home regression fails with the original empty-count
predicate and passes with the fix. `ESLint`, syntax checks and the work-note check pass.

The stale-card fixture gives each simulated curator edit a distinct timestamp.
Equal-sized queue replacements with matching timestamps are tracked separately in
[#5451](https://github.com/smithersai/smithers/issues/5451).
