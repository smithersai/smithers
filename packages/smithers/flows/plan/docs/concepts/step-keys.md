---
title: "Step keys"
description: "How key material becomes a step key: sealed content keys, run-local ordinal keys, dependency substitution, and the collisions the compiler is built to refuse."
sidebar:
  order: 2
---

A step key identifies a declaration or a durable execution. It is not, by
itself, permission to reuse a result across runs. `StepKey` produces these
identities from the declared `KeyMaterial`.

The derivations answer different questions:

- `StepKey.planIdentity` produces the **plan key** for every effect tier: the key a node is
  _identified_ by, computed at plan time from the resolved keys of its
  dependencies.
- `StepKey.dispatchIdentity` produces a sealed **dispatch key**: the key a run is
  _cached_ under, computed at execution time from the settled content its
  dependencies produced.

- `StepKey.ordinal` produces a run-local execution key for non-cacheable work.
  The plan scheduler scopes it by run, plan, structural node, and declaration
  fingerprint, so repeated identical effects do not collapse into one action.

Sealed plan keys still use `StepKey.fromKeyMaterial` and retain the existing
content-key format. Other tiers use a distinct `plan-declaration` namespace
that binds approvals without claiming cacheability.

## Key material

`KeyMaterial.KeyMaterial` is everything that can change a node's result:

| Field              | What it contributes                                                                   |
| ------------------ | ------------------------------------------------------------------------------------- |
| `version`          | `KeyMaterial.version`. Folded into every hashed body, so a bump re-keys everything.   |
| `kind`             | The tier: `sealed`, `compensable`, or `irreversible`.                                 |
| `nondeterministic` | Optional. Absence claims determinism; only the explicit declaration changes identity. |
| `body`             | The node's own opaque declaration.                                                    |
| `inputs`           | Ordered `InputRef` values: what this node consumes.                                   |
| `layers`           | The composition identity the step runs under.                                         |
| `capabilities`     | The authority the step declares.                                                      |
| `effects`          | Opaque here: canonically serialized, never interpreted.                               |
| `placement`        | Opaque here, for the same reason.                                                     |

Keeping `effects` and `placement` opaque is what keeps the key compiler
independent of whatever the flow builder decides an effect declaration looks
like. `Plan.compile` is stricter than the compiler underneath it: it decodes
`NodeDraft.effects` through `NodeEffects` and writes the result into
`material.effects`, replacing anything a caller put there. That makes the draft
declaration the single derivation point for effect identity, so a node's key
cannot disagree with the effects its conflict annotations and approval payload
were computed from.

## Input references

An `InputRef` is one of three tagged variants:

| Variant           | Meaning                                                   |
| ----------------- | --------------------------------------------------------- |
| `Literal{value}`  | A value hashed inline.                                    |
| `Ref{from, path}` | The result of node `from`, projected along `path`.        |
| `Pending{from}`   | An ordering reference to node `from`, consuming no value. |

The tag is hashed, so `Pending{from}` and `Ref{from, path: []}` cannot collide
even though both resolve to the same dependency digest.

`KeyMaterial.dependencies` reads the graph-local dependencies a material names,
in declaration order and without duplicates. It is the single derivation of a
node's edge set, which is why a hashed reference and an edge can never disagree.

## Sealed, and everything else

Only `sealed` material may become a content key. `StepKey.fromKeyMaterial` fails
`non_content_material` for the other two tiers, and so does
`StepKey.dispatchIdentity`.

`StepKey.ordinal` mints the deliberately run-local key of compensable,
irreversible, or unsealed work, from a run id, an optional parent scope, an
ordinal, and a `tier` of `compensable`, `irreversible`, or `unsealed`. Those
keys cannot be reused across runs, which is the point: work that changed the
world outside the workspace must not be served from a cache.

## What a plan key folds in

`planIdentity` substitutes each `Ref` and `Pending` for the already computed
key of the referenced node. For sealed material it delegates to
`fromKeyMaterial`; other tiers produce a tier-bearing declaration fingerprint.

Structural node ids do not enter the plan key. Renaming a node preserves its
declaration fingerprint. A non-cacheable execution key does include its
structural address: renaming an effect must not accidentally replay a different
invocation. Changing what a node consumes changes downstream plan keys.

A dependency digest is resolved as an own data property. A `Ref` naming
`toString` or `constructor` is a `missing_dependency` refusal rather than a
colliding key, and so is a digest supplied through an accessor or as a non-string.

## What a dispatch key folds in instead

A plan key folds the resolved keys of every upstream node, transitively, so an
edit anywhere upstream re-keys everything below it, even when the edited node's
output value is byte for byte what it was before.

`dispatchIdentity` gives the JSON value channel the property the file channel
already had through measured boundary digests. It folds the node's own material
and never an upstream key. Each input contributes content instead: a `Literal`
its value, a `Ref` the digest of the settled result of `from` projected along
`path`, and a `Pending` nothing beyond its tag, because ordering does not change
what a node consumes.

`results` must hold every dependency the material names. The scheduler's halt
rule guarantees it: a dependent of failed or skipped work never dispatches, so a
`Ref` always resolves against a success.

## Projection

`StepKey.project` is the one projection semantics for the value channel. It
resolves only own data properties, so a path segment that is missing, inherited,
or an accessor yields `undefined` and no getter runs during key derivation.

Walking off the end of a result is a fact about the graph, not a failure.
`undefined` drops out of the canonical form, so it hashes distinctly from every
JSON value including `null`.

Every consumer that resolves a `Ref` at execution time must resolve it this same
way. Two inputs that key identically but are consumed differently is a stale-hit
vector, and one shared projection is what closes it.

## The collisions this compiler refuses

Each of these is a fix that stayed.

**A literal that looks like a digest.** The brand behind `StepKey.digestInput`
is private, so a plain object that merely has a `digest` field hashes as a
literal. Actions pass content hashes around as ordinary data; shape sniffing
would have hashed a genuine upstream-result reference and an ordinary content
hash identically.

**Environment material merged into the caller's.** `environment` is hashed in
its own namespace, so `caller{fs:["a"]} + env{fs:["b"]}` cannot alias
`caller{fs:["a","b"]} + env{}`. Environment layers keep declaration order,
because composition order can change behavior; caller-owned layers are
set-normalized.

**An unknown environment serving a cross-run hit.** `EnvironmentIdentity` is a
discriminated union. A declared environment carries no `runScope`; an undeclared
one must carry a non-empty one, which pins the key to a single run. Both
`content` and `dispatchIdentity` enforce that at run time with
`invalid_environment`.

**A bumped format keying like the old one.** `version` is folded into every
hashed body, so a change to what material means re-keys every node derived from
it.

## Sharing work between keys

`StepKey.makeDigestMemo` creates a memo that shares one in-flight projected
value digest between concurrent callers, addressed by the `[from, path]` tuple.
Pass it to `dispatchIdentity` through `digestMemo` when several keys in one
wavefront project the same upstream result.

Entries are sound only while each settled `from` value is immutable, so create a
fresh memo when those values can change.

A waiter never inherits the leader's interruption. If the leader's fiber is
cancelled, the waiter competes to become the replacement leader and recomputes,
rather than failing on an interrupt it did not request.

## Failures

`StepKey.KeyMaterialError` carries one of three codes:

| `code`                 | Cause                                                                         |
| ---------------------- | ----------------------------------------------------------------------------- |
| `invalid_environment`  | An environment identity that is neither properly declared nor run-scoped.     |
| `missing_dependency`   | A reference whose digest or settled result is absent, inherited, or mistyped. |
| `non_content_material` | A content or dispatch key was asked for on non-sealed material.               |

[Troubleshooting](../troubleshooting.md) states the fix for each one.

A `Literal` may contain `undefined`, including the terminal value of a void
flow. JSON omits that field; decoding a persisted plan restores an own `value`
field containing `undefined`. Its step key and approval identity stay the same.
