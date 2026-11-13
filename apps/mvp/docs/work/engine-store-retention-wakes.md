---
title: Retention identities and durable wake recovery
status: done
area: flows
owner: Codex
updated: 2026-11-12
links: [https://github.com/smithersai/smithers/issues/4775]
---

Repair retention of companion journal generations and invalidate live journal
identities only after the deleting transaction commits. Record parent wake
completion and clock and parent wake consumption in the same transaction as
their state rows. Preserve the existing public APIs.

Regression coverage exercises both retention entry points, rollback and dry
runs, reuse of deleted producer identities, and rebuilding consumed clock and
parent wakes from the journal.

Retention refuses deletion inside a raw SQL transaction whose commit is not
observable, using the existing `delete_failed` error. Managed outer transactions
publish invalidation only after commit; failed and dry passes publish nothing.

Validation synchronizes existing clock-retry and handoff-refusal tests with
their real asynchronous completion before advancing time or asserting rollback.

Verified the regressions fail against the original implementation and pass with
the repair. The full SQLite and Postgres package suite passes with 100% merged
coverage. Package typecheck and lint pass, as do all 111 tests in the affected
files after rebasing onto current main. Astra review has no remaining findings.
