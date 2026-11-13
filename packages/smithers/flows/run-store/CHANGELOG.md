# @smthrs/run-store

## [Unreleased]

### Added

- `Ownership.singleIncarnationLiveness`: the liveness check for a host that runs
  one incarnation per host id. An owner with the claimant's host id and another
  `pid` or `nonce` is dead however fresh its lease; every other owner is judged
  by its lease. `@smthrs/platform-cloudflare` and `@smthrs/platform-browser`
  use it in place of their own copies.

- `RunStore.owned(sql, fence, options?)` returns a SQL condition an action adds
  to its own `UPDATE`: it holds only while the fenced owner holds the run and
  the fenced attempt is still `running`, so a write from a superseded owner or
  a settled attempt changes no row. On PostgreSQL it reads both rows
  `FOR SHARE`, ordering the write before a concurrent takeover. `schema`
  qualifies the engine tables for a client on another search path.
  `RunStore.Fence` and `RunStore.OwnedOptions` name its inputs.

- Required `RunStore.Service` operations `lineage`, `latestRound`, and
  `requestCancelLineage` resolve logical runs across trampoline rounds. Logical
  cancellation is atomic and preserves terminal-round history and existing
  request timestamps. Custom adapters must implement these operations; the
  unavailable stub refuses them explicitly. No database migration is needed.

### Fixed

- Long-running flows no longer load historical state payloads for lineage lifecycle decisions; these reads now use validated metadata.

- A read of a run whose state has not changed no longer parses and walks the
  state again. `get`, `latestRound` and `lineage` validated `state_json` on
  every call: two parses and one bounded walk of the whole tree, 8 to 12 ms for
  a 65 KB state, which a driver that polls its runs paid many times a second.
  The store now admits each distinct state text once, when it is written or
  first read, and recognises the same text afterwards by comparing it; a text it
  has not admitted is still checked in full, and a refusal is never remembered.
  It remembers at most 4 Mi characters of state per process, least recently
  read first out. Measured with `pnpm --filter @smthrs/run-store bench`
  (`test/StateRead.bench.ts`, in-memory SQLite, Node 26, a 32-core Linux host
  under load): `get` on a 65 KB state went from 85 to 123 reads a second to
  12,845 to 18,172; on a 271 KB state from 24 to 31 to 7,684 to 8,108; on a 1 KB
  state from about 2,900 to about 13,000. `create` and `transitionOwned` also
  parse an accepted state once instead of twice.

- `claim`, `claimAndOwn` and `steal` classify a grant the consensus strategy
  refused from the strategy's reason instead of the unchanged row: a held
  lease claim reports `AlreadyClaimed` and a held or live owner lease reports
  `HeartbeatFresh`. They reported `SnapshotChanged`, which sent a caller that
  re-reads and retries into the same refusal.
- Fixed the CommonJS build of the migration set. `migrations/0001_initial`
  now exports `initial` and `migrations/0002_lineage` exports `lineage` as
  named bindings, and every importer reads them by name, because esbuild's
  Node interop for a default import of a sibling module resolved to the whole
  exports object instead of the Effect, so `require("@smthrs/run-store")`
  produced a migration set whose entries had no `pipe` and the migrator failed
  at load.

### Changed

- `RunStore.claim`, `claimAndOwn`, `steal`, `heartbeat`, and `recoverClaim`
  refuse a `nowMs` that runs ahead of the Effect `Clock` by more than
  `heartbeatSkewAllowance` with `invalid_run`, so a runaway caller clock can
  neither steal a run from a fresh owner nor pin a lease past the stale
  cutoff. A reading behind the clock is still admitted, `requestCancel` keeps
  its literal timestamp, and `claimedAtMs` fence tokens stay unbounded.

## [1.0.0-rc.0] - 2026-09-01

### Added

- Split out of `@smthrs/journal`: `RunStore`, `AttemptStore`, and `Ownership`
  now live here, and the package owns the `flows_runs` and `flows_attempts`
  migrations. No schema or behavioral change; see
  `docs/pages/concepts/journal.md`.
- `Ownership` re-exports the `OwnerId` schema, which `@smthrs/journal` now
  defines because it is the fence `emitDurable` accepts.
- Package-owned generated API documentation and an explicit Node test subpath.
- Added the `0002_lineage` migration and the `CreateOptions` trampoline pair
  `lineageId` and `roundOrdinal`, read back on `RunRow`. Both absent means the
  run is a lineage of one, read as round 0 of itself.
- Added `RequestCancelOutcome.Terminal`, so a request that lost to an ending
  reports the status it lost to instead of claiming the row is gone.
- Added `ClaimAndOwnOutcome.EvidenceRequired` for a no-evidence claim against
  another live owner, which previously asserted a `SnapshotChanged` comparison
  that branch never performed.
- Added `StealOutcome.LivenessUnconfirmed` for evidence that does not match the
  expected owner, host relation, or observation time before any comparison.
- Added the `RunStoreMetrics` module: the `flows_run_claims`,
  `flows_run_transitions`, and `flows_run_heartbeats` counters plus one
  attributed view per operation outcome, including `abandon_claim` and
  `recover_claim`.
- Added `LivenessCheck`, `LivenessContext`, `leaseLiveness`,
  `sameHostIncarnation`, and `sameHostPidProbe`, so a deployment supplies its
  own liveness answer instead of the store guessing one.
- Added the `Heartbeat` leaf and its `@smthrs/run-store/Heartbeat` subpath, the
  one place `heartbeatInterval`, `heartbeatStaleAfter`,
  `heartbeatSkewAllowance`, and `heartbeatWriteTolerance` are related.
- Added `AttemptStore.Options` (`inProgressStates`, `maxCheckpointBytes`,
  `putMode`) with `makeWith` and `layerWith`.
- Added `AttemptStoreError.method`, so a refusal names the operation that
  produced it and its message reads `<code>: AttemptStore.<method>: <detail>`,
  matching `RunStoreError`.

### Changed

- Every caller timestamp is validated as a non-negative safe integer before it
  reaches SQL, so `NaN`, a fraction, or a negative reading fails with a typed
  `invalid_run` or `invalid_attempt` instead of a column-constraint error or a
  success-shaped refusal. The two clock sources are unchanged and now written
  down: evidence-bearing operations judge the caller's `nowMs` literally, while
  `create`, `activate`, and `transitionOwned` stamp from the Effect `Clock`.
- Run and attempt state now crosses an inert-JSON boundary before every write
  and after every read. It bounds shape, not size: accessors, `toJSON`, cycles,
  malformed text, excess depth, and excess nodes are refused, while run state,
  metadata, errors, and outcomes stay uncapped in bytes.
- Running snapshots require a complete owner and heartbeat pair; all other
  statuses reject either field, and terminal attempts and runs cannot reopen.
- Same-host PID checks now treat only `ESRCH` as proof of death and fail closed
  on invalid pids or unexpected host failures.
- `RunStore.heartbeat` writes `MAX(heartbeat_at_ms, now)`, so a pulse delayed
  past a newer one cannot move the lease backwards; `AttemptStore.heartbeat`
  does the same.
- `putMode: "upsert"` restates only a row that is still in progress. A finished
  attempt is immutable, and a re-put of one resolves `ExistingSame` or
  `Conflict` rather than reopening it.
- `put` compares an existing row structurally, so a re-put whose JSON carries
  the same content in a different key order resolves `ExistingSame` instead of
  `Conflict`.
- `transitionOwned` refuses `pending` as a target and validates its
  `TransitionGuard` at runtime, so a malformed guard fails instead of silently
  disabling the cancellation rule.
- `RunStoreErrorCode` no longer publishes `unknown`, a code no path in
  `RunStore` produced.
- `./migrations/*` is closed in the export map: the migration modules are
  implementation, reachable only through `Migrations.set`.

### Fixed

- Fenced mutations now validate exact identifiers, monotonic timestamps, and
  complete ownership tuples without retaining executable values in errors.
  A failure cause carries the shape of `state_json`, never its text.
- Cancellation, claim recovery, and attempt update races now resolve to typed
  contention or persistence outcomes instead of ambiguous missing rows.
- Identifiers carrying an unpaired UTF-16 surrogate are refused. SQLite maps
  them to `U+FFFD`, so two distinct run ids collided on one durable key.
- `requestCancel` maps an undecodable persisted status to a typed
  `decode_failed` failure instead of dying.
