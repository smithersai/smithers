---
title: Repair repository review reuse and triage publication
status: done
area: repository-flows
owner: Codex
updated: 2026-11-12
links: [https://github.com/smithersai/smithers/issues/5215]
---

The library catalog's repository automation entry owns this change through
the existing `wiki` and `triage-publish` recipes. Generated wiki reviews reuse
intact prior-run receipts with the collector's complete inventory identity.
Triage finds and updates its own comment across all pages, reconciles obsolete
managed statuses and checks, and rejects inherited property names as labels.

Regression coverage extends the real native wiki restart scenario with a
generated directory page and an inventory-only change. Publisher coverage uses
a local HTTP service with persisted comments and labels, exercising repeated
publication, pagination failures, readiness and reproduction transitions, and
invalid-report fallback. The 102 focused tests, package typecheck, clean-source
lint, module lint, documentation sync and documentation checks pass. All 52
published package documentation checks pass. The full package suite has the
same 17 failures and three skipped tests on unmodified and fixed sources; no
new failure is introduced. Focused tests, typecheck and lint also pass after
rebasing onto the updated main branch.
