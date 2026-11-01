---
title: Worker test database reset lock stalls
status: done
area: testing
owner: Codex GPT-6.1 Sol
updated: 2026-11-01
links:
  - ../infrastructure.md#tests
  - ../../worker/test/reset.ts
  - ../../worker/test/reset.test.ts
---

The common worker `beforeEach` reset scanned the shared database's entire foreign-key catalog. PostgreSQL 17's [`heap_truncate_find_FKs`](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/catalog/heap.c#L3105) uses a sequential scan of `pg_constraint` even when every truncated table is empty. Schema churn left the mini's catalog heap at 7088 MB with about 299,000 live constraints.

With four owned CPU burners running, 500 ms samples of `pg_stat_activity`, `pg_blocking_pids(pid)` and `pg_locks` showed the six-table TRUNCATE active at `IO/DataFileRead`: all six `AccessExclusiveLock`s granted, `pg_constraint` held with `AccessShareLock`, no blocking PIDs. The observed reset cost was catalog I/O. The baseline four files passed 63 tests in 111.13 seconds; that run did not reproduce the intermittent 30 second timeout. Other transactions sometimes waited *behind* a slow truncate; they were not its blockers. No backend was terminated and no global database setting was changed for this investigation.

`worker/test/reset.ts` replaces this TRUNCATE with child-first DELETEs of the same six tables and `ALTER SEQUENCE messages_position_seq RESTART`, all in one transaction. The sequence restarts at its configured start and keeps its step; the restart rolls back with the deletes. Other per-file fixtures, including timeline attempt history, remain as before. The real Effect SQL / `@effect/sql-pg` fixture is unchanged; no new library or runtime is needed. File-specific TRUNCATEs elsewhere are outside this change.

The fast regression reads `pg_stat_xact_sys_tables.seq_scan` for `pg_constraint` on the same connection and transaction around reset. It failed against the old reset (delta 1), and passes against the new one (delta 0). It needs no large catalog fixture, clock threshold, mocked client, or global statistics reset. Further tests seed every affected table and its FKs, exercise repeated empty resets and the shared sequence, inject a real failing Postgres trigger midway through deletion, and roll back a completed reset from an enclosing transaction.

Validation on the mini: four regression tests pass, with 100% V8 statements, branches, functions and lines for `reset.ts`. `pnpm typecheck` passes all four app projects. All four affected files plus the regression pass three times (67 tests each): 79.86 s and 81.84 s without added load, 87.02 s with four CPU burners; these are observed run durations, not a controlled performance claim. Codex Astra review found no actionable issues. Fable review found a test fault-function cleanup gap; both the trigger and its function now have acquired lifetimes, with a post-cleanup assertion. Execution receipts are recorded in `~/smithers-builders/harness-reset-STATUS.md`; all heavy execution stays on the mini. No hook or test timeout increased.
