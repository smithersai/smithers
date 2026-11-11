---
title: "Step identity"
description: "The two key shapes an action dispatch is recorded under, what folds into each, how ordinals are allocated per declaration scope, and why the engine refuses two concurrent keyless dispatches of one declaration."
sidebar:
  order: 3
---

Before the engine dispatches an action it derives the key that dispatch is
recorded under. The key decides what a replay finds, so deriving it wrong does
not fail loudly: it hands one dispatch another dispatch's recorded outcome.

There are two key shapes, and which one an action gets is decided by its
declaration.

## The cache key: a sealed action with a declared key

An action declared `tier: "sealed"` with an `idempotencyKey` gets a pure
content key with no ordinal in it. The same call replays one recorded result
wherever and whenever it appears, which is exactly what "sealed" declares.

What folds into the key depends on the form of the declared key:

| Declared form | Key material                                                                             |
| ------------- | ---------------------------------------------------------------------------------------- |
| String        | The action name, the key string, and a digest of the declared success and error schemas. |
| JSON object   | The object, verbatim. No name and no schema material.                                    |

The string form is namespaced by the action name so two different actions
sharing an idempotency string cannot replay each other, and it folds the
compiled declaration so a schema change misses instead of decoding a stale row
under new schemas. The object form is the documented escape hatch for identity
that must survive a rename or a refactor, so nothing the engine owns is folded
into it.

The form itself is key material, so an object that happens to spell the string
form's encoding is still a different key.

These also fold into both forms when present:

- The hermetic file boundary descriptor from the action's metadata, when the
  metadata is shaped like one. A changed read-set digest, write set, or
  boundary mode must miss rather than replay a stale cross-run entry.
- The declared `nondeterministic` marker, so a tolerant declaration cannot
  consume a strict row.
- The declared `implementationVersion`.
- The cache environment when the dispatch has one, and the run id when it does
  not. That is the difference between a row shared across runs and a row
  pinned to this one.

The declaration and boundary enter the outer key as `key1_`-prefixed SHA-256
digests of their canonical documents. Declaration digests are memoized by the
success/error AST pair, or, under key encoding 1, by the success/error schema
values, which carry the brands that encoding restores. Boundary digests are
reused only while the validated metadata document is unchanged.

This compact encoding intentionally changes persisted string-key bytes, and
object-key bytes when a boundary is present, following the earlier intentional
schema-folding break (issue #120). Existing rows under the previous encoding
miss and the action executes again. Boundary-free object keys are unchanged.

### Key encodings

A record is found again only under the key it was written with, so a change to
how a sealed key is derived must not strand the outcomes recorded before it.
The engine numbers each derivation as a key encoding and keeps every earlier
one derivable. `FlowEngine.keyEncodings` lists them newest first:

| Encoding | Written                           | Key                                                                                                       |
| -------- | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `4`      | since 2026-11-11                  | Declaration digest from `Node.representationIdentity` version 3: what a JSON string decodes to is in it.  |
| `3`      | from 2026-10-21 to 2026-11-11     | Names itself (`keyEncoding: 3`); declaration digest from `Node.representationIdentity` version 2.         |
| `2`      | from `effect@4.0.4` to 2026-10-21 | Encoding 3 without the name: identity version 2, where a `Schema.brand` contributes nothing.              |
| `1`      | under `effect@4.0.0-rc.115`       | No name; identity version 1, each brand restored as rc.115 wrote it. Equal to encoding 2 without a brand. |

New keys take the newest encoding. Before it dispatches, the engine hands the
store the dispatch's keys under every older encoding that differs from the
current one, each once (`Encoded.actionReplayKey`'s `legacy`). The SQL store
looks each up in this run's attempts, newest first, and replays a record found
there instead of running the step again. Only a keyed sealed action's key
differs between encodings, so every other dispatch is offered nothing older and
probes nothing. The lookup reads this run's attempts only: a cross-run cache row
written under an older encoding misses once, and the step runs again under the
newest.

An older encoding keeps what it could not tell apart. Encodings 3, 2 and 1
derive one key for two declarations that differ only in what a JSON string
decodes to, so a run that recorded a step under one of them and resumes after
such an edit replays that record. A record written under encoding 4 does not.

A change to the derivation adds an encoding at the front of `keyEncodings` and
names it in the key; it never edits one. `FlowEngine.ActionKeyEncoding` selects
the encoding new keys take. A host leaves it at its default, the newest; a test
sets an older one to write a journal the way an earlier engine did. Rows written
before encoding 1 (the schema-folding break of issue #120) miss, and the action
executes again.

## The invocation key: everything else

Any other action, sealed without a declared key, compensable, or irreversible,
is recorded under an ordinal-scoped invocation key: the run id, an allocation
scope, an ordinal within that scope, and the tier.

The ordinal is allocated from a counter, and which counter is the whole
subtlety.

## Allocation scope

A single per-run counter bumped in fiber-arrival order would make identity
depend on scheduling. Under `Effect.all` with concurrency, a replay that
reversed the arrival order could hand `chargeCard` the ordinal `sendEmail`
recorded, and replay the wrong attempt rows, checkpoint, and outcome.

So counters are per scope, and the scope is derived from:

- the action's name, always,
- its declared `idempotencyKey`, in either the string or the object form, so
  two concurrent invocations with distinguishable inputs each own a counter,
- the structural interpreter site, when the dispatch comes from a graph node,
  so two distinct nodes calling one declaration each own a counter,
- the declared implementation version, when present,
- the enclosing action's invocation key, when dispatching from an action
  implementation, so two parents' first nested dispatches cannot share a row.

Nested invocation scopes append `/p:<key length>:<parent key>`. This corrects
previously colliding nested keys and changes their persisted identities. Resume
existing runs with the engine version they started with; do not upgrade an
unfinished run whose nested actions may already have performed effects. Top-level
invocation keys and explicitly keyed sealed cache identities are unchanged.

Distinct scopes are stable under any interleaving and may overlap freely.

Inside `Action.retry`, ordinals are pinned rather than reallocated: the n-th
dispatch of a scope in the first attempt takes an ordinal, and the n-th
dispatch of that scope in every later attempt takes the same one. A retry block
that dispatches one declaration several times gives each dispatch its own
stable identity.

## Concurrent keyless dispatch is refused

Two concurrent dispatches that land in one scope have no engine-visible
material to order them by: their inputs live inside the execute closure, and
the engine cannot see them. Rather than assign identity by arrival order, the
engine refuses the second one with `Action.ConcurrentKeylessDispatch`.

Only a sealed action with a declared key escapes the guard, because it takes a
pure cache key with no ordinal at all. A keyed action at any other tier still
resolves to an invocation key, so two concurrent same-key dispatches share one
scope and are refused too.

The refusal is the diagnosis, and there are three ways to answer it: declare an
`idempotencyKey` that distinguishes the invocations, dispatch them from
distinct interpreter graph nodes, or run them in sequence.

The guard's acquire and release live in one uninterruptible region, so an
interruption between them cannot leak a scope and poison every later sequential
dispatch of that declaration.

## Related

- [Retries and attempts](./retries.md): the key is also what the attempt
  counter and the retry origin are looked up by.
- [Execution identity](./execution-identity.md): the other identity, naming the
  run rather than the step.
