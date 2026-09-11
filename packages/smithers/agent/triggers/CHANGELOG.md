# @smthrs/triggers

## [Unreleased]

### Added

- `TriggerStore.history` reads the fire ledger newest first, filtered by
  trigger, run, or outcome and paged by cursor and limit, so a listing can show
  what a trigger did without joining the runtime's run table.
- `TriggerStore.inspect` reads the run or reservation and the buffered
  occurrence one trigger holds without expiring anything.
- `TriggerStore.heartbeat` and `lastHeartbeat`, backed by the
  `0003_heartbeat` migration, record which scheduler host last polled the
  store. `Scheduler.Options.host` names the host; `Scheduler.defaultHost` is
  `"local"`. A heartbeat the store cannot record is logged and the tick goes on.
- `DispatchReader`, the `@smthrs/control` read port served from a
  `TriggerStore`, so `Control.list` can answer `triggers` and `fires` from the
  store the scheduler writes: last fire, buffered occurrence, active run, the
  next five occurrences, and the newest heartbeat.
- `TriggerStore.pruneFires({ olderThan })` deletes settled ledger rows older
  than a cutoff and answers how many it removed, keeping the buffered
  occurrence and the row naming the active run. Nothing else in the store
  deletes from `flows_trigger_fires`, so a host that never prunes keeps one row
  per occurrence for as long as the database lives.

### Changed

- `TriggerStore.list` answers `Listed` rows: the decode result for each row and
  the state that row holds. A row whose stored input cannot be decoded is
  isolated there, with its trigger id in the failure, rather than failing the
  whole listing, so one corrupt declaration no longer stops every healthy
  schedule in the store on every tick.
- A scheduler tick reads the listed row before it asks the store again. A
  trigger holding neither a run nor a buffered occurrence answers `activeRun`
  and `claimPending` by itself, which cost two write transactions per idle
  trigger per tick. `DispatchReader.list` takes each summary's held state from
  the same listing instead of inspecting per trigger.
- The guides, the claim-protocol concept, and the `Service` documentation say
  that a tick polls `list` rather than `listEnabled`, because a trigger
  disabled while a run was active still has to recover that occurrence, and
  that only claim, result, pending-state, and active-run methods fail with
  `unknown_trigger`: `get` answers `None` and `register` creates the row.

- Both trigger stores now apply one claim decision. The revision and enabled
  fences, the expired-reservation reclaim with its supersede predecessor
  lookup, the three resumable predicates, the cursor advance, and the lease
  recovery behind `activeRun` were written out once in SQL and again over maps;
  each store now gathers its snapshot, calls the shared decision, and applies
  the writes it answers.
- `test/TestTriggers` registration validates the declaration and serializes its
  input at the call boundary, the way SQL registration already did, so a
  declaration mutated after `register` returns cannot change what was stored
  and an unsatisfiable schedule is refused rather than accepted. Its `list` and
  `listEnabled` order by id, and every reading is an independent value that
  cannot be mutated back into stored state.
- The testing guide, the reference, the claim-protocol concept, and the README
  state what the in-memory store shares with the SQL store and where it stops:
  it holds one process's state, reports no `store` write failures, shows no
  contention between connections, and applies no migrations.

### Removed

- `TriggerStore.takePending`. Nothing dispatched through it: the scheduler
  takes a buffered occurrence with `claimPending`, which applies the claim
  fences in the same transaction, and reads one without consuming it through
  `inspect`. A destructive read beside those was one more method every store
  had to implement and one more way to drop a buffered occurrence with no
  claim decision behind it.

## [1.0.0-rc.0] - 2026-09-01

### Added

- Added Effect Cron-backed declarations, overlap and bounded catch-up
  policies, durable CAS fire claims, a scoped scheduler, authority-free
  channels, and verified raw-byte webhooks.

### Changed

- A fire claim now carries `expectedRevision` and reads the overlap policy,
  `enabled`, and `revision` inside the claim transaction, so a caller holding a
  declaration snapshot from before an edit is refused with `revision_mismatch`
  or `trigger_disabled` instead of firing it.
- `TriggerStore.due(now)` is now `TriggerStore.listEnabled()`. The parameter was
  accepted and discarded; due-ness is a cron computation the scheduler performs
  against its own watermark.
- A webhook `credential` is required and is forwarded to `Channel.Verify` and to
  `Webhook.SignatureConfig.expected` on every request, so a signing secret is
  resolved through the host resolver rather than captured in a closure at
  declaration time. `expected` returns an Effect, so a resolution or HMAC
  failure is a typed `verification_failed` rather than a defect.
- `Webhook.ingest` copies `body`, `headers`, and `idempotencyKey` before
  verification, so verification, delivery fingerprinting, and decoding all read
  one private snapshot. It no longer registers the channel on every request;
  registration is `Webhook.register`.
- `Webhook.constantTimeEqual` iterates over the expected signature's length
  rather than the longer of the two inputs, so its work is fixed by the secret
  side of the comparison.
- Error codes gained `runner`, `invalid_options`, `trigger_disabled`, and
  `revision_mismatch`, and `TriggerError` gained `path`. A declaration failure
  names its offending field and summarizes the schema issue tree instead of
  carrying a five-kilobyte AST as its cause.
- `last_fired_at_ms` only ever moves forward, so an older run settling after a
  newer occurrence was skipped no longer replays settled work.
- Scope closure detaches run monitors instead of cancelling them: scheduled runs
  are durable and the next incarnation re-attaches to them.
- `Cron.occurrencesBetween` caps an unstated limit at `Cron.maxOccurrences` and
  refuses a limit that is not a non-negative safe integer.
- `Schedule.maxCatchUp` defaults to `0` and is bounded above by
  `Schedule.maxCatchUpLimit`. Every catch-up policy answers to it, `one`
  included.
- `TriggerStore.Claim` is a discriminated union: a claim that hands the caller
  work to launch carries a required `reservationId`, and a claim that only
  records a decision carries none.
- `TriggerStore.Service` gained `activeOccurrence(triggerId, runId)`, and
  `TriggerStore.reservationOccurrence` reads the occurrence out of a reservation
  id. A recovered run is settled against the occurrence it actually launched,
  which `lastFiredAt` cannot name once a later occurrence has been skipped or
  buffered past it.
- A supersede claim records the run it is displacing on the occurrence that
  displaced it, so a claimant that dies before it can cancel leaves the
  predecessor's run id behind for the next incarnation to find.
- The package documentation is colocated and hand-maintained.
  `packages/smithers/agent/triggers/README.md`, its `docs/` directory, and the
  JSDoc in `src/` own the contract. The `docs` and `docsFiles` targets in
  `PACKAGE.ts` expose them, and `apps/site/scripts/sync-api-docs.mjs` owns the
  site copy.

### Fixed

- A run held at Control's `accepted` status is no longer recorded as completed
  on the next poll, which had released the overlap guard for a run that had not
  started.
- A newly registered trigger no longer fires an arbitrarily stale past
  occurrence under `catchUp: "none"`; its first sight establishes the watermark.
- A launch reservation recovered from the store is no longer cleared on the
  following tick before its lease expires.
- The occurrence watermark advances only past occurrences this process finished
  dispatching, and a buffered occurrence taken from the row is re-armed when the
  claim or dispatch that followed it failed.
- `TriggerStore` failures no longer collapse into `store`: a typed refusal the
  store raised travels out unchanged, and every missing-row path in both the SQL
  store and the in-memory test layer fails with `unknown_trigger`.
- A parked plan is re-offered a bounded number of times rather than once a
  second for the life of the scope, and a scheduler poll interval must be finite
  and positive.
- A schema the migrator cannot apply arrives as a typed `store` failure instead
  of a defect that escapes a constructor whose signature promises
  `TriggerError`.
- A launch no longer resolves the wrong `started` handle. An inner binding
  shadowed the `Deferred` the launch awaits, so `Deferred.succeed` was handed the
  run id string: every scheduler tick that launched a run waited forever.
- A recovered launch reservation is re-read from the store on every tick rather
  than cached as live, so its lease can expire and re-arm the occurrence it
  holds instead of pinning the trigger until the process restarts.
- An expired reservation over an occurrence that was claimed but never launched
  re-arms that occurrence instead of leaving it with no outcome, no active run,
  and nothing pointing at it.
- `claimPending` clears the buffer only when the claim it made is not itself a
  buffer, so an occurrence the overlap policy re-buffers is no longer discarded.
- A supersede whose cancellation fails restores the run it displaced and queues
  the replacement occurrence, and it records the terminal result before it
  detaches the only monitor that could have written one.
- A launch whose `launched` result cannot be persisted is left to a later poll
  rather than recorded failed while its run is still executing.
- A terminal result carrying no run id no longer clears a newer run's active
  pointer.
- Coverage thresholds are 100 on all four metrics. The ratchet that stood at
  68/67/81/80 is what let every defect above ship untested.
- The CommonJS build no longer hands the migrator `{ default }` objects instead
  of migration Effects. esbuild compiles a default import of a sibling ESM
  module to `__toESM(require(...), 1).default`, which under Node interop is the
  whole exports object, so `require("@smthrs/triggers/SqlTriggerStore")` failed
  at the first migration. The migration modules export `triggers` and
  `reservationLease` by name, `migrations/index.ts` imports them by name, and
  the record is exported as `migrations` so a test can assert each entry has
  `pipe`.

### Removed

- `@smthrs/triggers/migrations/*` is no longer a public subpath. The intended
  entry point is `SqlTriggerStore.layer`, which applies both migrations in
  order.
