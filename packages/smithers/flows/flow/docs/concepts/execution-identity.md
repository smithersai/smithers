---
title: "Execution identity"
description: "How a run gets its execution id, how one dispatch gets its step key, and what enters each of those keys."
sidebar:
  order: 3
---

Durability is identity. A re-driven run reads a recorded result only if it asks
under the same name, so this package is careful about two names: the id of a
whole execution, and the key of one dispatch inside it.

## The execution id

`Flow.execute` resolves identity from the first source that has one:

1. The `executionId` the caller named on `execute`.
2. The flow's declared `idempotencyKey`, JSON-tuple framed with the flow tag and
   hashed.
3. The ambient `Flow.CurrentExecutionIds` source. Its default, `Flow.fresh`,
   mints a cryptographic UUID, so equal unkeyed requests start independent work.

A declared key beats the ambient source because it is the narrower statement:
this author said what makes two invocations of _this_ flow the same, where the
source is the host's blanket answer for every flow it drives. Both preimage
encodings freeze at rc.0, and neither applies Unicode normalization.

Install `Flow.derived` explicitly when equal encoded payloads of one flow are
one piece of work. It encodes the payload with the flow's own codec,
canonicalizes it under RFC 8785, hashes it, and hashes that together with the
flow tag:

```ts
const derivedIdentity = Flow.layerExecutionIds(Flow.derived)
```

Install the deterministic `derived` source only when equal payloads deliberately
identify one request. Its existing codec, canonicalization and hash framing are
unchanged, so this is also the migration path for callers that need to reattach
to historical automatically derived executions.

```ts
import { Flow } from "@smthrs/flow"

const intentionalPayloadIdentity = Flow.layerExecutionIds(Flow.derived)
```

`flow.start(payload)` always creates fresh work and returns its id, including
when the declaration carries an idempotency key. `flow.ensure(payload, { key })`
returns the id of an explicitly keyed new or existing execution. After a crash,
reattach with the saved id or the same explicit key; calling unkeyed `execute`
again starts new work. Read a run with `poll(id)`, or await it with
`execute(payload, { executionId: id })`.

Callers that name an `executionId` and flows that declare an `idempotencyKey` are
unaffected, because both are decided before the source is consulted.

### When identity cannot be derived

`Flow.ExecutionIdRequired` is a defect, not a typed failure. The opt-in derived source raises it when the payload has no canonical
form: a non-finite number, a lone surrogate, or a cycle. Derivation fails before the
engine is invoked, because a run under the wrong id is worse than a run that
does not start.

`Flow.executionId(payload)` asks the configured source for an id. With the fresh
source, pass that returned id explicitly to `execute`; asking again mints a new id. It dies when the payload
fails the flow's own schema, where `Flow.execute` fails with a typed
`Schema.SchemaError` for the same input. Precompute an id only for a payload you
have already validated. Identity and `tokenFromPayload` helpers carry the payload schema's
`EncodingServices` requirement because the ambient source may encode the payload.

### Child executions

A `flow.child(payload)` boundary derives its child's id from the parent
execution id, the node's address, the callee tag, and a digest of the payload.
`Interpreter.childExecutionId` is that derivation, exported so a host can name a
child the same way the interpreter does. Because the id is derived from the
node's address rather than minted, a re-driven parent lands on the child it
already started.

## The step key

Inside one execution, every dispatch is recorded under a key derived from three
things.

**The allocation scope** comes from `StepIdentity.AllocationIdentity`: the `kind`
(`action` for user dispatches, `internal` for engine-owned operations, which own
disjoint counter namespaces), the declaration `name`, an optional `idempotency`
refinement, and the optional `site`, which is the replay-stable address of the
graph node driving the dispatch. Distinct graph sites are distinct scopes, so two
call sites of one declaration never contend for one counter.

**The ordinal** is allocated per scope and pinned by dispatch position.
`Action.CurrentOrdinal` carries an `OrdinalSlot` (`{ values, cursors }`) rather
than a number, which is what lets every attempt of one `Action.retry` sequence
reuse its own action's ordinals even when the block dispatches several
declarations. A nested block shares the pinned `values` with the enclosing block
and owns a private `cursors` view seeded at entry and merged back on exit, so a
concurrent sibling never rewinds another block's mid-flight cursor.

**The tier** distinguishes an unsealed key from a compensable or irreversible
one. `StepIdentity.invocationKey` is the single derivation.

Concurrent dispatch of one allocation scope is refused with
`Action.ConcurrentKeylessDispatch`, because arrival order would otherwise decide
which fiber got which ordinal, and with it which attempt row and which recorded
outcome. Only a sealed action with a declared `idempotencyKey` is exempt: that
key is a pure cache key rather than an ordinal, and distinct keys are distinct
scopes that overlap freely.

## What enters a sealed action's cache key

A sealed action's recorded result can be replayed, and with the right
declarations reused. What the key covers is deliberate:

- **Caller-owned identity.** A string `idempotencyKey` is namespaced by the
  action name and the declared schemas. An object key is caller-owned canonical
  JSON and stays stable across an action rename. An object key carrying material
  canonical serialization rejects, such as a `Date`, an `undefined`, a class
  instance, or a `Redacted`, is refused with `Action.UncanonicalIdempotencyKey`
  naming the offending path, and the refusal is not retryable because the same
  declaration derives it on every attempt.
- **Runtime facts the engine adds.** The complete `Action.CacheEnvironment`
  (`layers` and `capabilities`) and any file boundary derived from the action's
  `metadata`. The engine adds these separately, so caller identity cannot
  override them. When the environment is absent, the engine scopes the key to the
  current execution rather than presenting incomplete data as reusable identity.

A flow call node folds the declared schemas into its key material as their JSON
Schema documents, so changing what a callee accepts or produces re-keys the call.
The limit is worth stating plainly: two schemas whose decoders disagree can
serialize to the same document, so changing only a codec's behavior does **not**
re-key the call, and a result recorded under the old codec is replayed under the
new one. Effect codecs are not serializable, so nothing can close this
automatically. Rename the declaration when a transformation changes and the call
has to be re-keyed.

## Related pages

- [Reuse a recorded result](../guides/reuse-a-recorded-result.md): cache policy,
  scope, and the three declarations a shareable result needs.
- [Suspension and replay](./suspension-and-replay.md): what a replay actually
  does with these keys.
