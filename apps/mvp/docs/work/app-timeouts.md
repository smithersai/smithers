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
Two regressions first failed with TRUNCATE: a reset blocked by a real reader,
and the table-file identity check. Both passed after the change in 19–21 ms.

The relay independently waited on an unassigned loopback address at its default
HTTPS port on macOS. Its real dependency now selects an owned local port, with
an omitted-port forwarding regression that failed on the old helper. The
original timeout reproduced on macOS, then all three relay tests passed in
67 ms. No test deadline, retry policy, coverage threshold or skip was changed.
