# @smthrs/platform-cloudflare

## [Unreleased]

### Added

- `CloudflareRuntime.Options.retention`: a Durable Object's own engine store
  deletes its settled history as the runtime is built. One bounded
  `Retention.collect` pass from `@smthrs/engine-store`, over terminal runs that
  finished at least `olderThanMs` ago and no live run stands above or below,
  with the driven execution pinned; observed as
  `smithers.cloudflare.retention` and `smithers_cloudflare_retention_passes`
  and `smithers_cloudflare_retention_runs_deleted`, and never failing the
  execution.
- `CloudflareHost.layer`: the closed Host surface in a Worker or a Durable
  Object. WebCrypto as `effect/Crypto` (`WebCrypto.layer` from
  `@smthrs/crypto`), an `OwnerIdentity` with a drawn incarnation number, POSIX
  `Path`, Effect's fetch `HttpClient` with `redirect: "manual"`, and a
  `FileSystem`, `ChildProcessSpawner` and `Jj` that refuse every call as
  `not_installed`.
- `CloudflareRuntime.layer({ hostId, executionId }, registerFlows)`: the shared
  `Runtime.layer` from `@smthrs/flows` for one execution, over an injected
  `SqlClient`, with `sweep: { host: executionId }`, `canExecute` limited to that
  execution, and the unsupported step boundary and workspace sandbox. Its
  liveness check is `@smthrs/run-store`'s `Ownership.singleIncarnationLiveness`,
  so the next incarnation of a Durable Object takes a run over without waiting
  out the lease.
- `ExecutionObject.start`, `alarm` and `intent`: the per-execution Durable
  Object as functions over a structural slice of its storage. `start` stores the
  intent and arms the alarm before the caller's write; `alarm` counts the
  attempt and arms the next one a backoff away before it drives the execution
  once with `@smthrs/engine-store`'s `EngineStore.drive`, so a
  Durable Object reset in the middle of a step is driven again one backoff later,
  then settles, parks until the engine's next wake, or retries with backoff.
- `ExecutionObject.Router`, `ExecutionObject.wake` and `alarm`'s required
  `router` option: a child flow and the next round of a `.to()` handoff run on
  Durable Objects of their own. After each drive, `alarm` reads from the store
  which executions the drive created or made due, starts each new child or
  round on its own object with its intent, and wakes each parent whose child
  settled and each started child asked to cancel. A parked execution's alarm
  is armed, then `EngineStore.nextWake` is read again, so a wake that lands
  while the alarm runs is kept. `ExecutionObject.Services` adds `RunStore` and
  `DurableEngineState`, which `CloudflareRuntime.layer` already provides.
  `ExecutionObject.routed` (`smithers_cloudflare_execution_routed`) and
  `ExecutionObject.wakes` (`smithers_cloudflare_execution_wakes`) count them.
