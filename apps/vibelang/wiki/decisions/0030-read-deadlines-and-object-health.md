# 0030: Read deadlines and inspectable objects

2026-11-09, lane vl-connectfix. Library catalog: `@smthrs/flow` owns durable retries and deadlines;
`@smthrs/platform-cloudflare` hosts the engine over each object's SQLite. No dependency added.

## Evidence

The cutover's account migration and every subsequent account mutation open an engine scoped to a new execution ID.
The runtime's recovery filter excludes other executions. An interrupted `migrate` row therefore does not, by itself,
force a later bootstrap grant or public read to decode that row.

The workerd regression seeds an existing account journal and a legacy encrypted `github/*` row, with no migration
flag. It holds the actual production migration at deletion, replaces the object incarnation, and retains SQLite
and key-value storage. Historical account/read protocol declarations preserve the relevant 28ea402 and 343e5d4d
schemas, plan and retry policy; this is a focused protocol reproduction, not an archived full Worker deployment.
A direct roll-forward and a rollback then roll-forward both exercise the current production account body.

An additional workerd receipt bundles the original account, issue and flow app sources from jj checkouts of
343e5d4d and 28ea402ae6, retaining the same Miniflare object store across reloads. It interrupts the cutover's actual
migration before deletion, reopens on the rollback, observes both public reads time out at eight seconds, then
reopens on the fixed app. Migration finishes and the reads answer 503 in 5.4 and 6.2 seconds. This harness reuses the
lane's installed SDK dependencies; it does not claim an archived production Worker or private production storage.
The lane report links its script and structured receipt.

The original failing test timed out at eight seconds after migration and bootstrap had succeeded. A faulty Effect
`IssueHost`/`WikiHost` supplies the dependency failure; no request is intercepted. The issue read retried for up to
120 seconds while holding the semaphore shared with wiki. Wiki's own flow deadline begins after that semaphore,
so it cannot bound queue time. This also explains how an abandoned request can produce no application step line:
a caller queued behind the semaphore has not reached a step yet. The regression reproduces this mechanism; the
production object's private storage and upstream response were not inspected by this lane.

## Change

Issue reads, like wiki reads, have a five-second **engine** deadline. Writes retain their existing retry policy.
The account read boundary also bounds queue time at six seconds and returns 503 `unavailable`. The existing client
shows Retry. Engine deadline and queue expiration each emit a fixed log name and a counter.

Each API object exposes `health()` before its initialization finishes. `GET /api/health/objects` reports the Worker
commit and each instance's class, opaque object ID, code version, and startup state (`starting`, `ready`, `failed`).
The classes are ProjectAccounts, History, ActionIndex, Conversation and Budget. `?conversation=<id>` selects a
conversation; otherwise the probe uses `health`. Budget uses the current UTC day. Each probe is bounded to two
seconds; an old instance without the method or an unreachable instance is reported as `unreachable`, with unknown
identity/version, rather than being labelled current. `/api/health` keeps its lightweight existing contract.

Initialization logs, spans and counts `initialize` as started, ready or failed, without error messages or storage
values. It has a five-second bound. Callers also bound their wait to five seconds, independently of initialization's
interruption cleanup. A storage critical section can finish without holding the request open; health honestly stays
`starting` until initialization finishes. A wait expiration logs `vibelang.object.startup.wait.deadline` and increments `vibelang_object_startup_wait_deadlines`. A new ordinary call retries failed initialization once; health reads never
restart it. The object retains the host scope, and only declared members are exposed while startup is pending.

The shared engine now reports undecodable action outcomes, run envelopes and terminal outcomes with
`JournalDecodeError`; a rejected historical flow payload retains the existing typed `payload_changed` refusal.
Diagnostics carry the fixed step/flow tag, object ID and code version, never the stored payload or schema message.
`smithers_journal_decode_failures` counts by fixed tag and boundary. Cloudflare supplies the object's real ID and
inherits or explicitly receives its deployed code version. Returned RPC methods keep that identity after initialization. Regression cases cover an unknown literal after rollback,
real persisted corrupt state/results, and action outcomes that fail their schema.

Browser auth projects use separate workerd stores: roles and successful write receipts must not leak across browsers.

## Amendment: cold issue reads (2026-11-10, lane vl-public-reads)

A cold issue list follows five GitHub cursor pages and reads assignees sequentially. Six requests at 1.1 seconds each
cannot complete within the former 5-second flow or 6-second accounts boundary. Issue reads now have a 12-second
engine deadline and a 13-second accounts boundary, including queue time; wiki keeps 5 and 6 seconds. Cached reads
still wait only 3 seconds for revalidation before answering their copies stale (0031). Regression tests preserve all
410 records on the first read through both public and accounts boundaries, and require a stalled GitHub to answer
503 within the bounded wait. Writes keep their existing policy.

Note (lane vl-bench2, 2026-11-10; no policy change): a signed-in issue read waits the whole 12-second deadline when
GitHub is unreachable. `bench/accounts-offline.bench.vibe` measured 12,091 ms (about 5 s before this amendment); wiki
still answers within 6 s. Failing fast on a transport error is this decision's owner's call.

## Amendment: health waits for the start-up it wakes (2026-11-10, lane vl-public-reads)

After the 05:42 deploy, a first `/api/health/objects` read reported Budget, History and ActionIndex `unreachable` and
the others `starting` at `initialize`, while a read one second later reported all five `ready`. The health read was what
woke each evicted object: it read the status before the initializer ran a step, and reaching a cold object took over
two seconds. `health(patience)` now waits up to `HEALTH_PATIENCE` (2 seconds) for the current start-up to settle and
reports it as it stands after; it never starts or retries one. Each probe's bound is `HEALTH_BUDGET` (4.5 seconds), so
the probe holds both a cold reach and the wait. `test/apiObjects.coverage.test.vibe` holds an actual initializer at
300 ms and proves the route waits for its ready state; the deployed immediate call fails this case. The workerd
health test checks actual cold instances, and `test/objectStartup.test.vibe` bounds the wait. Fast workerd startup can
finish before an immediate probe, so the controlled initializer is the deterministic regression.

## Amendment: start-up under Alchemy's bridge (2026-11-10, lane vl-startup-hang)

Deployed as `4827dd9d63`, every object stayed `starting` and every route but `/api/health` answered 503 after five
seconds. The sentence above, "the object retains the host scope", was false in production. `worker/Api.vibe` provides
each object's layer with `Effect.provide`, Alchemy's documented form. Effect builds that layer in a scope that closes
when the Worker's init returns, and Alchemy's `DurableObject.make` captures that scope with the layer's services. Its
bridge then handed the closed scope to every constructor. `Effect.forkIn` into a closed scope interrupts the
initializer before its first instruction, so neither `ready` nor `failed` was ever logged and the initializer's own
five-second bound never ran. The workerd suite's host builds plain objects and never runs the bridge.

- **Fix:** the repository's `@alchemy.run/cloudflare` patch gives each constructor its own open, instance-lifetime
  `Scope` ([patches/README.md](../../../../patches/README.md)).
- **Interrupted initializer:** an initializer interrupted from outside settles as `failed`, logged with outcome
  `interrupted`. Waiting calls are refused at once and the next call retries, instead of each waiting five seconds.
- **Steps:** health and the `vibelang.object.startup` log name the step an object is in: `initialize`, `begin`, then
  the body's `storage`, `sequencer`, `bootstrap` or `accounts`, each `started`, `done` or `failed`.
  `vibelang_object_startup_steps` counts them by class, step and outcome. A stuck object's last line names its step.
- **Regression:** `test/coldStartup.workerd.test.vibe` runs `alchemy dev`, Alchemy's own bundle and bridge with
  `worker/Api.vibe`'s bindings. Its first requests reach every class cold at once; it requires every class to leave
  `starting` and the four without GitHub reads to be `ready`.

## Validation

The lane report records the executed commands, counts, exit codes and landed commits. The lead deploys main and
checks production. This lane does not deploy or claim that the unavailable production storage has been inspected.
