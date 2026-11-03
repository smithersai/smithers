---
title: Issue tree ingestion and reader-scoped edges
status: in-progress
area: app
owner: Codex tree3
updated: 2026-11-04
links: [../decisions/0153-issues-are-a-tree-todos-are-its-leaves.md, ../features/issues.md]
---

Prepare the held step 3 change for landing; do not land or push it. Rebased onto
`7bc198f5fea9eebe2d5787aeda34679cbbb094a5` after a second refresh from main;
the unpublished migration is now
`0108_issue_tree`. Existing published migration identities remain intact.

Library catalog entries: GitHub API calls (`@smthrs/integrations`), durable
workflow (`@smthrs/flow`), and SQL migrations (`@smthrs/database`). This extends
the existing issue projection and its shared access predicate.

Validation and review are in progress on cfbox through nyc-01. Durable receipts:
`/Users/williamcory/.vibe-orch/proxy/smithers-runners/tree3/issue-tree-ready/`.

Two regression tests first failed because a failed candidate query returned
successful, smaller scopes and edge sets. The handler now refuses both reads
with `503`, and records the failed stage without SQL or user content. The
pre-fix focused run passed its other 123 tests.

Astra round 1 found the missing visibility observation timestamp, equal-count
membership replacements and failed-parent starvation. Six new regression cases
failed before fixing these. Verification now checks a bounded, fair batch with
separate attempt and success timestamps, retires missing parents and retains the
durable retry policy after progress on other parents. Rate limits stop the batch.

Astra round 2 found restricted-token discovery, stranded incoming edges, equal-time
tombstones and conflicting fixture parents. Four new cases failed before fixes.
Read tokens now explicitly group currently selected repositories in the same
installation. Parent-check receipts are independent of counts; incoming edges
remain discoverable after a parent count disappears. The fixture has one parent
authority. Main's duplicate service fields and pagination compatibility failures
were also corrected. Library hashing in tests uses `@smthrs/crypto` from the catalog.

Astra round 3 found that a hidden parent refresh could grow future authorization
candidates through installation caching. Two server regressions failed before
guarding neighbour refreshes and relation-webhook admission with independent
candidacy. The existing typecheck also exposed a test HTTP seam's database error
channel, now converted to a test defect at that seam.
