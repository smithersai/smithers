---
title: Complete merge ancestry before folding GitHub history
status: done
area: vibelang
owner: Claude
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/5352
---

A fold must fetch all new ancestors of a merge before it advances the folded cursor. The first-parent cursor may
appear on an earlier GitHub page than a new side ancestor.

The history reader now checks ancestry completeness against the known ancestry of the folded cursor. Missing new
ancestry keeps pagination running, and an incomplete final page or exhausted page budget answers unavailable before
the fold writes any commits. Decision 0020 documents the rule.

Validation covers a merge split over two pages, the recorded real commits before an empty second fold, missing
ancestry at both pagination limits, and generated DAG prefixes checked against an independent reachability oracle.
