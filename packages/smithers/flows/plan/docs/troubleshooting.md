---
title: "Troubleshooting"
description: "Every refusal @smthrs/plan raises, what causes it, and what to change: build errors, compile errors, key material errors, and store errors."
---

Every failure this package reports is typed and carries a code. Find the code
and read the matching section. The full error schemas are in the
[API reference](./api.md).

Four error types, from four layers:

| Type               | Raised by                                      |
| ------------------ | ---------------------------------------------- |
| `GraphBuildError`  | Building a node graph, before there is a plan. |
| `PlanError`        | `Plan.compile` and `Plan.append`.              |
| `KeyMaterialError` | The step-key compiler.                         |
| `PlanStoreError`   | Recording, appending, and reading rows.        |

## GraphBuildError

Thrown, not failed, because the author reading it is mid-body. Each one names
the site through `node` plus the recorded property `path`, and states the fix in
`message`.

### planned_value_computed

**What happened.** A body computed on a step result. The message names the
value and the operation:

```text
Planned value read-pr.count was computed at plan time by Symbol.toPrimitive.
Use Node.map to compute, Node.branch to decide, or pass the value into a payload.
```

Template interpolation, `String(value)`, arithmetic through a coercion,
`JSON.stringify` of a payload holding one, calling it, `in`, and enumerating it
all land here.

**What to change.** Do the computation where it belongs. `Node.map` transforms a
result, `Node.branch` decides on one, and passing the value into a payload field
or reading a field off it stays a reference.

`Boolean(value)` and `value === other` cannot be refused, because JavaScript
exposes no trap for them. They reveal only proxy truthiness or identity and
never the planned result, so a decision written that way is silently wrong. Use
`Node.branch`.

### invalid_all_member

**What happened.** `Node.all` received something that is not a node at the named
member.

**What to change.** Pass a node. An object that merely carries `Node.TypeId` is
not one: the marker is a public string, and every combinator reads `ast` as
trusted topology, so a lookalike is refused exactly like any other non-node.

### invalid_continuation

**What happened.** A branch arm, a catch arm, or a direct `andThen`
continuation did not return a node. `node` says which: `branch/subject/then`,
`catch/subject`, or `andThen/next`.

**What to change.** Return a node from the arm. An arm that has nothing to do
returns `Node.succeed(value)`.

### invalid_priority

**What happened.** `Node.priority` received a value that is not a safe integer.

**What to change.** Pass a safe integer. No ordering could compare anything
else.

### invalid_payload

**What happened.** A payload member cannot be captured as inert JSON without
running author code or losing identity: an accessor, or a prototype with no
`toJSON`. The message names the path:

```text
Plan payload at $.config.timeout is an accessor
```

**What to change.** Pass data. Read the accessor yourself and put the value in
the payload, or give the object a `toJSON` that returns data.

### cyclic_payload

**What happened.** A payload member has a `toJSON` that returns its own
receiver. It once collapsed to an empty object, which keyed two different values
identically.

**What to change.** Return data from `toJSON`, not the object itself.

### The codes this package does not raise

`GraphBuildErrorCode` also carries `recursion_requires_boundary`,
`placement_requires_boundary`, `graph_too_deep`, `duplicate_node`,
`payload_too_deep`, and `unstable_callback`. Those come from
[`@smthrs/flow`](/api/flow)'s graph walk, which shares this vocabulary. The
code set is closed so a caller can switch on it across both packages.

`unstable_callback` deserves its own note because the fix lives in your flow
body. `Graph.build` with `callbackIdentity: "stable"` refuses a callback whose
identity is process-local:

```text
Callback run at "review" has process-local identity and cannot enter a stable graph.
```

Wrap the callback in `Node.capture` and declare every semantic capture,
including the version of any imported implementation, so it keys by content
instead of by process.

## PlanError

Failed, not thrown: `compile` and `append` return an Effect.

### cycle

**What happened.** Either material dependencies close a cycle:

```text
Plan cycle through node run-tests
```

or a reader-after-writer edge contradicts an inferred ordering:

```text
Plan cycle: node lint reads dist/bundle.js, which node bundle produces, so lint must
follow bundle, but bundle already depends on lint through bundle -> report -> lint
```

**What to change.** For the first, break the dependency loop in the declarations.
For the second, inspect the inferred producer and `serialize` edges. If the
reader needs the new output, put the producer first or separate unrelated
overlapping writes. If it intentionally reads the earlier version, express that
sequence with a `Ref` or `Pending` dependency path from the writer to the reader.
Explicit read-before-write sequencing is valid; declaration order alone is not
an explicit version choice. Two unordered nodes that each need the other's new
output still form a cycle and must be split into stages.

### unknown_dependency

**What happened.** A `Ref` or `Pending` names a node that is neither in the
drafts nor already in the plan.

**What to change.** Check the `from` spelling against the node ids in the same
compile. On an `append`, remember that the reference may name a node from an
earlier generation, which is legal, but not one that was never recorded.

### duplicate_node

**What happened.** A draft reuses an id the plan already holds.

**What to change.** Rename one of them. A node id is durable dispatch identity,
so two nodes may never share one.

### overlap_forbidden

**What happened.** Two nodes that both asked for the `fail` verdict genuinely
write overlapping paths, and no dependency path orders them:

```text
Nodes bundle and minify both write dist/bundle.js
```

**What to change.** `fail` is the verdict for a flow that promises disjointness,
so the declaration is the thing that broke the promise. Narrow one write set,
add a dependency that orders the pair, or change `conflictStrategy` to
`serialize` if serializing is acceptable after all.

### invalid_effects

**What happened.** One path is declared as both a write and a removal.

**What to change.** Pick one. A removal mutates the world exactly as a write
does, and both plan passes fold the two together, so the pair is a contradiction
rather than a refinement.

### invalid_node

**What happened.** The broadest code, covering everything a draft can get
wrong: an empty plan id, flow, or node id; a priority that is not a safe
integer; a `kind`, `conflictStrategy`, or `runtimeStrategy` outside its literal
set; key material or an effect declaration this release cannot decode, which
includes a path that is not workspace-relative; and a material payload holding
an accessor or an unsupported prototype.

The message names the node and, for a payload, the path:

```text
Node run-tests has invalid material payload at $.config.timeout
```

**What to change.** Read the message. Every case names the exact field. For a
path refusal, [Declare the files a node touches](./guides/declare-file-effects.md)
lists the forms `workspaceRelative` rejects and why each one is a correctness
hole rather than a style rule.

### graph_too_large

**What happened.** The plan would hold more than `Plan.maximumPlanNodes` nodes,
which is 10,000, or effect analysis exceeded 250,000 candidate pairs or
10,000,000 work units.

```text
A plan may contain at most 10000 nodes, received 12000
```

**What to change.** Split the work across flow boundaries. The node ceiling is checked
before effect analysis. A separate work budget bounds dense conflicts and
reachability updates, and applies across generations during verification.

### invalid_plan

**What happened.** `Plan.verify` decoded a plan whose content does not hold
together. Every `PlanStore` read and write runs it, so this surfaces from
`record`, `append`, and `get`, never from `compile`:

```text
Plan approval digest does not match its compiled content
Plan nodes do not match their compiled keys, effects, ordering, or generations
Node run-tests has an invalid or out-of-order generation
```

**What to change.** Pass the value `Plan.compile` or `Plan.append` returned.
A plan that fails here was assembled by hand, mutated after compiling, or
edited in the database. The `PlanStoreError` of the same name covers the store's
own preconditions.

## KeyMaterialError

### non_content_material

**What happened.** `StepKey.fromKeyMaterial` or `StepKey.dispatchIdentity` was
asked for a key on material whose `kind` is `compensable` or `irreversible`.

**What to change.** Only `sealed` work gets a cross-run content key. Use
`StepKey.planIdentity` when compiling any tier's declaration, and
`StepKey.ordinal` when dispatching the other tiers: it mints a run-local key.
Do not change an action to `sealed` merely to make it plannable.

### missing_dependency

**What happened.** A `Ref` or `Pending` resolved to nothing usable: no entry for
`from`, an entry that is not an own data property, or a digest that is not a
string. On the dispatch path, a missing settled result.

**What to change.** Supply every dependency the material names. A `Ref` naming
`toString` or `constructor` lands here on purpose, because a prototype-named
dependency would otherwise resolve to an inherited function and collide.

If you see this from a scheduler, a dependent dispatched before its dependency
settled. The halt rule is what guarantees it cannot: a dependent of failed or
skipped work never dispatches.

### invalid_environment

**What happened.** An `EnvironmentIdentity` that is neither properly declared
nor properly run-scoped:

```text
Undeclared environment identity requires a non-empty runScope
Declared environment identity must not include runScope
Environment identity requires a boolean declared field
```

**What to change.** `declared: true` carries no `runScope`. `declared: false`
carries a non-empty one, which pins the key to a single run so a step whose
environment is unknown never serves a cross-run hit.

## PlanStoreError

### invalid_plan

**What happened.** The plan does not satisfy what the operation requires:

- `record` accepts generation 0 only, whose `baseDigest` equals its `digest` and
  every one of whose nodes is at generation 0.
- `append` refuses a plan whose newest generation adds no nodes.
- Either can fail if a node is not encodable.

**What to change.** Pass the value `Plan.compile` or `Plan.append` returned. All
of these hold by construction; a plan that fails them was assembled by hand or
mutated after compiling.

### constraint

**What happened.** One of two checks in `append` refused.

The compare-and-swap matched no row:

```text
plan review-4821 was never recorded, or generation 3 was skipped or moved under the append
```

Either the plan was never recorded, another writer already advanced it, or the
generation you are appending is not the next one.

The persisted-prefix check found divergence:

```text
plan review-4821 recorded plan's nodes diverge from the plan this append was grown from
```

Two callers elaborated the same recorded plan independently, and this one is
grafting nodes onto a history it never saw.

**What to change.** Read the stored plan with `get`, append to that value, and
retry. Both refusals roll the whole transaction back, so no partial rows
survive, which matters because the append-only triggers mean stray rows could
never be removed.

`constraint` also covers a SQL uniqueness or constraint violation, including the
`(plan_id, ordinal)` uniqueness that keeps recorded node order deterministic.

### decode_failed

**What happened.** A stored row did not decode: either a `flows_plans` row or a
node's JSON.

**What to change.** The `flows_plans` CHECK constraints require nonempty digest
strings, not the stored-key syntax the row decoder requires, so a row written
outside this package can satisfy every constraint and still fail to decode.
Rows this package wrote always decode. Suspect a schema version older or newer
than the running code, or a database written by something else.

### persistence_failed and unknown

**What happened.** The SQL layer failed for a reason that is not a constraint
violation: the file is locked, the disk is full, the connection dropped.

**What to change.** Read `cause`, which carries the underlying error. These are
infrastructure failures, not contract violations.

## SQLite raises "a plan only grows"

**What happened.** A caller tried to rewrite plan history: an UPDATE or DELETE
of a node or edge row, a DELETE of a plan row, or an UPDATE of a plan row that
would change its id, flow, base digest, or creation time, or move its generation
backwards.

**What to change.** Grow the plan instead. `Plan.append` plus
`PlanStore.append` is the only supported way to add to a recorded plan, and
[Append a generation](./guides/append-a-generation.md) covers it. Append-only is
enforced in SQL rather than by convention, because a plan an operator approved
has to be the plan the run executed.

## ERR_PACKAGE_PATH_NOT_EXPORTED for a migration step

**What happened.** Something imported `@smthrs/plan/internal/migrations/0001_initial`
or the path the steps once shipped from,
`@smthrs/plan/migrations/0001_initial`. The export map blocks the first and the
second does not exist, so Node reports `ERR_PACKAGE_PATH_NOT_EXPORTED` and
`ERR_MODULE_NOT_FOUND` respectively.

**What to change.** Import `@smthrs/plan/Migrations` and use `set`. A step
imported on its own would run outside the namespaced ordering
[`@smthrs/database`](/api/database)'s migrator relies on to decide what has
already been applied.
