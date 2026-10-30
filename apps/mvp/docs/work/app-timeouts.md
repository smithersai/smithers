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
67 ms. No test deadline was increased; no retries, reduced coverage thresholds
or skips were added.

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

A full four-worker run then reproduced disk-backed PostgreSQL WAL stalls even
with a fresh catalog: the clone lost its run lease after 19 seconds without
confirmation; a separate alarm stalled before engine readiness. Active server
records showed WalSync and WALWrite, available connections and no lock blockers.
The command-owned test fixture now uses a bounded 4 GiB tmpfs for PostgreSQL
data and WAL, retaining fsync, synchronous commits and real logical replication.
Engine/process restarts still retain their journal. The dev stack keeps its
disk-backed data; removing a command-owned fixture discards only its own data.
PostgreSQL I/O and WAL timings are enabled for future diagnosis.

The clone's optional App lookup also consumed its two-minute Index retry policy.
Its direct-step regression failed immediately on the previous implementation;
Index now returns an unknown installation on that lookup's typed failure and
settles the synced clone ready, still not reclaimable. Database failures keep
their existing durable retry policy. The full-flow regression now uses the
default test deadline instead of a three-minute exception.

A separate short assertion failure was PostgreSQL microsecond expiry precision
against the request clock's milliseconds. A 100-case diagnostic reproduced
26 refusals after the fixture set the expiry to `now()`. The fixture now sets
an actually elapsed expiry; it adds no sleep, retry or request polling.

The next full run exposed an issue-comment fixture using the default actor,
which has no GitHub session. Its real request was refused 401 immediately, then
the assertion polled for a successful dispatch for 40 seconds. The faulty app
now receives this file's signed-in issue-writing actor, like the happy-path
fixtures. An authority assertion reproduces the old setup failure in one
second before any success polling.

The completed sweep then found three further fixture assumptions. A transient
Done toast was inspected only after real cleanup waits had consumed its
four-second window. A tab can now inject an Effect clock for display timestamps;
the regression holds wall time while real SQL, Electric and SQLite finish, then
advances it to verify the toast expires. Sleep and monotonic deadlines stay real;
the server and engine retain their own clocks. The arbitrary 250 ms delay is gone.

Backend-only holders also existed outside chat. They now use one `openTestApi`
fixture, with no unused browser engine, exporter or shape subscriptions. Actual
test devices still run the full browser layer. The service-graph regression and
clock regression both failed in about one second with the prior fixture behavior.

The fullscreen-view case assigned card/page ids by completion order. Its new
page-first parameter reproduced that error deterministically in five seconds;
it now identifies the real views by URL after their rows arrive. The device bug
report case now asserts the browser/SQLite behavior for NUL: API refusal `invalid`,
with `BugRefused` in the report's typed history, rather than PostgreSQL's earlier
journal encoding refusal. The completed diagnostic had 464 passing files and
these three failing files; the final two clean full coverage runs remain required.

After those corrections, one full run passed 6,078 cases and all four 100%
coverage gates in 759 seconds. The next run exposed the new raw pause test's
startup race: it admitted the run in 92 ms before the session was confirmed.
The security guard intentionally treats an unconfirmed session as anonymous;
that decision is cached for the run, so its write waited out the existing
30-second queue retry policy. The guard remains unchanged. The fixture now
starts a cold tab, explicitly requests its real session and waits for the
confirmed signed-in row before dispatch. The immediate authority assertion
failed in 523 ms without that wait. Safe per-await diagnostics distinguish
session readiness, dispatch, replay and server-write waits by stage and engine
state without recording payloads or credentials. Two final consecutive passes
are still the completion gate.

The following full sweep confirmed this was a shared issue-fixture precondition,
not specific to pause: issue/create was also admitted before session confirmation
and its public join failed after 30 seconds, despite its outbox write succeeding.
Both opened-issue helpers now await the real confirmed-session signal before
returning a ready device. Explicit cold-start fixtures opt out and exercise the
same signal helper directly. No security guard or credential cache is changed.

The next sweep passed 6,077 cases and all four coverage gates but exposed a
cross-device pin assertion. Its readiness check compared two live arrays and
could accept two empty projections before the second device's message arrived.
The regression now installs that waiter before producing a pin, then checks it
is still pending after a real server round trip. The former equality condition
failed this assertion in 1.06 seconds. Readiness now requires the expected pin
text on the second device; the stale-callback assertion also waits for that
real projection, without increasing a budget or retrying an action.

The following sweep passed all 6,078 cases, but its coverage gate exposed a
concurrent-save test that did not guarantee overlap: its second request could
read an already saved draft instead of reaching the locked-row replay branch.
The test now holds the real draft row lock until both requests are observed
waiting in PostgreSQL, then releases it and verifies one new revision and one
existing response. All 40 personal-flow cases pass at all four 100% measures.
The product's locking and replay behavior are unchanged.
