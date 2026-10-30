---
title: Deterministic app suite timeouts
status: in-progress
area: testing
owner: Codex app-timeouts
updated: 2026-10-30
links: [../../worker/test/harness.ts, ../../db/TestDatabase.ts, ../../e2e/offlineTransport.test.ts]
---

Trace slow awaits and shared dependency waits without increasing deadlines,
retrying or skipping tests. Retain red-first regression evidence and two
consecutive full app runs with all four coverage measures at 100%.
Use the library catalog's real Node flow host and SQL services.

The common harness's TRUNCATE was the slow await, including failures labelled
as pure rules. A Mac fixture sample found about 30 GB across pg_class,
pg_attribute, pg_constraint and pg_depend; active resets repeatedly waited on
DataFileRead without lock blockers. Transactional deletes preserve foreign-key
checks and row replication without TRUNCATE's catalog scan or file replacement.
[PostgreSQL's FK lookup](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/catalog/heap.c#L3105)
confirms that TRUNCATE sequentially scans pg_constraint.
Two regressions first failed with TRUNCATE: a reset blocked by a real reader,
and the table-file identity check. Both passed after the change in 19–21 ms.

The relay independently waited on an unassigned loopback address at its default
HTTPS port on macOS. Its real dependency now selects an owned local port, with
an omitted-port forwarding regression that failed on the old helper. The
original timeout reproduced on macOS, then all three relay tests passed in
67 ms. No test deadline, retry policy, coverage threshold or skip was changed.

A shared-fixture full run then hit the same catalog cost while a triage test
built and dropped three independent engine schemas. A row reset cannot bound
those DDL costs. `db/test-stack.sh` now owns fresh real Compose dependencies
and assigned loopback listeners for a command, with 100 PostgreSQL connections
and pool size four. Its real startup/cleanup regression failed with the old
fixed-port Compose configuration, then passed with the isolated configuration.
On a fresh stack all 75 triage cases and the five reset/relay cases passed;
the stack was removed after success and after an intentionally failing child.
The first fresh full run completed every case without failures: 6,072 passed,
three expected failures and 12 existing skips. Its coverage gate exposed one
unexercised triage/pause registration callback (99.99% lines/statements,
99.98% functions, 100% branches). A new real public-flow/outbox test exercises
Pause and replays the same execution, verifying one server write. Thresholds
remain unchanged. Two consecutive full coverage runs remain the completion gate.
