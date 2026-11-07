---
title: "API reference"
description: "Every public export of @smthrs/platform-cloudflare: the Host surface, the runtime for one execution, the per-execution Durable Object functions, the edge cache, and the container object's wake, terminal and session."
---

```ts
import {
  CloudflareHost,
  CloudflareRuntime,
  ContainerSession,
  ContainerTerminal,
  EdgeCache,
  ExecutionObject,
  SandboxObject
} from "@smthrs/platform-cloudflare"
```

The package has one entry point, its root. It imports no `node:` built-in and
no `cloudflare:` module, so it bundles for workerd and runs under Node.

## CloudflareHost

The closed Host surface for a Worker or a Durable Object.

### `CloudflareHost.layer`

```ts
const layer: Layer.Layer<CloudflareHost>
```

Provides `FileSystem`, `Path`, `ChildProcessSpawner`, `Jj`, `HttpClient`,
`Digest`, `SecureRandom` and `OwnerIdentity`. `Digest` and `SecureRandom` are
`WebCrypto.layer` from `@smthrs/crypto`. See [the Cloudflare Host surface](./concepts/host-surface.md) for what each one does.

A Worker's `fetch` goes through Cloudflare's network, which a Worker cannot pin
to checked addresses, and a Worker has no name resolver. So the web tools in
`@smthrs/std` (`Fetch`, `HttpPost`, `WebFetch`) refuse here with `unsupported`,
and `@smthrs/kernel`'s `HttpClient.ResolveHost` keeps its default, which
refuses every name. Smithers' destination check is never weakened to fit.

### `CloudflareHost.CloudflareHost`

```ts
type CloudflareHost =
  | FileSystem
  | Path.Path
  | ChildProcessSpawner
  | Jj.Jj
  | HttpClient
  | (EffectDigest.Digest \| SecureRandom.SecureRandom)
  | OwnerIdentity.OwnerIdentity
```

The services `layer` provides.

## CloudflareRuntime

### `CloudflareRuntime.layer`

```ts
const layer: <Registered, RegistrationError, RegistrationRequirements>(
  options: CloudflareRuntime.Options,
  registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>
) => Layer.Layer<…, RegistrationError, SqlClient | RegistrationRequirements>
```

The durable engine for one execution, with `registerFlows` registered:
`@smthrs/flows`' `Runtime.layer` over `CloudflareHost.layer`, with

- `owner: { hostId }` and `isAlive: Ownership.singleIncarnationLiveness` from
  `@smthrs/run-store`: an owner with the claimant's host id and another
  incarnation is an earlier incarnation of the same Durable Object, and dead;
  every other owner, the claimant included, is judged by its lease;
- `canExecute` true only for the run whose id is `executionId`;
- `sweep: { host: executionId }`: no background sweep and no lease renewal;
- `StepBoundary.layerUnsupported` and `WorkspaceSandbox.layerUnsupported`.

It provides everything `Runtime.layer` provides, `FlowRuntime`,
`EngineStore.Driver`, `RunStore` and `DurableEngineState` among them, and requires the `SqlClient` the engine
writes to (`@smthrs/database`'s `PostgresDatabase.layer`) and whatever
`registerFlows` needs beyond the engine. Build it inside the invocation that
drives the execution.

### `CloudflareRuntime.Options`

```ts
interface Options {
  readonly hostId: string
  readonly executionId: string
}
```

- `hostId`: the Durable Object, the same for every incarnation of it. Pass
  `ctx.id.toString()`.
- `executionId`: the one execution this runtime drives.

## ExecutionObject

The per-execution Durable Object, as functions a Durable Object delegates to.
See [the execution lifecycle](./concepts/execution-lifecycle.md).

### `ExecutionObject.start`

```ts
const start: <A, E, R, RS>(
  storage: ExecutionObject.Storage<RS>,
  value: ExecutionObject.Intent,
  effect: Effect.Effect<A, E, R>
) => Effect.Effect<A, E | ExecutionObject.IntentConflict, R | RS>
```

Stores the intent and arms the alarm at now plus `startGraceMs`, runs `effect`,
then moves the alarm to now. Returns `effect`'s result, or its failure
unchanged. The same intent again stores nothing and runs `effect` again;
another intent for the same object fails with `IntentConflict` before anything
is stored or run. An intent's `origin`, the door and actor kind `intent` read
from the caller's `RunMetrics.CurrentOrigin` (`@smthrs/flow`), is not part of
its identity: the alarm admits the run under it, so the run's usage metrics
carry it, and a second start with another origin is the same intent.

### `ExecutionObject.wake`

```ts
const wake: <RS>(storage: ExecutionObject.Storage<RS>) => Effect.Effect<boolean, never, RS>
```

Moves the alarm to now when an intent is stored and answers `true`; answers
`false` and arms nothing when none is. Another object's `alarm` calls it
through its `Router` when its drive made this execution due. So does whoever
completes a deferred the execution waits on, or cancels it.

### `ExecutionObject.alarm`

```ts
const alarm: <E, R, RS, RE = never, RR = never>(
  storage: ExecutionObject.Storage<RS>,
  options: {
    readonly flows: ReadonlyArray<Flow.Any>
    readonly runtime: (intent: ExecutionObject.Intent) => Layer.Layer<ExecutionObject.Services, E, R>
    readonly router: ExecutionObject.Router<RE, RR>
    readonly settledRetentionMs?: number | undefined
    readonly driveBudgetMs?: number | undefined
  }
) => Effect.Effect<ExecutionObject.Outcome, never, R | RS | RR>
```

Counts the attempt and arms the alarm one backoff away, builds
`runtime(intent)` in this alarm's scope, drives the flow named by the intent
once with `EngineStore.drive` within `driveBudgetMs` (default
`ExecutionObject.defaultDriveBudgetMs`, 600 seconds; the class passes
`ExecutionObject.driveBudget`), then routes:

- the round a handoff admitted, and the current round of each child lineage
  linked to the round just driven (to every round of the lineage once its
  last round settled): `router.start` with its intent, read from the store,
  when it is `pending` and due, and `router.wake` when it was started and is
  due now, such as one asked to cancel;
- when the execution settled and is the last round of its lineage, each parent
  due now: `router.wake`.

Then it clears the count and records when the execution settled, arming the
alarm for the end of its retention window (settled), or arms it for the
engine's next wake (parked), reading `EngineStore.nextWake` once more after
arming so a wake that landed during the alarm is kept, or arms it for now
(yielded: the drive spent its budget at a step boundary, see
[The drive budget](./concepts/execution-lifecycle.md#the-drive-budget)). Never fails: a failure,
a router call's included, is `Retrying`. `flows` must list every flow an
execution may start as a child or hand off to.

An object that recorded its settlement builds no runtime again. Before
`settledRetentionMs` (default `ExecutionObject.settledRetentionMs`, one day)
has passed since the settlement, its alarm arms itself for that moment and
answers `Settled`. After, it deletes the intent, the count and the settlement,
deletes the alarm and answers `Forgotten`: the object's storage is empty.

### `ExecutionObject.Router`

```ts
interface Router<E = never, R = never> {
  readonly start: (intent: ExecutionObject.Intent) => Effect.Effect<void, E, R>
  readonly wake: (executionId: string) => Effect.Effect<void, E, R>
}
```

How one object reaches another, both named by execution id: `start` calls
`ExecutionObject.start` on the object named by `intent.executionId` with
nothing for the caller's effect, and `wake` calls `ExecutionObject.wake` on the
object named by `executionId`. Both must be idempotent. Supply it over the
class's own namespace binding.

### `ExecutionObject.intent`

```ts
const intent: <F extends Flow.Any>(
  flow: F,
  options: { readonly executionId: string; readonly payload: Flow.PayloadSchema<F>["Type"] }
) => Effect.Effect<ExecutionObject.Intent, Schema.SchemaError, Flow.PayloadSchema<F>["EncodingServices"]>
```

Builds an intent, encoding the payload with the flow's own JSON codec, the one
`alarm` decodes it with. Fails with `SchemaError` for a payload the schema
refuses or an empty execution id.

### `ExecutionObject.Intent`

```ts
const Intent: Schema.Struct<{
  flow: Schema.NonEmptyString
  executionId: Schema.NonEmptyString
  payload: Schema.Json
}>
type Intent = typeof Intent.Type
```

What the object runs. It is stored as its canonical JSON, so equal intents are
equal strings.

### `ExecutionObject.Storage`

```ts
interface Storage<R = never> {
  readonly get: <A = unknown>(key: string) => Effect.Effect<A | undefined, never, R>
  readonly put: <A>(key: string, value: A) => Effect.Effect<void, never, R>
  readonly delete: (key: string) => Effect.Effect<boolean, never, R>
  readonly setAlarm: (scheduledTime: number) => Effect.Effect<void, never, R>
  readonly deleteAlarm: () => Effect.Effect<void, never, R>
}
```

The slice of Durable Object storage the functions use. An Alchemy
`DurableObjectState`'s `storage` satisfies it with `R = RuntimeContext`; a plain
object wraps its Promise methods in `Effect.promise`.

### `ExecutionObject.Outcome`

```ts
type Outcome =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Settled"; readonly forgetAtMs: number }
  | { readonly _tag: "Parked"; readonly wakeAtMs: number | null }
  | { readonly _tag: "Yielded" }
  | { readonly _tag: "Retrying"; readonly attempt: number; readonly retryAtMs: number; readonly failure: string }
  | { readonly _tag: "Forgotten" }
```

What one alarm did. `forgetAtMs` is when the settled object forgets its
intent. `Yielded` is a drive that spent its budget; the alarm is armed for
now. `failure` is the tag of what failed, never its message.

### `ExecutionObject.Services`

```ts
type Services = EngineStore.Driver | RunStore.RunStore | DurableEngineState.DurableEngineState
```

What `alarm` reads from the runtime it builds: `@smthrs/engine-store`'s
`EngineStore.Driver`, which `EngineStore.drive` uses, and the stores it reads
the next wake and the routes from. `CloudflareRuntime.layer` provides all three.

### `ExecutionObject.IntentConflict`

```ts
class IntentConflict extends Schema.TaggedError<IntentConflict>()(
  "@smthrs/platform-cloudflare/IntentConflict",
  { executionId: Schema.String, message: Schema.String }
)
```

### Constants

| Export                                   | Value                                                               | Meaning                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `ExecutionObject.intentKey`              | `"smithers/intent"`                                                 | The storage key the intent lives under.                                          |
| `ExecutionObject.failuresKey`            | `"smithers/failures"`                                               | The storage key the count of alarms without progress lives under.                |
| `ExecutionObject.settledKey`             | `"smithers/settled"`                                                | The storage key when the execution settled, in epoch ms, lives under.            |
| `ExecutionObject.settledRetentionMs`     | `86_400_000`                                                        | How long a settled object keeps its intent before it forgets it.                 |
| `ExecutionObject.startGraceMs`           | `5_000`                                                             | How long after `start` stores an intent its alarm fires if `start` dies.         |
| `ExecutionObject.retryPolicy`            | `RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 300_000 })` | The backoff between alarms without progress. Never gives up.                     |
| `ExecutionObject.defaultDriveBudgetMs`   | `600_000`                                                           | How long a drive keeps starting steps unless `alarm` is given another.           |
| `ExecutionObject.admittedStartTimeoutMs` | `2_000`                                                             | How long a child's start during its parent's drive waits before routing does it. |

`ExecutionObject.driveBudget` is a `Config.Config<number>`: the setting
`EXECUTION_DRIVE_BUDGET_SECONDS`, whole seconds from 1 to 899, as
milliseconds, and `defaultDriveBudgetMs` when unset. Any other value fails with
a `ConfigError`. The Durable Object class reads it once and passes it to every
`alarm` as `driveBudgetMs`.

### Metrics

| Export                          | Name                                                                            | Attributes                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `ExecutionObject.starts`        | `smithers_cloudflare_execution_starts`                                          | `outcome`: `accepted`, `duplicate`, `conflict` or `failed`                   |
| `ExecutionObject.alarms`        | `smithers_cloudflare_execution_alarms`                                          | `outcome`: `idle`, `settled`, `parked`, `yielded`, `retrying` or `forgotten` |
| `ExecutionObject.driveDuration` | `smithers_cloudflare_execution_drive_duration` (ms histogram, buckets to 900 s) | `outcome`: `settled`, `parked`, `yielded`, `unfinished` or `failed`          |
| `ExecutionObject.routed`        | `smithers_cloudflare_execution_routed`                                          | `route`: `start`, `wake` or `admitted`, counted per successful call          |
| `ExecutionObject.wakes`         | `smithers_cloudflare_execution_wakes`                                           | `outcome`: `armed` or `idle`                                                 |

Each `alarm` span carries `smithers.execution.started` and
`smithers.execution.woken`, the counts it routed, and, when it drove, its span
and log line carry `smithers.execution.drive_ms`; each `wake` runs in a
`cloudflare.execution.wake` span with `smithers.execution.wake`.

Each `cloudflare.execution.alarm` line and span also says what the alarm cost:

| Field           | Value                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `durationMs`    | How long the alarm took, in whole milliseconds.                                                                               |
| `events`        | The journal entries it committed (`@smthrs/journal` `JournalMetrics.tally`).                                                  |
| `transactions`  | Its write transactions that took the database's writer lock, each retry counted (`@smthrs/database` `DatabaseMetrics.tally`). |
| `schemaWide`    | How many of those held the whole schema's lock, so committed alone.                                                           |
| `lockWaitMs`    | How long those transactions waited for the lock in total, in whole milliseconds.                                              |
| `maxLockWaitMs` | Longest individual client-side acquisition, including transaction open, retries and network time.                             |

## ObjectDatabase

The durable engine's `SqlClient` in a SQLite-backed Durable Object's own
storage, through Effect's `@effect/sql-sqlite-do` client: a host whose
executions each run on one object needs no database server.

### `ObjectDatabase.layer`

```ts
layer(storage: ObjectDatabase.Storage): Layer.Layer<SqlClient.SqlClient>
```

Pass the object's `ctx.storage`, and provide the layer to
`CloudflareRuntime.layer` in the alarm that drives the execution:

```ts
ExecutionObject.alarm(storage, {
  flows: [Reply],
  runtime: (intent) =>
    CloudflareRuntime.layer({ hostId: ctx.id.toString(), executionId: intent.executionId }, registration).pipe(
      Layer.provide(ObjectDatabase.layer(ctx.storage))
    ),
  router
})
```

- Statements run one at a time, as the object's storage does.
- SQLite in a Durable Object refuses `BEGIN` and `SAVEPOINT`, so every
  transaction runs in `storage.transaction()`, which holds the object's input
  gate until it ends. The engine's read transactions run there too, registered
  with `@smthrs/database`'s `Dialect.registerReadTransaction`; unlike SQLite's
  deferred `BEGIN`, one excludes writers, so never wait inside one for a
  write.
- Each execution's journal stays on its own object. A child flow or a handoff
  round runs on an object of its own, whose store its parent cannot read: use
  the shared Postgres for flows that start children.

`test/ObjectDatabaseWorkerd.test.ts` (with `FLOWS_WORKERD_SMOKE=1`) runs a
flow from real alarms on the real storage, including a reset inside a step
that a new incarnation finishes.

### `ObjectDatabase.Storage`

`ctx.storage` of a SQLite-backed Durable Object: its `sql` and its
`transaction`.

## EdgeCache

`@smthrs/artifacts`' `ImmutableCache` over the Workers Cache API. Use it for
content that never changes at its key, such as a repository's tree or file at a
commit SHA: a hit costs no read from the source.

### `EdgeCache.layer`

```ts
const layer: (options?: Options) => Layer.Layer<ImmutableCache, ImmutableCacheError>

interface Options {
  readonly name?: string
  readonly maxEntryBytes?: number
  readonly caches?: CacheStorage
}

interface CacheStorage {
  readonly default?: ImmutableCache.WebCache
  readonly open: (name: string) => Promise<ImmutableCache.WebCache>
}
```

| Option          | Default                | Meaning                                                                                               |
| --------------- | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `name`          | none: `caches.default` | A named cache from `caches.open(name)`, apart from `caches.default`, which the zone's `fetch` shares. |
| `maxEntryBytes` | 8 MiB                  | The largest entry stored; a larger `put` answers `too_large`.                                         |
| `caches`        | the global `caches`    | The `CacheStorage` to use instead. Tests inject one that refuses.                                     |

The layer's telemetry and errors are labelled `cloudflare`. Without a `caches`
global, or without `caches.default` when no `name` is given, or when
`caches.open` rejects, the layer fails with `ImmutableCacheError` and reason
`unavailable`.

```ts
import { ImmutableCache } from "@smthrs/artifacts"
import { EdgeCache } from "@smthrs/platform-cloudflare"

const blob = ImmutableCache.readThrough(
  ImmutableCache.key("repo.blob", repo, sha, path),
  readBlob(repo, sha, path) // a failure, such as a spent budget, is never stored
).pipe(Effect.provide(EdgeCache.layer({ name: "repo" })))
```

What the Workers Cache API means for it:

- **One data center.** An entry lives in the data center that stored it and is
  not replicated, so each data center misses once.
- **Eviction.** Cloudflare may evict any entry; a `get` then misses.
- **Subrequests.** Each `get` and `put` counts toward the request's subrequest
  limit (50 on Workers Free, 1,000 on Paid), as `fetch` does.
- **Cache-Control.** Each stored response carries `Cache-Control: public,
  max-age=31536000, immutable`; without it the Workers cache stores nothing.
- **Previews.** The dashboard editor and Playground previews ignore every Cache
  API call, so there every `get` misses.

## SandboxObject

What a container Durable Object runs before it uses its container. See
[attach a terminal to a container](./guides/attach-a-terminal-to-a-container.md).

### `SandboxObject.wake`

```ts
const wake: <F, E, R>(
  machine: SandboxObject.Machine<F, E, R>,
  options: SandboxObject.WakeOptions<F>
) => Effect.Effect<SandboxObject.WakeOutcome, E, R>

interface WakeOptions<F> {
  readonly intercepts: ReadonlyArray<{ readonly host: string; readonly fetcher: F }>
  readonly instance?: SandboxObject.Instance | undefined
  readonly startTimeoutMs?: number | undefined
  readonly inactivityTimeoutMs?: number | undefined
  readonly egress?: F | undefined
}

type WakeOutcome = "started" | "running"

type Instance = "lite" | "basic" | "standard-1" | "standard-2" | "standard-3" | "standard-4" | {
  readonly vcpu: number
  readonly memoryMib: number
  readonly diskMb: number
}
```

1. Starts the container with `{ enableInternet: false }`, and `instance` when
   given, when `running` is false. Without `instance`, Cloudflare starts it on
   `lite`: 1/16 vCPU, 256 MiB of memory and 2 GB of disk. A start that runs
   past `startTimeoutMs` is abandoned and fails `SandboxObject.StartTimedOut
   { timeoutMs }`, a typed error a caller can settle on, counted in
   `smithers_cloudflare_sandbox_start_timeouts`; without it the start is
   unbounded.
2. Arms the inactivity timeout: `inactivityTimeoutMs`, default
   `SandboxObject.defaultInactivityTimeoutMs` (30 minutes).
3. Registers each intercept with `interceptOutboundHttp(host, fetcher)`, in
   order, then, with `egress`, every other request: `interceptAllOutboundHttp(egress)` and
   `interceptOutboundHttps("*", egress)`. HTTPS reaches the egress decrypted through the container's per-instance CA,
   which the box must trust. Without `egress` the box reaches only its intercepted hosts.

It runs all three on every call, so a restarted object, or one that died
between its start and its registration, gets its timeout and intercepts back.
It keeps no state and runs no timer or retry. A failure is the container
client's own error, unchanged; the `sandbox.wake` span and the
`cloudflare.sandbox.wake` log line carry only its tag.

### `SandboxObject.rearm`

```ts
const rearm: <F, E, R>(
  machine: Pick<SandboxObject.Machine<F, E, R>, "running" | "setInactivityTimeout">,
  inactivityTimeoutMs?: number
) => Effect.Effect<"rearmed" | "stopped", E, R>
```

Re-arms the inactivity timeout of a container that runs, to
`inactivityTimeoutMs` (default 30 minutes), and starts nothing; `stopped` when
the container isn't running. A Durable Object that restarts, after a deploy
for one, starts with no timeout, and Cloudflare then stops its container
shortly after the object goes idle, even while a process runs in it. Call it
once per incarnation, in the object's constructor, and on each use that
doesn't call `wake`. A failure is the container client's own error,
unchanged; the `sandbox.rearm` span and the `cloudflare.sandbox.rearm` log
line carry only its tag.

### `SandboxObject.run`

```ts
const run: <E, R>(
  container: ContainerTerminal.Container<E, R>,
  argv: Array<string>,
  options?: { readonly user?: string | undefined; readonly env?: Record<string, string> | undefined }
) => Effect.Effect<number, E, R>
```

Runs `argv` in the running container to completion and answers its exit code;
a nonzero one is an answer, not a failure. `user` is a numeric `uid:gid` (the
image's user when absent) and `env` the variables beyond the image's `PATH`.
Standard output and error are `ignore`d, never piped: workerd's exec pipes hold
no bytes, so a command writing to a pipe nobody reads blocks on its first write
and its exit code never comes. One line of warning on stderr is enough. Run a
command whose output matters through `ContainerSession`. The process belongs to
the call's own scope. A failure is the container client's own error, unchanged.

### `SandboxObject.Machine`

```ts
interface Machine<F, E = never, R = never> {
  readonly running: Effect.Effect<boolean, E, R>
  start(
    options: { readonly enableInternet: false; readonly instance?: SandboxObject.Instance }
  ): Effect.Effect<void, E, R>
  setInactivityTimeout(durationMs: number): Effect.Effect<void, E, R>
  interceptOutboundHttp(addr: string, binding: F): Effect.Effect<void, E, R>
  interceptAllOutboundHttp(binding: F): Effect.Effect<void, E, R>
  interceptOutboundHttps(addr: string, binding: F): Effect.Effect<void, E, R>
}
```

The slice of an Effect container client `wake` uses. An Alchemy Durable
Object's container handle satisfies it, with `F` Alchemy's `Fetcher`, `E` its
start and container errors and `R = RuntimeContext`.

### Metrics

| Export                        | Name                                         | Attributes                                  |
| ----------------------------- | -------------------------------------------- | ------------------------------------------- |
| `SandboxObject.wakes`         | `smithers_cloudflare_sandbox_wakes`          | `outcome`: `started`, `running` or `failed` |
| `SandboxObject.rearms`        | `smithers_cloudflare_sandbox_rearms`         | `outcome`: `rearmed`, `stopped` or `failed` |
| `SandboxObject.startTimeouts` | `smithers_cloudflare_sandbox_start_timeouts` | none                                        |

## ContainerTerminal

A browser terminal on a tmux session in a Durable Object's container, over
`@smthrs/sandbox`'s `TerminalProtocol`. See
[attach a terminal to a container](./guides/attach-a-terminal-to-a-container.md).

A user is a numeric `uid:gid`, such as `1000:2000`. A deployed container's
`exec` refuses a user name and runs a bare `uid` as root; local Docker accepts
both, so a name would pass in development and fail in production. A command
started with `exec` inherits only `PATH` from the image, so pass the shell's
`HOME`, `USER` and `LANG` in `env`.

### `ContainerTerminal.ensureSession`

```ts
const ensureSession: <E, R>(
  container: ContainerTerminal.Container<E, R>,
  options: {
    readonly name: string
    readonly user: string
    readonly cwd: string
    readonly env?: Readonly<Record<string, string>> | undefined
  }
) => Effect.Effect<"created" | "existing", E | ContainerTerminal.InvalidSession | ContainerTerminal.SessionFailed, R>
```

As `user`, under `env` with `TERM` `xterm-256color`, runs `tmux has-session -t
=<name>`, and when it fails, `tmux new-session -d -s <name> -c <cwd>`, each as
an argument vector with no shell. The user's tmux server, started by its first
session, hands `env` to every shell it starts. A session another caller
created meanwhile counts as `existing`. It fails with `InvalidSession` before
running anything when `name` is not a lowercase UUID, `user` is not a numeric
`uid:gid` or its uid is 0, or `cwd` is not an absolute
path of letters, digits, `.`, `_`, `-` and `/`; with `SessionFailed` when no
session runs after `new-session`; and with the container's error when `exec`
fails. Its span is `terminal.session`.

### `ContainerTerminal.attach`

```ts
const attach: <E, R>(
  container: ContainerTerminal.Container<E, R>,
  socket: ContainerTerminal.Socket,
  options: {
    readonly name: string
    readonly user: string
    readonly access: "write" | "read"
    readonly cols: number
    readonly rows: number
    readonly env?: Readonly<Record<string, string>> | undefined
  }
) => Effect.Effect<ContainerTerminal.Report, never, R>
```

Bridges an accepted server WebSocket to a new tmux client on a
pseudo-terminal of `cols` by `rows`, until one side ends. It never fails.

- **The client.** A writer's is `tmux attach-session -t =<name>` with piped
  stdin; a reader's adds `-f read-only,ignore-size` and has no stdin, so it
  neither types nor sizes the window. Both run as `user` under `env`, with
  `TERM` always `ContainerTerminal.clientTerm` (`xterm-256color`). `LANG`
  set to a UTF-8 locale tells the client the terminal speaks UTF-8.
- **Output.** `ready {access}` first, then the shell's output as binary
  frames of at most `TerminalProtocol.maxFrameBytes` (64 KiB), in order.
- **Input.** A writer's binary frames (an `ArrayBuffer`, a typed array or a
  `Blob`) go to stdin, and its `resize` resizes the pseudo-terminal. A
  reader's binary frames and resizes are dropped.
- **Refusals.** A frame over the cap closes with `CloseCode.tooBig` (1009); a
  malformed control frame, or a frame that is neither text nor binary, with
  `CloseCode.unsupported` (1003). Invalid options close with 1003 before
  anything runs.
- **The end.** When the tmux client exits, the viewer gets `ended {reason:
  "closed"}` and `CloseCode.ended` (1000). When the viewer leaves, or a
  refusal or failure closes the socket, `attach` SIGKILLs only its own tmux
  client and waits for its exit; the session keeps running. A failed `exec`,
  stdin, resize, `Blob` read or output stream closes with `CloseCode.failed`
  (1011), after which the viewer reconnects.

Start it right after `accept()`, never `acceptWebSocket()`, and run it in the
background for the socket's lifetime.

### `ContainerTerminal.Report`

```ts
interface Report {
  readonly outcome: "ended" | "closed" | "unsupported" | "too_big" | "failed"
  readonly closeCode: number | null
  readonly bytes: { readonly in: number; readonly out: number; readonly dropped: number }
}
```

`closeCode` is `null` when the viewer closed the socket first. `bytes` counts
what went to the shell, to the viewer, and was dropped from a reader.

### `ContainerTerminal.Container` and `ContainerTerminal.Process`

```ts
interface Container<E = never, R = never> {
  exec(cmd: Array<string>, options?: ExecOptions): Effect.Effect<Process<E, R>, E, R | Scope.Scope>
}

interface Process<E = never, R = never> {
  readonly stdin: Sink.Sink<unknown, Uint8Array, unknown, E, R> | undefined
  readonly stdout: Stream.Stream<Uint8Array, E, R> | undefined
  readonly exitCode: Effect.Effect<number, E, R>
  kill(signal?: number): Effect.Effect<void, E, R>
  resize(cols: number, rows: number): Effect.Effect<void, E, R>
}

interface ExecOptions {
  readonly user?: string
  readonly env?: Record<string, string>
  readonly pty?: { readonly cols: number; readonly rows: number }
  readonly stdin?: "pipe"
  readonly stdout?: "pipe" | "ignore"
  readonly stderr?: "pipe" | "ignore" | "combined"
}
```

The slice of an Effect container client the functions use. An Alchemy Durable
Object's container handle satisfies it with `E = ContainerError` and
`R = RuntimeContext`.

### `ContainerTerminal.Socket`

```ts
interface Socket {
  send(message: string | ArrayBuffer | Uint8Array): void
  close(code?: number, reason?: string): void
  addEventListener(
    type: "message" | "close" | "error",
    listener: (event: { readonly type: string; readonly data?: unknown }) => void
  ): void
}
```

The slice of a server WebSocket `attach` uses: the server side of
`new WebSocketPair()`, already accepted.

### `ContainerTerminal.isSessionName`

```ts
const isSessionName: (value: string) => boolean
```

Whether `value` is a lowercase UUID, the only session name the functions
accept. A Worker can check a terminal id from a URL before it upgrades.

### `ContainerTerminal.isSessionUser`

```ts
const isSessionUser: (value: string) => boolean
```

Whether `value` is a numeric `uid:gid` whose uid is not 0, the only user the
functions accept.

### Errors

```ts
class InvalidSession extends Schema.TaggedError<InvalidSession>()(
  "@smthrs/platform-cloudflare/InvalidSession",
  { field: Schema.Literals(["name", "user", "cwd", "size"]), message: Schema.String }
)

class SessionFailed extends Schema.TaggedError<SessionFailed>()(
  "@smthrs/platform-cloudflare/SessionFailed",
  { name: Schema.String, exitCode: Schema.Number, message: Schema.String }
)
```

### Metrics

| Export                           | Name                                         | Attributes                                                        |
| -------------------------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| `ContainerTerminal.sessions`     | `smithers_cloudflare_terminal_sessions`      | `outcome`: `created`, `existing` or `failed`                      |
| `ContainerTerminal.connects`     | `smithers_cloudflare_terminal_connects`      | `access`, and `outcome` as in `Report`                            |
| `ContainerTerminal.sessionsOpen` | `smithers_cloudflare_terminal_sessions_open` | `access`; up at `ready`, down when the attach ends                |
| `ContainerTerminal.bytes`        | `smithers_cloudflare_terminal_bytes`         | `direction`: `in`, `out` or `dropped`; a count, never the content |

No metric attribute holds an id. Each `attach` runs in a `terminal.connect`
span with `smithers.terminal.id`, `smithers.terminal.access`,
`smithers.terminal.outcome`, `smithers.terminal.close_code` and the three byte
counts, and logs one `cloudflare.terminal.connect` line inside it.

## ContainerSession

A container Durable Object's container as `@smthrs/sandbox`'s `Sandbox.Session`, so `SandboxTools`,
`Sandbox.layerHost` and every other session consumer run on it.

```ts
import { ContainerSession } from "@smthrs/platform-cloudflare"
import { SandboxTools } from "@smthrs/sandbox"

const session = yield* ContainerSession.make(box, {
  id: branchId,
  workdir: "/workspace",
  user: "100123:2000",
  env: { HOME: "/home/p1a2b3", USER: "p1a2b3", LANG: "C.UTF-8" }
})
const status = yield* SandboxTools.execute(session, { tool: "status" }, { callId, callsDirectory: "/home/p1a2b3/.smithers/calls" })
```

### `ContainerSession.make`

```ts
declare const make: <E, R>(
  container: ContainerSession.Container<E, R>,
  options: ContainerSession.Options
) => Effect.Effect<Sandbox.Session, never, R>
```

- Every command runs as `sh -c <command>` as `options.user`, a numeric `uid:gid` such as `1000:2000` or `0:0` (the
  image's user when absent), in `options.workdir` unless the command names a `cwd`; a relative `cwd` is under the
  workdir. A deployed container's `exec` refuses a user name and runs a bare `uid` as root, so a session given anything
  but `uid:gid` fails every command with `ProviderError` code `spawn_error` before it reaches the container.
- `options.env` reaches every command, under the command's own variables. A command inherits only `PATH` from the
  image, so `env` carries the rest, such as `HOME`.
- A command's input is fed beside its output, so one that writes before it has read all its input doesn't stall.
- `readFile` and `writeFile` are commands (`cat`), so the container needs only `sh` and `cat`; `readFile` of an absent
  path or a directory fails `not_found`, and `writeFile` makes the file's directories.
- `ping` runs `true`.
- It starts nothing: wake the container (`SandboxObject.wake`) before handing the session out. A failure of the
  container itself is a `ProviderError` with code `unavailable`, naming the operation, never the command or a path,
  and logs `cloudflare.container_session` with the `operation` (`exec`, `stdout`, `stderr`, `exit`) and the failure's
  tag as `error.type`, never its text.

### `ContainerSession.Container`, `ContainerSession.Process` and `ContainerSession.ExecOptions`

The slice of an Effect container client `make` uses: `exec(argv, { user?, cwd?, env?, stdin?: "pipe", stdout: "pipe",
stderr: "pipe" })` returning a process with `stdin` (a sink; completing it closes the input), `stdout`, `stderr` and
`exitCode`. An Alchemy Durable Object's container handle satisfies it with `R = RuntimeContext`.
