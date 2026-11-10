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

## Validation

The lane report records the executed commands, counts, exit codes and landed commits. The lead deploys main and
checks production. This lane does not deploy or claim that the unavailable production storage has been inspected.
