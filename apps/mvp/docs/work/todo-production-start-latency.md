---
title: Reduce production TODO commit-to-claim latency
status: in-progress
area: runtime
owner: Codex todo-start-latency
updated: 2026-11-01
links: [engine-writer-lock.md, journal-latency.md]
---

Target: commit to claim under 3 seconds and idle lock waits under 500 ms.
Base: 998199dc, production push 22. Work remains local; no push or deployment.

Production alarm records report 101 transactions, three schema-wide transactions,
and 8,217 ms cumulative lock acquisition (including transaction open/network),
not one 8-second lock wait. Runtime registration runs clock and deferred recovery
queries for every registered flow, even on a single-execution host.

Library catalog entries: @smthrs/platform-cloudflare (host), @smthrs/engine-store
(durable recovery), @smthrs/database (Postgres transaction scope and telemetry).
All installs and validation run through lat-run on Latitude.

Focused Latitude matrix: HostedEngine 14/14 on SQLite and 14/14 on Postgres.
The real TCP-delay catalog benchmark (10 ms each direction) records 5,292 ms
for 32 recovery passes and 168 ms for one; SQLite records 7 ms and 2 ms.
The red-first run failed on both backends with 32 recoveries instead of one.
Full coverage gates and production target proof remain outstanding.

## Measured on 2026-11-01 (build d510d57c)

30 production TODOs on `codeplanesmithers/smithers-e2e-scratch`, 12:43 to 19:01 UTC, each with at
most one other TODO in flight (e2e fake agents). Read from `GET /api/remote-runs/<id>?limit=500`
journals of the `todo` run and its `agent/Session` child, the `todos` and `agent-runs` shapes. Seconds:

| Stage                                                     |  p50 |  p95 |
| --------------------------------------------------------- | ---: | ---: |
| commit (todo row) to `todo` run created                   |  3.2 |  4.7 |
| created to started (claimed in the same alarm)            |  1.5 |  2.5 |
| started to `todo/Agent` settled                           |  3.3 |  6.6 |
| `todo/Agent` to child admitted (`todo/Wait`, spawn)       |  2.0 |  4.0 |
| child admitted to parent parked                           |  1.5 |  2.1 |
| parent parked to child started (route, object, claim)     |  4.0 |  6.5 |
| child started to job enqueued (`initialize`, `start`)     |  3.8 |  7.1 |
| enqueued to claimed (runner long poll, server polls 1 s)  |  1.0 |  1.7 |
| claimed to first event posted (fake agent)                |  3.1 |  4.4 |
| **commit to first event**                                 | 22.8 | 36.4 |

Real Claude Code and Codex add about 6 to 8 seconds after the claim. Bursts of 50 lanes reach
minutes, spent before the job is enqueued and waiting for the runner's capacity.

Every stage up to the enqueue is database round trips, one after another. A statement trace of
the Cloudflare host's own `Parent`/`Child` fixture (platform-cloudflare `test/fixtures`) counts 489
round trips in the parent's first alarm and 301 in the child's, 62 of them before the child's
claim. A lone read costs four: `BEGIN`, `set_config('search_path')`, the read, `COMMIT`. Production
records consecutive single-write journal events 130 to 260 ms apart (median), so a round trip
costs an estimated 15 to 30 ms there; not measured directly.

Fixed, three commits: a child's object starts as soon as its admission commits (`WakeBus.Admitted`), not after
the parent's drive parks and routes; an alarm reads its run's row once for what never changes
(`EngineStore.DriveOptions.row`); a durable journal write allocates its sequence in its `INSERT` instead of reading
`MAX(seq) + 1` first. Round trips per alarm of the fixture flows, schema already migrated:

| Alarm                     | Before | After |
| ------------------------- | -----: | ----: |
| parent, admit to park     |    301 |   285 |
| child, admit to settle    |    301 |   276 |
| parent, child's result    |    301 |   277 |

Done 2026-11-03: a lone plain read of `flows_*` tables names their schema and costs one round trip, not four (`@smthrs/database` `QualifiedRead`), and consecutive savepoints share one, with `Consensus.guard` opening none. That took a child's alarm from 276 round trips to 193 (`platform-cloudflare/test/Routing.test.ts`).

Not done: `BEGIN` and `set_config('search_path')` in one round trip. Hyperdrive's handling of a multi-statement
simple query or a pipelined extended-protocol batch cannot be proven from here. A per-connection `search_path` is
unsafe behind transaction pooling (Hyperdrive, and the PgBouncer target the suites run): a session `SET` stays on the
server connection for the next client, and this client's next transaction may land on another. Schema-qualifying
every statement removes the need, but touches every store, and one missed name silently reads another schema
(the reason `PostgresDatabase.ts` gives for `SET LOCAL`). It is the largest cut left: about 80 of the child alarm's
276 round trips (each transaction's `set_config`, and each lone read's `BEGIN` and `COMMIT`).

Projection with real agents (6 to 8 s after the claim): p50 about 27 to 29 s, p95 about 38 to 40 s, against the
design's 30 s p95. Schema-qualified SQL would take about 7 s more off p95.

The 3 s goal needs engine state in the execution's Durable Object: the journal, run row, attempts, clocks and
completions in the object's own SQLite, at under a millisecond a write, with Postgres keeping projections written
from an outbox (the run catalog, `agent_runs`, the change feed). A start would cost about 40 local writes, two object
hops and one Postgres transaction for the job. It breaks what one Postgres transaction now makes atomic across runs:
a child's admission, parent edge, spawn record and inherited cancellation; cycle detection over the global edge
table; deferred completions and wakes between runs, the step cache and the durable queue; the store-wide sweeps and
retention queries; `RunInspection` and `/api/remote-runs` reads, and Electric shapes, which would lag the outbox; and
the SQLite and Postgres parity the engine suites prove. Even then a real agent's spawn after the claim takes 6 to 8 s,
so 3 s can only bound commit to claim.
