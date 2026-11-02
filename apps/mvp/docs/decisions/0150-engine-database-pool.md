# 0150: The durable engine reaches Postgres through its own Hyperdrive config

Status: proposed
Date: 2026-11-02
Decided by: the agent (shape500 lane), on the 2026-11-02 production 503 bursts; for Astra review before main

On smithers.sh on 2026-11-02, from 19:01Z to 19:08Z and from 19:47Z to 19:52Z, many routes answered 503 together:
`/api/repos/<o>/<n>/role`, `/refs`, `/home`, `PUT` runners, and the shapes' access checks with `retry-after`. Every one
of them reads Postgres (a session, a role row or a repository) before it answers, and each answers 503 `unavailable`
when that read misses its deadline.

Postgres was not down. Neon's compute (`ep-orange-waterfall`) had run without a stop since 2026-10-22, and Neon logged
no operation that day. Hyperdrive counted zero failed queries. Its pool was full. Cloudflare's GraphQL Analytics API
(`hyperdrivePoolSizesAdaptiveGroups`, `hyperdriveQueriesAdaptiveGroups`) shows the one `ChatDatabase` config's slices
in IAD each at 10 of 10 connections, with up to 30 clients waiting at a slice. Getting a connection took 1.2 s on
average, and a query took 170 to 435 ms against about 3 ms otherwise.

```
minute  queries/min  ChatApi req/min  FlowExecution alarm+rpc/min  waiting  avg connection wait
18:59      7,550          196                 154                     0          0 ms
19:02     15,286          202                 251                    26        374 ms
19:05     13,181          170                 180                    24      1,231 ms
19:48     14,939          117                 276                    21        355 ms
```

Queries doubled while ChatApi's requests held steady. A least-squares fit over 14:00Z to 20:00Z (360 minutes, 3.18 M
queries) puts about 40 queries on each `FlowExecution` alarm or call and about 3 on each ChatApi request: the durable
engine issues 90% of the queries. The burst was the runner e2e's ten TODOs at once. Pool waits of 21 to 53 clients
peaked in every hour from 06Z on, so the e2e only made a standing condition visible.

Both paths shared one config with an origin connection limit of 50 (infra/Connections.ts). In the analytics, Hyperdrive
split the config's connections into pool slices of 10 each and kept a client on one slice: one slice sat at 1 connection
while others had 26 waiting. Cloudflare's documentation doesn't describe slices. An engine burst filled every slice, and the request
path queued behind it.

## Decision

1. **Two configs.** `ChatDatabase` serves the request path: ChatApi's requests read sessions, roles, repositories and
   shape access through it. `EngineDatabase` serves the durable engine and what it delegates: every `FlowExecution`
   alarm and call, which includes the engine's journal, its leases, and the app writes its flows make, and the sandbox
   objects the engine calls (`SandboxObject`, `GateObject`). Each of those objects' database reads serves a box the
   engine woke: admission and release, a person's subscription, an overflow box's model, and the box's egress. The
   terminal's authorization stays on the request path: ChatApi checks the session and the branch's sharing before it
   hands the socket over, and the object reads no table to attach it. `worker/DatabaseRoutes.ts` names each consumer's
   config, and the program takes every consumer's config from there. Both configs front the same Neon host, and both
   are created after the migrations run (infra/ChatDatabase.ts `Databases`).
2. **The budget is split, not raised.** `CONNECTION_BUDGET.hyperdrive` goes from 50 to 20 for the request path, and
   `CONNECTION_BUDGET.engine` gets 30. The sum stays under 80% of the 0.25 CU compute's 112 connections, so
   `infra/Connections.test.ts` still holds. The request path carries about 8% of the queries, and 20 connections
   should give it two slices to itself and the engine three, if Hyperdrive keeps 10 to a slice. An engine burst now queues behind engine work only.
3. **Saturation alerts, in a new flow version.** `ops/DatabaseLoad/v2` (new step `ops/SampleDatabaseLoad`) also reads Hyperdrive's pools for the 7 minutes ending at each 5-minute
   sample (worker/HyperdrivePool.ts). When more than 10 clients waited at one config's busiest slice for 2 minutes in a
   row, the sample counts as over and the Admins get the existing `Database connections high` alert. The read needs
   `HYPERDRIVE_METRICS_TOKEN`, a Cloudflare API token with Account Analytics: Read, and `CLOUDFLARE_ACCOUNT_ID`.
   ChatApi binds `HYPERDRIVE_CONFIG_IDS` from the two configs. Without the token, the pools aren't read and the sample
   is what it was. A failed read is logged (`database.hyperdrive`, `failed`) and never fails the sample. The answer is
   decoded whole: a GraphQL `errors` member, partial data included, or any malformed row fails the read. v1
   (`ops/DatabaseLoad`, `ops/SampleConnections`) stays registered exactly as declared. A changed declaration changes
   the plan's digest, and a v1 run in flight at the deploy would stop with `plan_changed`. Each window's sampler starts
   v2 under its own execution id (`database-load-v2-…`).

## Rollout

Two deploys, in this order:

1. **Move the engine.** Create `EngineDatabase` (30) and route the engine and the sandbox objects to it. `ChatDatabase`
   keeps the shared config's 50 (`ROLLOUT_REQUEST_LIMIT`), so a Worker still sending the engine through `ChatDatabase`
   during the deploy never meets a smaller pool. The connection sum (119) exceeds the budget at the range's bottom (112
   at 0.25 CU) for this one step. It stays under 80% of what the compute really allows: `SHOW max_connections` read
   450 on 2026-11-03.
   Check: `hyperdrivePoolSizesAdaptiveGroups` shows the engine's load on the `EngineDatabase` config, and the
   request config's `waitingClients` stays at 0 during a TODO burst.
2. **Shrink the request pool.** Once step 1 is live, `ChatDatabase` takes `CONNECTION_BUDGET.hyperdrive` (20) and
   `ROLLOUT_REQUEST_LIMIT` goes (its own commit, deployed separately). The budget holds at the range's bottom again.

Rollback, in reverse:

- **Step 2:** redeploy step 1. Raising a limit is safe at any time.
- **Step 1:** first deploy a revision that routes every consumer back to `ChatDatabase` while still declaring
  `EngineDatabase`. Once that Worker is live, remove `EngineDatabase` in a later deploy. A single revert would also
  delete `EngineDatabase` while the Worker that binds it may still be serving. Never roll back step 1 while step 2 is
  live: the request pool would carry the engine at 20.

## Alternatives

- **Raise the one config's limit.** It doesn't isolate anything: the engine fills the extra slices too. Neon sizes
  `max_connections` by the range's top (450 at 1 CU, by `SHOW max_connections`), and Cloudflare's paid plan allows about 100 per config, so
  raising stays possible later. The budget, though, is sized for the range's bottom.
- **Raise Neon's minimum compute to 0.5 CU.** That doubles the budget and adds CPU, but costs money, and the pool, not
  Neon's connection count, was the limit. It is deferred until this change's effect is measured.
- **Cap the engine's concurrency in the host.** That bounds the burst but not the standing contention, and it slows
  every flow while the request path is idle.

## Consequences

- An engine burst now waits longer for its own connections: 30 instead of all 50. TODO start latency under a burst may
  grow. It is engine work, not a page.
- The engine's alarms read app tables through `EngineDatabase` too, which includes sign-in's role checks
  (`auth/RecheckRole`). Those are background work, so they belong on the engine's side.
- Hyperdrive enforces both limits softly and may exceed them briefly (Hyperdrive: Connection pooling). Cloudflare
  documents no bound on how far, so only a measurement shows the peak: `SHOW max_connections` and the peak origin
  connections in a burst.
- The engine's query volume is the root load, and this change doesn't cut it. Before this change, one execution
  (`2709d9e1…`) ran 1,455 alarms in an hour. Cutting the round trips per alarm is separate work
  (docs/work/todo-production-start-latency.md: about 280 per TODO alarm, 80 of them `BEGIN`, `set_config` and
  `COMMIT`).

## Verification

- `infra/Connections.test.ts`: the split budget stays under the alert share, and the rollout's sum under the alert
  share of the range's top.
- `worker/DatabaseRoutes.test.ts`: the routes, and that the program takes each consumer's config from them and that no
  other module opens a config of its own.
- `worker/flows/DatabaseLoad.test.ts`: runs start on v1 as main declared it before this decision, frozen in
  `worker/test/DatabaseLoadV1.ts`, and resume on the current module. A v1 run in flight resumes and completes, and v2
  runs beside it. A v1 alert whose email was sent while its Telegram message kept failing resumes without a second
  email. The control: v1 declared with v2's capability, as 0bf47166 did, stops the same run with `plan_changed`.
- `worker/HyperdrivePool.test.ts`: what saturation is, and one read against a fake GraphQL API: null rows, partial
  errors, a negative or fractional count, an unparsable minute, an extra account, a timeout, each a failure code with
  the token never in a result.
- `worker/flows/DatabaseLoad.test.ts`: a saturated pool makes the sample over and alerts on both channels; a calm pool
  or a failed read leaves the sample as it was.
- Burst check after step 1 (live 22:29Z on 2026-11-02): 53 leftover fleet TODOs dropped at about 22:30Z, with their
  observe runs, base invalidations and GitHub writes. From 22:33Z to 22:45Z `EngineDatabase` had up to 43 clients
  waiting and 5 s to get a connection, while `ChatDatabase` had 0 waiting and 0 ms. Over 181 minutes since, the request
  config's waiting stayed 0.
- Step 2's limit: Hyperdrive divided a limit across about 5 slices (30 gave 6 a slice, 50 gave 10), so 20 should give 4.
  A slice's `currentPoolSize` stays at its cap whether busy or idle, so it can't show demand. The request path's
  busiest minute (22:37Z: 983 queries at 202 ms) was 3.3 connections busy across all slices, counting query time and
  not time held between a transaction's statements.
- Neon: `SHOW max_connections` 450. 113 samples of `pg_stat_activity` from 01:41Z to 02:03Z on 2026-11-03, outside the
  burst: at most 78 connections, 9 active, 7 waiting on a lock. During the burst, the two configs' pools summed to at
  most 84, which with Electric's 21 is about 105 of 450, so connections were not the limit. CPU is not measured: Neon's
  API reports `cpu_used_sec` 0 and answers metrics 403 on this plan, so it needs the console.
- After deploy: `hyperdrivePoolSizesAdaptiveGroups` per config, with the request config's `waitingClients` at 0 during
  an e2e TODO burst, and Neon's peak connections and CPU from the console.
