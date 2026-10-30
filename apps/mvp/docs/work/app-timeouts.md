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

After the pause test, a full run passed all four coverage gates at 100% with
6,073 passing cases. Its consecutive run exposed an engine-admission stall in
chat's first-text case: no model request arrived before the helper's budget.
The simulated worker previously muted its engine diagnostics. Build timing,
safe database wait records and typed failure tags now make that stage visible;
`MVP_TEST_ENGINE_TRACE=1` also records successful engine builds during diagnosis.

The diagnostic reproduced a 7.4-second device-engine build in PostgreSQL
WalSync with 35/100 connections, no blockers. Devices were opening and migrating
server schemas even though the browser's real engine uses local SQLite.
They now inject the SDK's `NodeRuntime.storage` into the same `BrowserRuntime`;
the server and remote-flow fixtures remain on real PostgreSQL/Electric.
The local journal/reload regression failed on the previous PostgreSQL fixture
and passed with SQLite. The existing first-text regression passed on SQLite.
The fixture regression also now checks two live stacks coexist and inner cleanup
leaves the outer database available, without assuming a particular assigned port.

A remaining chat reload case opened a full unused browser app just to obtain
the server API, leaving another engine, exporter and shape subscriptions alive.
Those backend-only scenarios now build the real server layer directly. A
service-graph regression first failed with the unused app present, then passed
with no Chat service or telemetry exporter. Existing browser cases retain
their real devices, persistence, outbox, engine and live Electric streams.
The resulting four-file check passed 146 cases plus two existing expected
failures. The reload case that timed out at 30 seconds completed in 1.7 seconds.
