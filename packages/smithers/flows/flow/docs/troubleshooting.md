---
title: "Troubleshooting"
description: "The refusals @smthrs/flow raises, sorted by the symptom you see: what caused each one and what to change."
---

Every entry here is a real refusal this package or the engine beneath it raises.
They are grouped by where you meet them: at compile time, while a plan is built,
while a run executes, and at declaration time.

## Compile time

### The type says `Action.Requirement<"...">`

**Symptom.** `Flow.execute` does not typecheck, and the requirement channel names
an action tag.

**Cause.** The body calls a declared action whose implementation the composition
does not provide. That is the requirement channel doing its job: planning is
requirement-free, and asking to run a plan is what makes the missing layer a
compile error.

**Fix.** Merge `TheAction.toLayer(...)` into the composition. If the action is a
system declaration such as `Sleep.action`, the compiler will not ask, but the run
still needs `Sleep.layer`.

## While the plan is built

### `GraphBuildError` with code `planned_value_computed`

**Symptom.** A throw naming a node and a property path, saying the value was
computed at plan time by `toString`, `valueOf`, `toJSON`, or `Symbol.toPrimitive`.

**Cause.** The body did arithmetic on, interpolated, or serialized a step result.
A body runs at plan time, so that value does not exist yet.

**Fix.** Compute with `Node.map`, decide with `Node.branch`, or pass the value
into a payload. Field access is allowed; it records a reference path.

### `GraphBuildError` with code `recursion_requires_boundary`

**Symptom.** A throw when a flow's body calls the flow itself with `.call()`.

**Cause.** Inline expansion splices the callee's body into the caller's plan, and
a self-call would never terminate.

**Fix.** Use `flow.to(payload)` for a loop, or `flow.child(payload)` for a nested
execution. See [Run a flow as a child execution](./guides/run-a-child-flow.md).

### `GraphBuildError` with code `placement_requires_boundary`

**Cause.** An inline callee declares a `Flow.Placement` the enclosing flow cannot
satisfy. Placement is a property of an execution.

**Fix.** Call the callee with `flow.child(payload)` so it gets its own execution.

### `GraphBuildError` with code `duplicate_node`

**Cause.** Two structural graph addresses resolved to one durable node id. A node
id is dispatch identity, so two nodes answering to one address would let a later
settlement overwrite an earlier one.

**Fix.** Give the colliding sites distinguishable addresses, usually by naming
`Node.all` members distinctly rather than reusing one key.

### `GraphBuildError` with code `graph_too_deep` or `payload_too_deep`

**Cause.** Topology or a payload nested past the build bound. The build walks
with an explicit stack and refuses at a bound rather than overflowing the native
stack without a typed error.

**Fix.** Split the topology with `.child()` boundaries or trampoline handoffs, or
flatten the payload.

## While a run executes

### `InterpreterError` with code `unresolved_action`

**Symptom.** A run refuses to start, naming a flow and a node.

**Cause.** An action the body names has no implementation the runtime can
resolve, in either of two ways. The layer is genuinely missing, or
`Action.layerImplementations` was merged **beside** the implementation layers
rather than provided **under** them, so an implementation had no table to file
itself in.

**Fix.**

```ts
Layer.mergeAll(TheAction.toLayer(run), Interpreter.layer(TheFlow)).pipe(
  Layer.provideMerge(Action.layerImplementations)
)
```

This is also what a missing `Sleep.layer`, `WaitFor.layer`, `HumanTask.layer`, or
`Poll.layer` looks like, because those are system declarations the compiler never
asked you for.

### `InterpreterError` with code `unresolved_reference`

**Cause.** A payload reads a node this graph does not hold, usually a planned
value captured from a different build.

**Fix.** Build the reference inside the body that consumes it.

### `Flow.ExecutionIdRequired`, as a defect

**Symptom.** A run dies before it starts, naming the flow.

**Cause.** The opt-in derived source is installed and the payload has no canonical form: a non-finite
number, a lone surrogate, or a cycle. A served resume dies with it for a different reason: the
`ExecutionIdScope` on the `FlowProxyServer` layer returned `undefined` for the request.

**Fix.** Pass an explicit `executionId`, declare an `idempotencyKey` on the flow,
or use `Flow.layerExecutionIds(Flow.fresh)` for a new invocation. For intentional
payload identity, correct the payload so it can be canonicalized. For a served
resume, return a string from the scope for every resume.

### `Action.ConcurrentKeylessDispatch`

**Symptom.** A run refuses a dispatch, naming the action.

**Cause.** Two ordinal-keyed invocations of one allocation scope were in flight
at once, so fiber arrival order would have assigned their ordinals, step keys,
attempt rows, and recorded outcomes.

**Fix.** Declare an `idempotencyKey` that distinguishes the invocations. Distinct
keys are distinct scopes and overlap freely. A sealed action with a key is
exempt, because its key is a pure cache key rather than an ordinal.

### `Action.IrreversibleRetryRequiresIdempotencyKey`

**Cause.** An `irreversible` action was retried without a declared
`idempotencyKey`, so the engine cannot tell a second attempt from a second
charge.

**Fix.** Declare an `idempotencyKey`, or change the tier if the work really is
sealed or compensable.

### `Action.UncanonicalIdempotencyKey`

**Cause.** An object-form `idempotencyKey` carried a `Date`, an `undefined`, a
class instance, a `Redacted`, or similar material canonical serialization
rejects. The `path` field names where.

**Fix.** Encode the offending value yourself, for example as an ISO string or a
number, before putting it in the key. The failure is not retryable: the same
declaration derives it on every attempt, and the body never runs.

### `Flow.MaxRoundsExceeded`, as a defect in the result

**Cause.** A trampoline lineage opened one more round than its flow's `maxRounds`
allows. The bound is a budget, not loop detection.

**Fix.** Raise `maxRounds`, or fix the branch that never reaches `Flow.done`. The
failure is recorded in the execution result rather than raised as a typed
`execute` failure, so read it off the result.

### `Sleep.SleepRequestInvalid`

`missing_deadline` and `ambiguous_deadline` mean the payload named neither
`millis` nor `until`, or both. `invalid_deadline` means it named a number that is
not a length of time. It is a typed failure, so `Node.catch` can recover it.

### `WaitFor.WaitForRequestInvalid` with code `foreign_execution`

**Cause.** The wait names a token addressed to another flow or another execution.
A deferred result is recorded against the flow and execution that own it, so
awaiting a foreign token would park forever while the value it names was
recorded elsewhere.

**Fix.** Wait by `name` for a wait point of this execution, or resolve the token
from the execution that owns it.

### `DurableDeferred.TokenInvalid` with code `deferred_mismatch`

**Cause.** A completion was submitted through one deferred with a token naming a
different one.

**Fix.** Derive the token from the deferred you are completing.
`WaitFor.deferred(name)` and `HumanTask.deferred(name, attempt)` are the two
derivations that matter.

### `HumanTask.HumanAnswerInvalid` with code `answer_not_open`

**Cause.** The answer addressed an attempt the run is not parked on: a guessed
token, an attempt that was never opened, or a stale one from an earlier attempt.

**Fix.** Read the open attempt back from the engine's waiting row rather than
tracking it in your own process. The row carries the `approval` reason and the
token of the one attempt that is waiting.

### `Poll.PollExhausted`

**Cause.** The poll used its last attempt without a satisfied check, under
`onTimeout: "fail"`.

**Fix.** Catch it in the body if exhaustion is an outcome the caller expects,
raise `maxAttempts`, or declare `onTimeout: "return-last"` when the last reading
is good enough.

### Typed recovery after retries

Exhausted or expired action policies propagate the final declared failure.
Use `Node.catch` or ordinary Effect recovery for that error. A historical run
recorded before this change may still contain RetryAttemptsExhausted or
RetryPolicyExpired as its immutable outcome; restarting that same execution
does not rewrite history.

### `FlowRuntime.FlowExecutionNotFound`

**Cause.** `poll` or `resume` named an execution id the runtime never recorded.
This is different from a known execution that has not settled, which `poll`
answers as `Option.none`.

**Fix.** Check the id, and check that the caller and the run share a store. An
in-memory engine's records die with the process.

### `FlowRuntime.CancelRequestFailed`

`cancel_request_failed` means a durable runtime could not write the cancellation
record, so the execution is still running and you are seeing the storage failure
rather than a false success. `unsafe_interrupt_unsupported` means the durable
engine was asked for `interruptUnsafe`, which it does not implement.

### `FlowRuntime.FlowCycleDetected`

**Cause.** Executing a flow would close a cycle in the persisted parent-execution
chain. `path` holds the ordered execution ids from the cycle's target back to
itself.

**Fix.** Break the cycle, usually by turning the innermost call into a trampoline
handoff.

### A service is missing at run time

Two service requirements are often missed, because they are not action
implementations:

- **`Crypto`.** Every dispatch is recorded under a derived step identity, so even
  the in-memory engine needs one. Provide `NodeCrypto.layer` from
  `@effect/platform-node`, or a browser equivalent.
- **`FlowEngine.SnapshotBoundary`.** A `compensable` action needs one, and the
  engine dies with `SnapshotBoundaryRequired` without it.
  [`@smthrs/engine-store`](/api/engine-store) supplies an implementation.

### A recorded result is never reused across runs

**Cause.** Cross-run reuse needs three declarations, and missing any one of them
scopes the key to the run that produced it: the action's `idempotencyKey`, its
file boundary with `boundaryMode: "hard"`, and the composition's complete
`Action.CacheEnvironment`.

**Fix.** See [Reuse a recorded result](./guides/reuse-a-recorded-result.md). Note
that `metadata`, which carries the file boundary, is an option of the inline form
of `Action.make`.

### A changed schema did not re-key a call

**Cause.** A flow call's key material folds the declared schemas in as their JSON
Schema documents. Two schemas whose decoders disagree can serialize to the same
document, so changing only a codec's behavior does not re-key the call, and a
result recorded under the old codec is replayed under the new one. Effect codecs
are not serializable, so nothing can close this automatically.

**Fix.** Rename the declaration when a transformation changes and the call has to
be re-keyed.

## At declaration time

These throw from the constructor rather than failing a run, because invalid
static configuration is a programmer error.

| Throw                                             | Raised by                                           | Cause                                                                                                                                                     |
| ------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RangeError` naming `maxRounds`                   | `Flow.make`                                         | `maxRounds` is not a positive safe integer.                                                                                                               |
| `RangeError` naming a numeric field               | `RetryPolicy.make`                                  | A bound is out of range. The message names the field.                                                                                                     |
| `RangeError` naming `intervalMs` or `maxAttempts` | `Poll.make`                                         | An interval that is not a finite non-negative length, a budget below one attempt, or a backoff that reaches an unarmable wait before the budget is spent. |
| `TypeError` naming `attempt`                      | `Poll.make`                                         | The `input` fields declared the reserved `attempt` field, which `Poll` owns across rounds.                                                                |
| `RangeError` naming `concurrency`                 | `DurableQueue.makeWorker` and `DurableQueue.worker` | `concurrency` is not a positive safe integer.                                                                                                             |

## Related pages

- [Inspect the plan a body builds](./guides/inspect-the-plan.md): read the
  diagnostics before a run reports them.
- [API reference](./api.md): the complete surface, including every failure's
  fields.
