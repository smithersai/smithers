# Hosted registration cost

`engine-store.registration.recovered` records, once per runtime start, how
many registrations recovered clocks and deferred completions (`registrations`)
and how long they took in all (`durationMs`). Each registration's own recovery
is `engine-store.registration.flow.recovered` at Debug, with the flow tag and
its `durationMs`. Neither contains a payload. A duration includes database
reads and any recovery writes, not just CPU. On Cloudflare the summary
precedes `cloudflare.execution.ready`; compare the two before attributing
startup time to module compilation or a cold object. See
[Registration recovery](./api.md#registration-recovery).

The retained catalog benchmark is the `32-flow catalog` case in
`test/HostedEngine.test.ts`: real storage, 32 registered flows, and a
single-execution host. Recovery span count is a deterministic gate; reported
elapsed milliseconds are observations. The Postgres case uses the SDK's real
TCP SlowNetwork proxy with 10 ms of delay per chunk in each direction. SQLite
has no injected delay. Run through the package storage matrix for both.
Neither measurement claims to reproduce Hyperdrive or production placement.
The timer excludes runtime construction/migrations and measures registration
only; the count checks all 32 registrations with and without a hosted flow tag.

## Limit recovery to the persisted intent

A host that already knows its persisted execution's flow tag can pass
`sweep: { host: executionId, flow: flowTag }`. Registration still installs
every handler, including unrelated handlers needed by the catalog. Only the
named flow re-arms clocks and deferred completions for the hosted execution.
Omitting `flow` preserves recovery on every registration, and process engines
keep their existing behavior. No recovery result is cached: registering the
named flow again re-reads durable state, including completions arriving later.

CloudflareRuntime accepts `flow` alongside `executionId`; pass the tag from
the same persisted intent. The app's ExecutionHost does this. Connections and
runtime services still close at the alarm boundary; they are not retained
across Worker invocations or shared between executions.

## Latitude observation, 2026-10-22

The [retained receipt](benchmarks/hosted-registration-2026-10-22.json) records
both red-first and corrected runs. With the delayed Postgres transport, the
unfiltered control took 5,292 ms and the filtered case 168 ms (32 recovery
passes versus one). SQLite measured 7 ms and 2 ms. These are single
observations, not percentile estimates or production commit-to-claim timings.
The focused matrix passed 14 tests on each backend after the fix.
