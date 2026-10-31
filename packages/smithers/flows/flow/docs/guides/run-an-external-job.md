---
title: "Run an external job"
description: "Start external work once, park between probes, and reattach after a host restart."
sidebar:
  order: 8
---

`ExternalJob.make` composes recorded Start, Status, Collect and Cancel actions
with ordinary flow handoffs and durable timers. The adapter owns the external
worker; a parked Smithers execution owns no worker process scope.

```ts
import { Action, ExternalJob, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { RemoteChildProcessSpawner, Sandbox } from "@smthrs/sandbox"
import { Effect, Layer, Schema } from "effect"

const Build = ExternalJob.make("build/external", {
  payload: { source: Schema.String },
  handle: Sandbox.JobHandle,
  success: Sandbox.JobResult,
  error: Schema.Union([RemoteChildProcessSpawner.ProviderError, Sandbox.CaptureError]),
  probe: { every: "15 seconds", max: "2 minutes" },
  timeout: "2 hours",
  restarts: 1
})

// The provider adapter supplies create-or-get, observation, collection and
// cancellation. Convert cleanup transport errors to visible defects.
const adapter = Sandbox.job(provider, { command: "make" })
const buildLayer = Build.toLayer({
  ...adapter,
  cancel: (handle, key) => adapter.cancel(handle, key).pipe(Effect.orDie)
})

const Pipeline = Flow.make("build/pipeline", {
  payload: { source: Schema.String },
  success: Sandbox.JobResult,
  error: Build.errorSchema,
  body: Node.capture({ version: "build/pipeline/v1", build: Build._tag }, (payload) => Build.call(payload))
})

const implementations = Layer.mergeAll(buildLayer, Interpreter.layer(Pipeline))
  .pipe(Layer.provideMerge(Action.layerImplementations))
```

Use a retained provider. Supply the runtime and the adapter's services, including durable capture receipt
storage, to that layer. Declare the complete adapter failure union in `error`;
errors are encoded in durable action outcomes.

## Identity and replay

`Build.call` uses the existing child boundary, so each call has its own durable
execution identity. It does not inline the job into its caller. `.child` and
`.execute` also retain the ordinary flow APIs. Two calls with identical payloads
start separate jobs. `.execute` with the same execution id rejoins its lineage.

The initial action journals the enclosing job execution id and start time.
Adapters receive `<execution id>#g1`, then `#g2` for one allowed replacement.
The public payload cannot select an identity or supply a continuation handle.
`start` must atomically create-or-get by that key. Smithers replay alone cannot
make a provider's non-idempotent spawn safe.

Status actions have separate probe keys, while the provider receives the same
job key throughout one generation. Delays double from `probe.every` up to
`probe.max`, and stop at the original timeout deadline. That deadline is carried
through every generation and survives a host restart.

Each status read is given `{ waitMs }`, the time until the next probe is due.
An adapter that can wait for the work to end answers as soon as it does, so an
exit is seen when it happens; one that can't answers at once, and the durable
timer does the waiting. Either way the next probe is due `delay` after the
probe began.

## Run it from inside a step

`Build.run(payload, { executionId, operations, wait })` runs the job from inside
a step, such as an action's body or an agent's tool call, and answers its
success as `.execute` does. Pass the same operations `toLayer` was given.

```ts
const result = yield * Build.run({ source }, { executionId: `build:${callId}`, operations: adapter, wait: "1 minute" })
```

Work that ends within `wait` (`probe.max` unless set, at most `timeout`), and
before the drive's budget ends (`FlowRuntime.DriveDeadline`, which a hosted
engine's `budgetMs` sets for each step), is started, read and collected in
the step itself, under the key the first
generation uses (`<execution id>#g1`): the step's run never parks for it, and
no execution of the job is made. Anything else, a failure, a lost generation or
work still running when the wait is over, goes to the job's own execution under
the same key, which the step then waits on as `.execute` does; the provider
answers the handle it already gave and starts nothing. A step asked again after
a restart starts the same key, or joins the job an earlier attempt handed its
work to. Interrupted, it cancels the work only when its run was cancelled: a
host that stops leaves the work to the step's next attempt.

On Cloudflare a job's execution and each probe round live on their own Durable
Objects, and the run that asked parks and replays when the job settles. `run`
skips all of it for short work: on the platform's benchmark a command that exits
at once answers its caller in 0.1 s rather than 47 s
(`@smthrs/platform-cloudflare`, docs/guides/command-latency.md).

The deadline bounds every provider call, not only the probes. A Start reached
after the deadline, such as an engine retry or a restarted host's replay, never
calls `start`. A `start` or `collect` still running at the deadline is
interrupted; the generation is abandoned or cancelled, and the job fails
`ExternalJobTimedOut`.

## Replacement and cancellation

Status returns `Running`, `Exited` with `exitCode`, or `Lost`. `Exited` calls
`collect`. A collected exit can fail with `ExternalJob.Again` to request a
replacement. Both Lost and Again complete Cancel before a durable backoff and
the next Start. A failed cancellation cannot launch another worker.
`Again` is a dependency fault if it escapes the replacement boundary. A flow's
own `DeadlineExceeded` is a policy fault: its elapsed deadline is terminal.

Exhaustion fails with `ExternalJobLost` (`infra`). Timeout completes Cancel and
fails with `ExternalJobTimedOut` (`dependency`). `restarts: 0`, the default,
permits only the first generation. Adapter infrastructure errors retain their
declared type and use the runtime's repeat-safe retry policy.

`cancel` and `abandon` may fail with the adapter's declared error. Inside a
step the engine retries them as it retries `start`, so a stop the provider
could not record is never journaled as done and a replacement waits for it.

The deadline bounds each provider call, not the engine's retry waits: a
`start` that failed transiently and is retried after the deadline is abandoned
at that next attempt, so its abandonment can lag the deadline by one retry
backoff.

The actual flow scope retains `Flow.withRollback` cancellation. Timer parking,
replay and host release preserve the external worker. Explicit cancellation
cancels it, including a retained parked scope. The rollback is process-local
and has no step to retry in: it asks `cancel` or `abandon` once and logs a
failure by operation and key.

A generation parked between probes after its host stopped has no process that
holds its scope, so no rollback can run when a cancellation reaches it. The
job's observation declares its durable cancellation instead (`Flow.OnCancel`):
a store-backed engine that cancels the parked observation admits
`<tag>/stop` as its own run, execution id `cancel:<key>`, with the
observation's payload, before it commits the cancellation. Its one step is the
generation's `cancel`, retried like any step, so the stop reaches the provider
even when nothing held the job. A Durable Object host starts that run on an
object of its own. A generation stopped in process may therefore be asked to
`cancel` twice; `cancel` must be idempotent at the provider.

## Hosts that route by tag

`call` runs the job as its own child execution, each round hands off to
one of two private continuations, `<tag>/launch` and `<tag>/observe`, and a
cancellation of a parked observation starts `<tag>/stop`. A host that finds an
execution's flow by its tag, such as a Durable Object per execution, must list
all four: `[...otherFlows, ...Build.flows]`. Otherwise the child's object
refuses the job as an unknown flow and the job never starts, or a stop never
runs.

## Abandon a key that never returned a handle

A provider can admit a key and then fail to answer `start`: the acknowledgement
is lost, the run is cancelled, or the deadline passes while `start` is in
flight. Without a handle there is nothing to `cancel`. Implement
`abandon(payload, key)` beside `cancel` to stop the work by key.

Abandon runs when the run is cancelled, the deadline passes, or `start` fails
before it returned a handle. The provider must make `abandon` of a key it has
not admitted yet win over a later `start` of that key, because that `start` can
still be in flight. Without `abandon`, such a key is left to the provider.
