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

Fixed: a child's object is started as soon as its admission commits (`WakeBus.Admitted`), not
after the parent's drive parks and routes; it saves the "child admitted to parent parked" stage.
Next, by size: fold `BEGIN` and `set_config` into one round trip (one of every four to seven);
read each run row once per alarm instead of five times; insert journal events without a prior
`MAX(seq)` read. At 20 ms a round trip, the 3 s goal allows about 150, roughly a tenth of today's.
