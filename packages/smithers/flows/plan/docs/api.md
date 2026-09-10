---
title: "API reference"
description: "Every public export of @smthrs/plan: the authoring AST, the planned placeholder, key material, the step-key compiler, the plan value, its diff, its append-only store, and its migrations."
---

`@smthrs/plan` exports ten modules from its root entry point, and each is also
importable from `@smthrs/plan/<Module>`:

```ts
import { FileSet, Node, Plan, PlanStore } from "@smthrs/plan"
// or
import * as Plan from "@smthrs/plan/Plan"
```

`@smthrs/plan/internal/*` and `@smthrs/plan/*/index` are not public.
`@smthrs/plan/package.json` is exported.

| Namespace         | What it is                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `Node`            | The pure, pipeable authoring AST: `succeed`, `all`, `map`, `andThen`, `branch`, `catch`, `priority`.      |
| `Planned`         | The strict placeholder a body sees where a step result will be, and the reference it records.             |
| `GraphBuildError` | The refusals a plan-time build raises instead of producing a wrong plan.                                  |
| `FileSet`         | The static filesystem vocabulary: patterns, globs, tree artifacts, filegroups, and overlap.               |
| `KeyMaterial`     | What a planner declares about a node: body, tagged input references, layers, capabilities, effects.       |
| `StepKey`         | The compiler that turns material plus resolved dependency digests into a [`@smthrs/keys`](/api/keys) key. |
| `Plan`            | `compile`, `append`, the node and conflict schemas, and the digest an approval binds to.                  |
| `PlanDiff`        | A plan comparison as a value: added, removed, re-keyed with attribution, unchanged.                       |
| `PlanStore`       | Append-only SQL persistence, enforced by triggers rather than by convention.                              |
| `Migrations`      | The namespaced migration set that owns the three plan tables in id block `4000`.                          |

The shortest composition that reaches every layer:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Plan, PlanStore } from "@smthrs/plan"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const plan = yield* Plan.compile({
    planId: "review-4821",
    flow: "example/Review",
    nodes: [
      {
        id: "read-pr",
        material: {
          version: "flows/key-material/v2",
          kind: "sealed",
          body: { action: "read-pr", pr: 4821 },
          inputs: [],
          layers: [],
          capabilities: ["net:get"]
        },
        effects: { reads: [], writes: ["pr.json"], boundaryMode: "hard" }
      },
      {
        id: "run-tests",
        material: {
          version: "flows/key-material/v2",
          kind: "sealed",
          body: { action: "run-tests" },
          inputs: [{ _tag: "Ref", from: "read-pr", path: [] }],
          layers: [],
          capabilities: []
        },
        effects: { reads: ["pr.json"], writes: ["report.json"], boundaryMode: "hard" }
      }
    ]
  })

  const store = yield* PlanStore.PlanStore
  return yield* store.record(plan, Date.now())
}).pipe(Effect.provide(NodeCrypto.layer))
```

Compiling needs Effect's `Crypto` service and nothing else. Recording additionally needs `PlanStore.layer` over a `DurableWriter` and a `SqlClient`. The package depends on [`@smthrs/crypto`](/api/crypto), [`@smthrs/database`](/api/database), [`@smthrs/keys`](/api/keys), and `effect`, and is browser-safe.

## Entry point

| Import         | Source                                                                                                     | Platform         |
| -------------- | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| `@smthrs/plan` | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/src/index.ts) | Node and browser |

## KeyMaterial

[src/KeyMaterial.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/src/KeyMaterial.ts)

What a planner declares about one node, handed to the compiler: a `version`, a tier `kind`, an optional `nondeterministic` flag, an opaque `body`, an ordered list of `InputRef`s, `layers`, `capabilities`, and opaque `effects` and `placement`.

`kind` is `sealed`, `compensable`, or `irreversible`. Absence of `nondeterministic` claims determinism; only the explicit declaration changes identity. The `InputRef` tag is hashed, so `Pending{from}` and `Ref{from, path: []}` cannot collide even though both resolve to the same dependency digest.

`dependencies` is the single derivation of a node's edge set, so a hashed reference and an edge can never disagree. `StepKey` canonically serializes `effects` and `placement` and never interprets them, which keeps the key compiler independent of whatever the flow builder decides an effect declaration looks like. `Plan.compile` is stricter: it decodes `NodeDraft.effects` through `NodeEffects` and writes the result into `material.effects`, replacing anything a caller put there. That makes the draft declaration the single derivation point for effect identity, so a node's key cannot disagree with the effects its conflict annotations and approval payload were computed from.

### KeyMaterial.InputRef

```ts
type InputRef =
  | { readonly _tag: "Literal"; readonly value: unknown }
  | { readonly _tag: "Ref"; readonly from: string; readonly path: ReadonlyArray<string> }
  | { readonly _tag: "Pending"; readonly from: string }
```

One declared input. `Literal` is hashed inline. `Ref` names an upstream node and the property path read off its result. `Pending` names an upstream node without consuming its value, which is an ordering reference. `from` is a non-empty string. Exported as both a schema and a type.

### KeyMaterial.KeyMaterial

```ts
const KeyMaterial: Schema.Struct<{
  version: Schema.Literal<"flows/key-material/v2">
  kind: Schema.Literals<["sealed", "compensable", "irreversible"]>
  nondeterministic: Schema.optional<Schema.Literal<true>>
  body: Schema.Unknown
  inputs: Schema.Array$<typeof InputRef>
  layers: Schema.Array$<Schema.String>
  capabilities: Schema.Array$<Schema.String>
  effects: Schema.optional<Schema.Unknown>
  placement: Schema.optional<Schema.Unknown>
}>
```

Everything that can change a node's result. Exported as both a schema and a type.

### KeyMaterial.version

```ts
const version: "flows/key-material/v2"
```

The material version, folded into every hashed body so a bump re-keys every node derived from it.

### KeyMaterial.dependencies

```ts
const dependencies: (material: KeyMaterial) => ReadonlyArray<string>
```

The graph-local dependencies a material names, in declaration order and without duplicates. `Literal` inputs contribute nothing. `Plan.compile` uses the result as the node's edge set.

## Scheduling

`Scheduling.make(concurrency?)` creates a pure admission policy. Import it from
`@smthrs/plan/Scheduling` or the package's `Scheduling` namespace. The optional
`steps` and `agents` limits must be positive safe integers; omission is
unbounded within the safe-integer range. Construction snapshots the limits.

`policy.admit(ready, active)` takes candidates `{ node, order, waited }` and
the current permit usage `{ steps, agents }`. Each node supplies its unique
`id`, `kind` (`step`, `agent`, or `merge`), and safe-integer `priority`.
`order` is its unique non-negative position in the compiled plan, not arrival
order. `waited` is its non-negative count of capacity-constrained admission
passes. An agent consumes both a step permit and an agent permit.

The result contains immutable `admitted` and `deferred` candidate arrays plus
the number of newly admitted `agents`. Only deferred candidates receive an
incremented age; input candidates and node values are not mutated. Age
saturates at `Number.MAX_SAFE_INTEGER`. Exact priority-plus-age comparison
prevents floating-point rounding from changing the ordering. Equal scores
preserve plan order; a blocked agent does not prevent a regular node from using
available step capacity. Invalid counts, duplicate IDs/positions, or invalid
priorities are refused synchronously with `RangeError`.

This policy is used by `@smthrs/engine-store`'s durable plan scheduler. It does
not determine readiness, evaluate branches, launch nodes, or cancel effects.
The caller must supply only ready candidates and apply the returned ages before
its next admission pass. Public interpreter/compiled scheduling parity is not
provided by this policy alone.

## StepKey

[src/StepKey.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/src/StepKey.ts)

The compiler from material to a [`@smthrs/keys`](/api/keys) `Key`. `planIdentity` substitutes each `Ref` and `Pending` for the already-computed key of the referenced node. Sealed material retains the `fromKeyMaterial` content-key format; other tiers use a separate declaration namespace. `ordinal` mints the deliberately run-local key of compensable, irreversible, or unsealed work, whose `tier` is one of those three words.

Structural node ids do not enter declaration fingerprints. Non-cacheable execution keys also need a run-local structural scope to distinguish repeated identical effects. Only `sealed` material may become a content key, so `fromKeyMaterial` fails `non_content_material` for the other two tiers. A dependency digest is resolved as an own property, so a `Ref` naming `toString` or `constructor` is a `missing_dependency` refusal rather than a colliding key.

The brand behind `digestInput` is private, so a plain object that merely has a `digest` field hashes as a literal. That closes a collision where shape sniffing hashed a genuine upstream-result reference and an ordinary content hash identically.

`environment` is hashed in its own namespace rather than merged into the caller's declarations, so `caller{fs:["a"]} + env{fs:["b"]}` cannot alias `caller{fs:["a","b"]} + env{}`. Environment layers keep declaration order because composition order can change behavior; caller-owned layers are set-normalized. `EnvironmentIdentity` is a discriminated union: a declared environment carries no `runScope`, and an undeclared one must carry a non-empty one, pinning the key to a single run so a step whose environment identity is unknown never serves a cross-run hit. Both `content` and `dispatchIdentity` enforce that at run time with `invalid_environment`.

`project` is the one projection semantics for the value channel. It resolves only own data properties, so a path segment that is missing, inherited, or an accessor yields `undefined` and no getter runs during key derivation.

A `DigestMemo` shares one in-flight projected-value digest between concurrent callers. A waiter never inherits the leader's interruption: if the leader's fiber is cancelled, the waiter recomputes as the new leader.

### StepKey.StepKey

```ts
type StepKey = StoredKey
```

A computed step key: `key1_` plus a SHA-256 digest of the canonical serialization of the material. Identical in representation to every other flow key, which is what lets the engine dispatch under it.

### StepKey.ContentIdentity

```ts
interface ContentIdentity {
  readonly body: unknown
  readonly inputs: Readonly<Record<string, unknown | DigestInput>>
  readonly layers: ReadonlyArray<string>
  readonly capabilities: Readonly<Record<string, ReadonlyArray<string>>>
  readonly environment?: EnvironmentIdentity | undefined
  readonly hermetic?: {
    readonly readSet: ReadonlyArray<{ readonly path: string; readonly digest: string }>
    readonly writeSet: ReadonlyArray<FileSet.Entry>
    readonly removes?: ReadonlyArray<string> | undefined
    readonly boundaryMode: "hard" | "expected"
  } | undefined
}
```

Material describing a sealed or hermetic content-addressed step. `layers` and each capability group are set-normalized before hashing; `hermetic.readSet` is sorted and deduplicated by path and digest, and `hermetic.writeSet` by entry.

### StepKey.OrdinalIdentity

```ts
interface OrdinalIdentity {
  readonly runId: string
  readonly parentScope?: string | undefined
  readonly ordinal: number
  readonly tier: "compensable" | "irreversible" | "unsealed"
}
```

Material describing the run-local identity of a non-cacheable step.

### StepKey.EnvironmentIdentity

```ts
type EnvironmentIdentity =
  | {
    readonly declared: true
    readonly layers: ReadonlyArray<string>
    readonly capabilities: Readonly<Record<string, ReadonlyArray<string>>>
    readonly runScope?: undefined
  }
  | {
    readonly declared: false
    readonly layers: ReadonlyArray<string>
    readonly capabilities: Readonly<Record<string, ReadonlyArray<string>>>
    readonly runScope: string
  }
```

The engine-resolved execution environment a content key is computed under.
`EnvironmentIdentity` is also a runtime schema; its TypeScript type is derived
from that schema. `content`, `dispatchIdentity`, and `environmentIdentity`
validate the entire shape, reject unknown fields, and return typed
`invalid_environment` errors for invalid identities rather than defects.

### StepKey.environmentIdentity

```ts
const environmentIdentity: (
  environment?: EnvironmentIdentity
) => Effect.Effect<StoredKey, KeyMaterialError | Schema.SchemaError, Crypto.Crypto>
```

A fingerprint for binding a durable execution to its runtime environment,
not an action dispatch key. It has a separate `execution-environment/v1`
namespace and uses the same normalization as content/dispatch keys: layer
order and duplicates are significant; layer strings and capability patterns
normalize to NFC; capability-pattern sets sort and deduplicate. Capability
group names retain their exact spelling. An omitted environment, declared-empty
environment, and undeclared run-scoped environment remain distinct.

`PlanScheduler` snapshots the identity at construction and stores this
fingerprint with `PlanInputStore` before dispatch. Changed identities cannot
resume the same run. This does not change existing valid action-key material
or detect implementation changes missing from the declared identity.

### StepKey.DigestInput

```ts
interface DigestInput {
  readonly digest: string
  readonly reference?: "ref" | "pending" | "ref-projected"
  readonly path?: ReadonlyArray<string>
}
```

A precomputed digest supplied as a step input rather than a literal value. It also carries a private brand, which is the whole point: only `digestInput` can produce one.

### StepKey.digestInput

```ts
const digestInput: (
  digest: string,
  reference?: {
    readonly reference: "ref" | "pending" | "ref-projected"
    readonly path?: ReadonlyArray<string>
  }
) => DigestInput
```

Nominally tags a precomputed digest so it is hashed as a digest reference rather than a literal value.

### StepKey.isDigestInput

```ts
const isDigestInput: (value: unknown) => value is DigestInput
```

Type guard for values produced by `digestInput`. It reads the private brand, so a plain `{digest: "..."}` answers `false`.

### StepKey.DigestMemo

```ts
interface DigestMemo {
  readonly digest: (
    from: string,
    path: ReadonlyArray<string>,
    compute: Effect.Effect<StepKey, Schema.SchemaError, Crypto.Crypto>
  ) => Effect.Effect<StepKey, Schema.SchemaError, Crypto.Crypto>
}
```

Caller-owned memoization context for projected dependency-value digests, addressed by the JSON-encoded `[from, path]` tuple. Entries are sound only while each settled `from` value is immutable, so create a fresh memo when those values can change.

### StepKey.makeDigestMemo

```ts
const makeDigestMemo: () => DigestMemo
```

Creates an empty memo.

### StepKey.content

```ts
const content: (
  identity: ContentIdentity
) => Effect.Effect<StepKey, KeyMaterialError | Schema.SchemaError, Crypto.Crypto>
```

Produces a cross-run reusable key. Set-like declarations are normalized before serialization; write declarations remain part of the identity even when the step writes nothing.

### StepKey.ordinal

```ts
const ordinal: (
  identity: OrdinalIdentity
) => Effect.Effect<StepKey, Schema.SchemaError, Crypto.Crypto>
```

Produces a run-local key for compensable, irreversible, or unsealed work. These keys intentionally cannot be reused across runs.

### StepKey.planIdentity

```ts
const planIdentity: (
  material: KeyMaterial.KeyMaterial,
  dependencyDigests: Readonly<Record<string, string>>
) => Effect.Effect<StepKey, KeyMaterialError | Schema.SchemaError, Crypto.Crypto>
```

The declaration fingerprint used by `Plan.compile`, `append`, and `verify`.
Accepts every effect tier. Non-sealed fingerprints use a distinct, tier-bearing
namespace and are not cross-run cache keys. Dependency references must resolve
to own string-valued properties, as with `fromKeyMaterial`.

### StepKey.fromKeyMaterial

```ts
const fromKeyMaterial: (
  material: KeyMaterial.KeyMaterial,
  dependencyDigests: Readonly<Record<string, string>>
) => Effect.Effect<StepKey, KeyMaterialError | Schema.SchemaError, Crypto.Crypto>
```

The sealed plan key: resolves graph-local references against `dependencyDigests`, which must hold an own string-valued property for every node the material names, then builds a content key. Fails `non_content_material` unless `material.kind` is `sealed`. Use `planIdentity` for a tier-independent compiler.

### StepKey.dispatchIdentity

```ts
const dispatchIdentity: (options: {
  readonly material: KeyMaterial.KeyMaterial
  readonly results: Readonly<Record<string, unknown>>
  readonly hermetic: NonNullable<ContentIdentity["hermetic"]>
  readonly environment?: EnvironmentIdentity | undefined
  readonly digestMemo?: DigestMemo | undefined
}) => Effect.Effect<StepKey, KeyMaterialError | Schema.SchemaError, Crypto.Crypto>
```

The key a dispatch is _cached_ under, as distinct from the plan key a node is _identified_ by.

A plan key folds the resolved keys of every upstream node, transitively, so an edit anywhere upstream re-keys everything below it, even when the edited node's output value is byte for byte what it was before. This derivation folds the node's own material and never an upstream key. Each input contributes content instead: a `Literal` its value, a `Ref` the digest of the settled result of `from` projected along `path`, and a `Pending` nothing beyond its tag. The measured hermetic boundary is folded unchanged.

`results` must hold every dependency the material names. The scheduler's halt rule guarantees it: a dependent of failed or skipped work never dispatches, so a `Ref` always resolves against a success.

### StepKey.project

```ts
const project: (value: unknown, path: ReadonlyArray<string>) => unknown
```

Projects a settled result along a `Ref` path. Only own data properties resolve, so a missing, inherited, or accessor segment yields `undefined` without invoking a getter. A projection that walks off the end of a result is a fact about the graph, not a failure: `undefined` drops out of the canonical form, so it hashes distinctly from every JSON value including `null`.

This is exported because it is the one projection semantics for the value channel. Every consumer that resolves a `Ref` at execution time must resolve it this way, or two inputs that key identically could be consumed differently.

### StepKey.KeyMaterialError

```ts
class KeyMaterialError extends Schema.TaggedError<KeyMaterialError>()("@smthrs/plan/KeyMaterialError", {
  code: Schema.Literals(["invalid_environment", "missing_dependency", "non_content_material"])
  message: Schema.String
})
```

Stable failures while resolving graph-local dependency references.

## Plan

[src/Plan.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/src/Plan.ts)

`compile` puts drafts in topological order of material dependencies, substitutes dependency digests, annotates write-set overlaps, and derives the plan digest. `append` adds a pre-keyed subgraph at the next generation, and `generationNodes` reads back the nodes the newest generation added.

Inferred edges extend `dependsOn` without reordering `plan.nodes`, so a reader can precede its writer in the array. Schedule nodes from the complete `dependsOn` graph.

`PlanNode.kind` is `step`, `agent`, or `merge`. `dependsOn` is the edge set: material references, ordering edges from `serialize`, and inferred reader-after-writer edges. Explicit `Ref`/`Pending` dependency paths select the version being read: a read before a writer consumes the initial source or an earlier producer's output, not that later writer's output. Otherwise, the compiler orders a reader after overlapping writers. A contradictory inferred ordering still fails with `cycle`; the diagnostic names both nodes, overlapping paths, and the dependency chain. Ordering edges are deliberately not key material: file content enters dispatch identity through boundary digests. `NodeEffects` carries `reads`, `writes`, optional `removes`, and `boundaryMode` (`hard` or `expected`). Removals participate in ordering just like writes.

Planning performs no I/O. Declared effects carry read and write _paths_, never digests, because measuring a path is run-time work. A node's key is a function of what it consumes, so an edited declaration re-keys that node and its dependent cone and nothing else. That is the entire invalidation mechanism: there is no reverse-dependency index and no invalidating node visitor, because content addressing subsumes both.

A plan grows and is never rewritten. `append` leaves the nodes already in it with their id, key, edges, and generation byte for byte, and the new nodes arrive pre-keyed against them. Re-ordering after a reconciliation happens by re-keying future steps.

`baseDigest` is the digest at generation 0: what a human approved and what a running run pins. `digest` advances with every appended elaboration. Both cover node identity, every computed key, the edge set, the conflict annotations, the declared effects, the priority, and each node's own conflict and runtime strategies.

A compiled plan is a deep-frozen snapshot of the drafts it was given. Material is stored as the inert JSON mirror its key already covers, so a `Date`, a `URL`, or any value with a data-valued callable `toJSON` is stored as the value it serializes to, and mutating a caller's draft after compiling cannot change the plan, its keys, or its digest. A material accessor, or a prototype with no JSON representation, is refused as `invalid_node` naming the node and the payload path rather than stored by reference. A `Planned` placeholder is left intact so canonical serialization still refuses it.

### Plan.NodeEffects

```ts
const NodeEffects: Schema.Struct<{
  reads: Schema.Array$<typeof FileSet.ReadDeclaration>
  writes: Schema.Array$<typeof FileSet.Declaration>
  removes: Schema.optional<Schema.Array$<typeof FileSet.Pattern>>
  boundaryMode: Schema.Literals<["hard", "expected"]>
}>
```

What a node does to the world, declared as paths. Exported as both a schema and a type.

### Plan.PairStrategy

```ts
type PairStrategy = "serialize" | "lane" | "fail"
```

The plan-time verdict for one overlapping pair of writers. Exported as both a schema and a type.

### Plan.RuntimeStrategy

```ts
type RuntimeStrategy = "delay-rebase" | "stop-merge"
```

What the scheduler does when a predicted overlap actually bites. Exported as both a schema and a type.

### Plan.ConflictAnnotation

```ts
const ConflictAnnotation: Schema.Struct<{
  with: Schema.NonEmptyString
  paths: Schema.Array$<Schema.String>
  strategy: typeof PairStrategy
  runtime: typeof RuntimeStrategy
}>
```

One resolved overlap between two writers that no dependency path already orders. Conflict is a property of the pair, not of one declaration. Exported as both a schema and a type.

### Plan.PlanNode

```ts
const PlanNode: Schema.Struct<{
  id: Schema.NonEmptyString
  kind: Schema.Literals<["step", "agent", "merge"]>
  key: typeof StoredKey
  material: typeof KeyMaterial.KeyMaterial
  effects: typeof NodeEffects
  dependsOn: Schema.Array$<Schema.NonEmptyString>
  conflicts: Schema.Array$<typeof ConflictAnnotation>
  strategy: typeof PairStrategy
  runtime: typeof RuntimeStrategy
  priority: Schema.Int
  generation: Schema.Int
}>
```

A keyed node of the plan. `strategy` and `runtime` are this declaration's own preferences, recorded so a later elaboration can resolve a pair against them without re-reading the flow source. Exported as both a schema and a type.

### Plan.Plan

```ts
const Plan: Schema.Struct<{
  planId: Schema.NonEmptyString
  flow: Schema.NonEmptyString
  generation: Schema.Int
  baseDigest: typeof StoredKey
  digest: typeof StoredKey
  nodes: Schema.Array$<typeof PlanNode>
}>
```

The whole keyed graph plus the digest an approval binds to. Exported as both a schema and a type.

### Plan.NodeDraft

```ts
interface NodeDraft {
  readonly id: string
  readonly material: KeyMaterial.KeyMaterial
  readonly effects: NodeEffects
  readonly kind?: PlanNode["kind"] | undefined
  readonly priority?: number | undefined
  readonly conflictStrategy?: PairStrategy | undefined
  readonly runtimeStrategy?: RuntimeStrategy | undefined
}
```

What a planner hands `compile`: a node without its key. `kind` defaults to `step`, `priority` to 0, `conflictStrategy` to `serialize`, and `runtimeStrategy` to `delay-rebase`.

### Plan.compile

```ts
const compile: (options: {
  readonly planId: string
  readonly flow: string
  readonly nodes: ReadonlyArray<NodeDraft>
}) => Effect.Effect<Plan, PlanError | StepKey.KeyMaterialError | Schema.SchemaError, Crypto.Crypto>
```

Compiles drafts into a plan: topological order of material dependencies, dependency-digest substitution, overlap annotation, reader-after-writer ordering, and the plan digest. No I/O. The options are snapshotted before anything else happens, and the result is deep-frozen at generation 0 with `baseDigest` equal to `digest`. Array order follows material dependencies; scheduling follows the complete `dependsOn` graph.

Traversal uses explicit stacks. Because the conflict and reader-after-writer passes consider a quadratic number of node pairs, plans are bounded by `maximumPlanNodes` and fail with `graph_too_large` above that limit or the effect-analysis work budget. Analysis yields periodically.

### Plan.append

```ts
const append: (
  plan: Plan,
  drafts: ReadonlyArray<NodeDraft>
) => Effect.Effect<Plan, PlanError | StepKey.KeyMaterialError | Schema.SchemaError, Crypto.Crypto>
```

Appends an elaborated subgraph at the next generation. Nodes already in the plan keep their id, key, edges, and generation byte for byte, and the new nodes arrive pre-keyed against them. `baseDigest` does not move; `digest` does. New nodes retain material-dependency order after the recorded prefix, including when inferred edges point to later entries. An append with no drafts fails as `invalid_node`.

### Plan.verify

```ts
const verify: (input: unknown) => Effect.Effect<
  Plan,
  PlanError | StepKey.KeyMaterialError | Schema.SchemaError,
  Crypto.Crypto
>
```

Reconstructs an imported plan using compiler key, dependency, conflict and generation rules. It verifies both the approval digests and the complete node contract, then returns an immutable snapshot. Compiler-owned immutable plans take a trusted fast path. `Plan.append` verifies imported prefixes through this same boundary. Recorded material-dependency order is checked without sorting inferred edges. Existing ordinals, keys, and approval digests remain unchanged; corrupted records are refused rather than silently rewritten.

### Plan.isVerified

```ts
const isVerified: (input: unknown) => input is Plan
```

Whether a value is a compiler-owned immutable snapshot that already passed `verify`. Such values take verify's trusted fast path and need no second schema validation, which is what lets `PlanStore.append` skip re-decoding them.

### Plan.prefixDigest

```ts
const prefixDigest: (
  plan: Plan
) => Effect.Effect<StepKey.StepKey, StepKey.KeyMaterialError | Schema.SchemaError, Crypto.Crypto>
```

The approval digest of every generation before the newest: the digest the plan carried before its last append. `PlanStore.append` matches it against the stored envelope, so an append proves the recorded prefix is the caller's from the already-verified prefix instead of decoding and re-verifying every stored row.

### Plan.generationNodes

```ts
const generationNodes: (plan: Plan) => ReadonlyArray<PlanNode>
```

The nodes added by the newest generation: what `PlanStore.append` inserts, and what a scheduler such as [`@smthrs/engine-store`](/api/engine-store)'s reports in the `subgraph-appended` record it writes to the run journal.

### Plan.maximumPlanNodes

```ts
const maximumPlanNodes: 10_000
```

Maximum number of nodes retained by one compiled plan. Conflict analysis is quadratic in node count, so an explicit ceiling keeps untrusted declarations from turning planning into an unbounded CPU task.

### Plan.PlanError

```ts
class PlanError extends Schema.TaggedError<PlanError>()("@smthrs/plan/PlanError", {
  code: Schema.Literals([
    "cycle",
    "unknown_dependency",
    "duplicate_node",
    "overlap_forbidden",
    "invalid_effects",
    "invalid_node",
    "graph_too_large"
  ])
  message: Schema.String
})
```

A graph the compiler refuses. The code set is closed, so a caller may switch on it.

| `code`               | Meaning                                                                                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cycle`              | material dependencies close a cycle, or a reader-after-writer edge would close one                                                                                                                                                                 |
| `unknown_dependency` | a `Ref` or `Pending` names a node that is neither in the drafts nor already in the plan                                                                                                                                                            |
| `duplicate_node`     | a draft reuses an id the plan already holds                                                                                                                                                                                                        |
| `overlap_forbidden`  | a `fail` pair genuinely overlaps and no dependency path orders it                                                                                                                                                                                  |
| `invalid_effects`    | one path is declared as both a write and a removal                                                                                                                                                                                                 |
| `invalid_node`       | an empty plan id, flow, or node id, a priority that is not a safe integer, a `kind` or strategy outside its literal set, or key material or an effect declaration this release cannot decode, which includes a path that is not workspace-relative |
| `graph_too_large`    | a plan exceeds `Plan.maximumPlanNodes` or the effect-analysis work budget                                                                                                                                                                          |

Compilation walks with explicit stacks and never recurses per edge. Effect analysis caches transitive reachability in bitsets, updates it when inferring ordering edges, and yields periodically for interruption. It refuses more than 250,000 candidate pairs or 10,000,000 work units with `graph_too_large`. Work includes overlap comparisons, bitset merges and graph traversal. `verify` shares this budget and one effect expansion map and candidate index across all replayed generations. Plans above `Plan.maximumPlanNodes` are refused before effect analysis.

### Conflict annotations

Declared write sets make overlap detectable at plan time. Writers already ordered by a dependency path, including one ordered through an ordering edge this pass just inferred, are not conflicts. Every other overlapping pair is annotated on both members with the resolved verdict.

| Verdict     | Effect                                                                           |
| ----------- | -------------------------------------------------------------------------------- |
| `serialize` | the default; the later writer gains an ordering edge                             |
| `lane`      | both writers get lane annotations when either asks for one, and no ordering edge |
| `fail`      | `compile` fails with `overlap_forbidden`, for flows that promise disjointness    |

`fail` dominates `lane`, which dominates `serialize`. Each annotation also carries the runtime strategy the pair resolved to, where `stop-merge` dominates `delay-rebase`; that is what the scheduler does when the predicted overlap actually bites. Nodes frozen by an earlier generation are annotated on the new node only, because their rows are append-only.

## Node

[src/Node.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/src/Node.ts)

The pure, pipeable authoring AST. Building a node records an inspectable, closure-free, JSON-serializable description and executes nothing.

Map transforms; branch decides. Both branch arms are evaluated once, symbolically, so the exit condition and the handoff site are visible topology before anything runs. A plan is always a DAG, so there is no loop node: repetition lives one level up, in what a flow settles with.

A payload is stored as its inert JSON mirror. A data-valued callable `toJSON` is honoured, so a `Date` or a `URL` keys as the value it serializes to rather than as an empty object; a function or symbol member is dropped from an object and becomes `null` in an array; shared references and cycles clone as they were written. Accessors and unsupported prototypes without `toJSON` fail as `invalid_payload`, and a `toJSON` that returns its own receiver fails as `cyclic_payload` rather than collapsing to an empty object the way it once did. The clone and the input therefore key identically or refuse together.

`isNode` recognizes a node this package built by registration at construction, and a rehydrated node, an object sharing the node prototype whose own `ast` is a well-formed AST, by that shape, because `@smthrs/flow` hands an AST that crossed a serialization boundary back as a node. The `TypeId` marker is a public string any object can carry and counts for nothing on its own. Every combinator that admits a node reads its `ast` as trusted topology, so an object carrying the marker on any other prototype, one inheriting it from a node, and one whose `ast` is missing, malformed, or cyclic are all refused with the same `GraphBuildError` as any other non-node. A proxy is judged by the shape it forwards.

### Node.Node

```ts
interface Node<out A, out E = never, out R = never> extends Pipeable.Pipeable {
  readonly [TypeId]: {
    readonly _A: Types.Covariant<A>
    readonly _E: Types.Covariant<E>
    readonly _R: Types.Covariant<R>
  }
  readonly ast: Ast
}
```

A pure graph-building value. `R` is Effect's requirement channel and it is phantom here: nothing at plan time reads it, so building a plan stays requirement-free while the type still states which implementations executing it will need.

`Node.Any` is `Node<unknown, unknown, any>`. `Node.Success<N>`, `Node.Error<N>`, and `Node.Services<N>` extract the three parameters.

### Node.Ast

```ts
type Ast = Succeed | All | Map | AndThen | Branch | Catch | FlowCall | ActionCall
```

The inspectable AST a node stores: closure-free, and JSON serializable for every JSON payload an author puts in it. Every variant carries an optional `priority`.

### Node.TypeId

```ts
const TypeId: "~@smthrs/plan/Node"
```

The runtime type identifier carried by every node, and its own type. It is a public string, so it is a hint and never a capability.

### Node.FunctionIdentity

```ts
type FunctionIdentity = {
  readonly _tag: "FunctionIdentity"
  readonly algorithm: "sha256-source-ephemeral/v4" | "sha256-source-captures/v4" | "static-node/v1"
  readonly digest: string
}
```

The serializable stand-in an AST keeps for a plan-time function: a digest of its normalized source, hashed in place of a closure that could not be shipped, stored, or compared.

### Node.isNode

```ts
const isNode: (value: unknown) => value is Any
```

Checks whether a value is a node, by construction registration or by the shape a rehydrated node forwards.

### Node.succeed

```ts
const succeed: <A>(value: A) => Node<Succeed<A>>
```

A node that succeeds with the constant’s inert JSON projection, typed as `Succeed<A>`. Dates produce `string | null` (an invalid date produces `null`); URLs produce strings. Callable `toJSON` results are projected recursively. Function and symbol members are omitted from objects and become `null` in arrays. Planned references resolve to their referenced result types. Use `Node.map` to reconstruct a domain value explicitly.

### Node.all

```ts
const all: <const Nodes extends Readonly<Record<string, Any>>>(
  nodes: Nodes
) => Node<
  Types.Simplify<{ readonly [K in keyof Nodes]: Success<Nodes[K]> }>,
  Error<Nodes[keyof Nodes]>,
  Services<Nodes[keyof Nodes]>
>
```

Combines independent children into one node, keyed by name. Width is fixed at plan time. A non-node member throws `invalid_all_member` naming that member.

### Node.map

```ts
const map: {
  <A, B>(f: (a: A) => B): <E, R>(self: Node<A, E, R>) => Node<B, E, R>
  <A, E, R, B>(self: Node<A, E, R>, f: (a: A) => B): Node<B, E, R>
}
```

Transforms an eventual success value with a deferred pure function. The function is digested, not run: it executes later, on the real value. A `map` that decides what happens next is a `branch` written wrongly.

### Node.andThen

```ts
const andThen: {
  <B, E2, R2>(next: Node<B, E2, R2>): <A, E, R>(self: Node<A, E, R>) => Node<B, E | E2, R | R2>
  <A, E, R, B, E2, R2>(self: Node<A, E, R>, next: Node<B, E2, R2>): Node<B, E | E2, R | R2>
}
```

Starts the entire next subtree only after the first node succeeds, without consuming its result. Failure or interruption prevents nested actions, combinations, and inline flows from starting. Independent children inside the next subtree can still run concurrently once the boundary opens. Passing a callback is a type error and throws `invalid_continuation` in JavaScript.

### Node.bindPlanned

```ts
const bindPlanned: {
  <A, B, E2, R2>(
    build: (reference: Planned.Planned<A>) => Node<B, E2, R2>
  ): <E, R>(self: Node<A, E, R>) => Node<B, E | E2, R | R2>
  <A, E, R, B, E2, R2>(
    self: Node<A, E, R>,
    build: (reference: Planned.Planned<A>) => Node<B, E2, R2>
  ): Node<B, E | E2, R | R2>
}
```

Builds a dependency at plan time using a reference to the future result. Pass it into payloads; use `Node.map` for value computation and `Node.branch` for decisions. The callback receives a symbolic reference. Enable type-aware ESLint's `@typescript-eslint/strict-boolean-expressions` to reject planned conditions; explicit Boolean coercion and reference equality still require review.

Migration: replace callback-form `Node.andThen` with `Node.bindPlanned`. Direct node sequencing remains `Node.andThen`. This source API change preserves existing AST and key formats.

`bindPlanned` builds dependencies, not a whole-subtree success barrier. Members
that do not consume the reference can start while its producer runs. Use
explicit `andThen` when no work in the next subtree may start before success.
The corrected graph normalization now carries that explicit barrier to every
descendant, including inline-flow bodies. This changes compiled keys/digests
for previously under-ordered nested sequences; re-plan affected work rather
than substituting the new graph into an already approved execution.

### Node.BranchOptions

```ts
interface BranchOptions<A, B1, E1, R1, B2, E2, R2> {
  readonly if: (value: A) => boolean
  readonly then: (value: Planned.Planned<A>) => Node<B1, E1, R1>
  readonly else: (value: Planned.Planned<A>) => Node<B2, E2, R2>
}
```

`if` runs at run time on the real value. `then` and `else` run at plan time, once each, against a `Planned` placeholder.

### Node.branch

```ts
const branch: {
  <A, B1, E1, R1, B2, E2, R2>(
    options: BranchOptions<A, B1, E1, R1, B2, E2, R2>
  ): <E, R>(self: Node<A, E, R>) => Node<B1 | B2, E | E1 | E2, R | R1 | R2>
  <A, E, R, B1, E1, R1, B2, E2, R2>(
    self: Node<A, E, R>,
    options: BranchOptions<A, B1, E1, R1, B2, E2, R2>
  ): Node<B1 | B2, E | E1 | E2, R | R1 | R2>
}
```

Decides between two arms, both of them static topology. The predicate function is snapshotted at construction; replacing `options.if` later does not change the chosen arm. Both arms contribute their requirements, because a run has to be able to take either. An arm that does not return a node throws `invalid_continuation`.

### Node.CatchOptions

```ts
interface CatchOptions<E, B, E2, R2 = never, Handled = E> {
  readonly error?: Schema.Schema<Handled> | undefined
  readonly onFailure: (error: Planned.Planned<Handled>) => Node<B, E2, R2>
}
```

The statically planned recovery arm and the optional schema selecting which typed failures it handles.

### Node.catch

```ts
const catch: {
  <Handled, B, E2, R2>(
    options: CatchOptions<unknown, B, E2, R2, Handled> & { readonly error: Schema.Schema<Handled> }
  ): <A, E, R>(self: Node<A, E, R>) => Node<A | B, E | E2, R | R2>
  <E, B, E2, R2>(
    options: CatchOptions<E, B, E2, R2> & { readonly error?: undefined }
  ): <A, R>(self: Node<A, E, R>) => Node<A | B, E2, R | R2>
  <A, E, R, Handled, B, E2, R2>(
    self: Node<A, E, R>,
    options: CatchOptions<E, B, E2, R2, Handled> & { readonly error: Schema.Schema<Handled> }
  ): Node<A | B, E | E2, R | R2>
  <A, E, R, B, E2, R2>(
    self: Node<A, E, R>,
    options: CatchOptions<E, B, E2, R2> & { readonly error?: undefined }
  ): Node<A | B, E2, R | R2>
}
```

Recovers from matching typed failures with static failure topology. With no schema the whole typed error channel is handled. A schema handles only values it accepts, so schema-filtered overloads retain `E | E2`: refinements can reject values without narrowing their TypeScript type. The filter’s JSON Schema and runtime function identities both enter the catch key. Uncaptured schema callbacks have process-local identity and cannot enter a stable graph. For stable custom checks, construct `SchemaAST.Filter` with a `Node.capture`-annotated `run` function and declare all semantic captures; `Schema.makeFilter` wraps its predicate in an opaque closure.

### Node.priority

```ts
const priority: {
  (value: number): <A, E, R>(self: Node<A, E, R>) => Node<A, E, R>
  <A, E, R>(self: Node<A, E, R>, value: number): Node<A, E, R>
}
```

Attaches a scheduling priority, leaving the original node unchanged. Higher runs first among ready work, so a priority changes latency and nothing else. It never enters key material. Children inherit the value lexically when the graph is built, and a child that states its own keeps it. A value that is not a safe integer throws `invalid_priority`.

### Node.declaredPriority

```ts
const declaredPriority: (ast: Ast) => number | undefined
```

Reads the priority a node carries, or `undefined` when it states none and inherits from whatever encloses it.

### Node.capture

```ts
const capture: <Args extends ReadonlyArray<unknown>, A>(
  captures: Readonly<Record<string, unknown>>,
  operation: (...args: Args) => A
) => (...args: Args) => A
```

Declares the inert values a plan-time function closes over, which gives that function deterministic identity instead of process-local entropy. The capture record is canonicalized into function identity and deeply frozen immediately. Unsupported values, accessors, exotic prototypes, symbols, cycles, and member nesting beyond 256 levels throw a `TypeError` naming the path, instead of producing an identity that cannot describe the function's behavior.

Plan uses the capture and function-identity implementation from `@smthrs/core/Node`. Capturing an already-captured function preserves its original source and folds both capture sets into the identity. Wrappers can be captured and identified interchangeably by either package. A non-function operation throws `TypeError("Node.capture requires a function operation")`.

### Node.plannedReference

```ts
const plannedReference: (value: unknown) => {
  readonly _tag: "PlannedReference"
  readonly node: string
  readonly path: ReadonlyArray<string>
} | undefined
```

Reads the inert AST reference created for a planned value. Structural lookalikes remain ordinary payload data: the marker is private to the AST cloner, so this accessor is the only recognition path.

### Node.branchSubject and Node.catchSubject

```ts
const branchSubject: "branch/subject"
const catchSubject: "catch/subject"
```

The node reference a branch arm's symbolic subject carries, and the prefix each `catch` mints its own token under. Arms are built before the graph assigns ids, so every reference an arm records names one of these placeholders, and graph building rewrites it to the node the arm belongs to.

### Engine members

`flowCall`, `actionCall`, `declaration`, `continuation`, `mapper`, `predicate`, `catchFilter`, and `functionIdentity` exist for [`@smthrs/flow`](/api/flow), which owns flow and action authoring. They are supported names, not authoring API.

```ts
const flowCall: <A = unknown, E = never, R = never>(
  declaration: unknown,
  flow: string,
  mode: "inline" | "boundary" | "handoff",
  payload: unknown
) => Node<A, E, R>

const actionCall: <A = unknown, E = never, R = never>(
  declaration: unknown,
  action: string,
  payload: unknown
) => Node<A, E, R>

const declaration: (ast: Extract<Ast, { readonly _tag: "ActionCall" | "FlowCall" }>) => unknown
const continuation: (
  ast: Extract<Ast, { readonly _tag: "AndThen" }>
) => ((value: Planned.Planned<unknown>) => unknown) | undefined
const mapper: (ast: Ast) => ((value: unknown) => unknown) | undefined
const predicate: (ast: Ast) => ((value: unknown) => boolean) | undefined
const catchFilter: (ast: Ast) => Schema.Top | undefined
const functionIdentity: (operation: unknown) => FunctionIdentity
```

`flowCall` and `actionCall` validate nothing: an unknown tag becomes a call node the graph keeps as a leaf. `declaration`, `continuation`, `mapper`, `predicate`, and `catchFilter` answer `undefined` for the wrong variant and for an AST rehydrated from JSON, whose side tables did not survive serialization. `functionIdentity` throws a `TypeError` when handed anything but a function.

## Planned

[src/Planned.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/src/Planned.ts)

A planned value may be passed into a payload field, into a branch, or into a map, and field access is allowed, because it records a reference path.

:::danger
A planned value may never be computed on.
:::

Misuse fails twice. The type is branded, so arithmetic on a planned value is a compile error; and the proxy's `Symbol.toPrimitive`, `valueOf`, `toString`, `toJSON`, application, `in`, and enumeration traps throw rather than let a plan be built around `NaN` or `"[object Object]"`, which catches template interpolation, `String(value)`, and `JSON.stringify` of a payload holding one. JavaScript exposes no trap for `Boolean(value)` or strict identity, so those cannot be refused at run time; they reveal only proxy truthiness or identity and never the planned result.

The `TypeId` symbol is interned, so a value that crossed a module boundary is still recognised. Interning is a recognition aid rather than a capability, so `reference` returns a reference only when the value stored under that symbol has the complete `{node, path}` shape.

### Planned.Planned

```ts
type Planned<T> =
  & { readonly [TypeId]: Identity<T> }
  & ([T] extends [object] ? { readonly [K in keyof T]: Planned<T[K]> } : unknown)
```

A step result that has not been produced yet. The mapped half keeps field access typed, so `result.files` is a `Planned` of the field.

### Planned.Reference and Planned.Identity

```ts
interface Reference {
  readonly node: string
  readonly path: ReadonlyArray<string>
}

interface Identity<out T> extends Reference {
  readonly _T: Types.Covariant<T>
}
```

What a planned value points at: the node that will produce the result, and the property path read from it. `path` is empty for the result itself.

### Planned.TypeId

```ts
const TypeId: unique symbol // Symbol.for("@smthrs/plan/Planned")
```

The brand carried by every planned value, and the key its reference is read from.

### Planned.make

```ts
const make: <T>(node: string) => Planned<T>
```

Creates the strict placeholder standing for a node's result. Planning hands one to every builder that consumes an upstream value, then reads the `Reference` back off whatever the builder passed it into.

### Planned.reference

```ts
const reference: (value: unknown) => Reference | undefined
```

Reads the reference a planned value records, or `undefined` for anything else. A forged carrier is accepted only when its node and path have the complete reference shape. This is how a payload is scanned for the upstream results it consumes.

### Planned.isPlanned

```ts
const isPlanned: (value: unknown) => value is Planned<unknown>
```

Checks whether a value is a planned placeholder.

## FileSet

[src/FileSet.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/src/FileSet.ts)

The static filesystem declaration vocabulary shared by planning and execution: a workspace-relative `Pattern`, a Bazel-style `Glob`, a `TreeArtifact`, and the `Filegroup` that names a reusable collection.

`canonical` rewrites every separator to `/` and normalizes to Unicode NFC, and every exact-path comparison goes through it, so the backslash spelling and the NFD spelling of one workspace path overlap. `workspaceRelative` refuses absolute paths, drive letters, `..` and `.` segments, empty segments, the C0 control range, and DEL. C1 bytes stay legal, because a POSIX file name may contain them.

`overlaps` is conservative: `true` may over-serialize, while `false` proves that no path can belong to both declarations.

### The declaration types

```ts
const Pattern: Schema.String // workspace-relative, with `*` and `**`
const Glob: Schema.TaggedStruct<"Glob", { include: NonEmptyArray<Pattern>; exclude?: Array<Pattern> }>
const TreeArtifact: Schema.TaggedStruct<"TreeArtifact", { path: Pattern }>
const Filegroup: Schema.TaggedStruct<"Filegroup", { name: NonEmptyString; entries: Array<Entry> }>
const ReadFilegroup: Schema.TaggedStruct<"Filegroup", { name: NonEmptyString; entries: Array<ReadEntry> }>

type Entry = Pattern | Glob | TreeArtifact
type ReadEntry = Pattern | Glob
type Declaration = Entry | Filegroup
type ReadDeclaration = ReadEntry | ReadFilegroup
```

Each is exported as both a schema and a type. `Declaration` is what a write set accepts and `ReadDeclaration` what a read set accepts, which is how a tree artifact is kept out of a read set: a read set names what a node consumes, and a directory output is not that.

### FileSet.canonical

```ts
const canonical: (path: string) => string
```

The canonical spelling of a declared path or pattern: every separator is `/`, and Unicode is normalized to NFC.

### FileSet.workspaceRelative

```ts
const workspaceRelative: (pattern: string) => boolean
```

Whether a declared path stays inside the workspace and names it one way only. Refuses absolute paths (POSIX and drive-letter), upward traversal, the aliasing forms (`.` segments, empty segments), C0 controls, and DEL.

### FileSet.makeFilegroup

```ts
const makeFilegroup: (name: string, entries: ReadonlyArray<Entry>) => Filegroup
```

Creates a named filegroup.

### FileSet.expand and FileSet.expandReads

```ts
const expand: (declarations: ReadonlyArray<Declaration>) => ReadonlyArray<Entry>
const expandReads: (declarations: ReadonlyArray<ReadDeclaration>) => ReadonlyArray<ReadEntry>
```

Expands filegroups deterministically, preserving declaration order. Both plan passes expand before they compare anything.

### FileSet.isGlob and FileSet.isTreeArtifact

```ts
const isGlob: (value: unknown) => value is Glob
const isTreeArtifact: (value: unknown) => value is TreeArtifact
```

Which variant an entry is.

### FileSet.matchesPattern and FileSet.matchesGlob

```ts
const matchesPattern: (pattern: string, path: string) => boolean
const matchesGlob: (glob: Glob, path: string) => boolean
```

Bazel's `*` and `**` path semantics without permitting traversal: `*` matches within one segment, `**` matches segments, and a trailing `**` matches the rest of the path. `matchesGlob` honours the glob's `exclude` list.

Matching consumes the entire path, including Unicode line separators. Compiled
matchers are cached by canonical pattern spelling. Segment matching is linear
in the segment and pattern lengths; recursive matching visits each pattern/path
segment pair once, without regex backtracking.

### FileSet.overlaps

```ts
const overlaps: (left: Entry, right: Entry) => boolean
```

Conservative static overlap. Exact paths compare in canonical separator and NFC form. Two globs always overlap, and so do a glob and a tree artifact. A tree artifact overlaps any path beneath it. A glob tests the path bytes it is handed, so canonicalizing a measured path before matching is the caller's decision.

## GraphBuildError

[src/GraphBuildError.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/src/GraphBuildError.ts)

The refusals a plan-time build raises instead of producing a wrong plan. Each carries the site, `node` plus the recorded property `path`, and states the fix in `message`, because the author reading it is mid-body.

### GraphBuildError.GraphBuildError

```ts
class GraphBuildError extends Schema.TaggedError<GraphBuildError>()("@smthrs/plan/GraphBuildError", {
  code: typeof GraphBuildErrorCode
  node: Schema.String
  path: Schema.Array$<Schema.String>
  message: Schema.String
})
```

`node` is the node reference the failure belongs to: a planned value's origin node, an `all` member name, or a branch arm. `path` is the property path recorded on a planned value before it was misused, and the payload path for a payload refusal. It is empty for every other code.

### GraphBuildError.GraphBuildErrorCode

| `code`                        | Meaning                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `planned_value_computed`      | a body computed on a step result                                                               |
| `invalid_all_member`          | `Node.all` received a non-node member                                                          |
| `invalid_continuation`        | a branch arm, catch arm, or continuation did not return a node                                 |
| `recursion_requires_boundary` | a flow calls itself inline instead of using a trampoline handoff or an explicit child boundary |
| `placement_requires_boundary` | an inline call's callee declares a placement the enclosing flow cannot satisfy                 |
| `cyclic_payload`              | a payload contains itself, so no plan could serialize or hash it                               |
| `payload_too_deep`            | a payload is nested past the build bound                                                       |
| `graph_too_deep`              | authored topology is nested past the build bound                                               |
| `duplicate_node`              | two structural graph addresses resolve to one durable node id                                  |
| `invalid_priority`            | `Node.priority` received a value that is not a safe integer                                    |
| `invalid_payload`             | a payload member cannot be captured as inert JSON without executing code or losing identity    |

`GraphBuildErrorCode` is a closed schema literal, so a caller may switch on it and a new refusal is a deliberate addition rather than a new free-form string. This package raises `planned_value_computed`, `invalid_all_member`, `invalid_continuation`, `invalid_priority`, `invalid_payload`, and `cyclic_payload`; the rest come from [`@smthrs/flow`](/api/flow)'s graph walk, which shares the vocabulary.

## PlanDiff

[src/PlanDiff.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/src/PlanDiff.ts)

The verdict is the key: two nodes with the same id and the same key are the same step. The attribution, `changed: ["body", "input[1]"]`, is a report for a human, derived by comparing declarations field by field, and is deliberately part of no digest. Labels mirror the hashed declaration: `kind` (the effect tier, which selects the key namespace), `body`, `layers`, `capabilities`, `effects`, `version`, `nondeterministic`, `placement`, and `input[n]`, including `input[n]` entries whose declaration is unchanged but whose referenced node itself re-keyed. A node re-keyed purely by an upstream edit is therefore attributed to the input position that references it, even behind an unprojected `Pending`, rather than reported as nothing changed.

Each compared field is projected through the same JSON mirror the keys are derived from, so two `Date` bodies a generation apart attribute to `body` rather than to nothing. The projection runs no accessor, and a field it refuses compares by an identity token scoped to that node and field, so `diff` stays a total function even for a value canonical serialization would reject.

### PlanDiff.PlanDiff

```ts
interface PlanDiff {
  readonly added: ReadonlyArray<string>
  readonly removed: ReadonlyArray<string>
  readonly rekeyed: ReadonlyArray<Rekeyed>
  readonly unchanged: ReadonlyArray<string>
}
```

What changed between two plans of the same flow, as node ids.

### PlanDiff.Rekeyed

```ts
interface Rekeyed {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly changed: ReadonlyArray<string>
}
```

A node whose key moved, with the field labels that moved it. `changed` is empty only when none of the compared fields moved.

### PlanDiff.diff

```ts
const diff: (previous: Plan.Plan, next: Plan.Plan) => PlanDiff
```

Compares a plan against the last plan for the same flow. Pure, total, and free of requirements.

## PlanStore

[src/PlanStore.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/src/PlanStore.ts)

`record` is first-writer-wins: an identical re-record is not an error, and a different plan under the same id is a `Conflict` carrying the stored digest rather than a silent overwrite. It accepts generation 0 only, whose `baseDigest` equals its `digest` and every one of whose nodes is at generation 0. `get` returns the verified immutable plan with nodes in recorded order. Admission and reads recompute keys, approval digests, topology, effect ordering and generation relationships. A forged incoming plan fails with `invalid_plan` before writes; corrupt stored content fails with `decode_failed`, including on duplicate admission. Envelope and nodes are read in one SQL statement to avoid mixed generations during concurrent appends.

`append` advances the plan row with a compare-and-swap on the previous generation, the flow, the approved base digest, and the approval digest of the append's already-verified prefix, and it refuses an append that adds no nodes. Matching the prefix digest proves the recorded prefix is the caller's without re-reading the stored rows. The refusal matters because of the append-only triggers: without it the node rows would land while the plan-row update matched nothing or skipped a generation, leaving rows whose dependencies are missing and that nothing is allowed to delete. The whole append is one transaction, so the refusal takes the rows back with it. New ordinals continue the recorded prefix, whose length the matched digest proves equal to the caller's prefix.

Every failure is a `PlanStoreError` whose `code` is one of `invalid_plan`, `constraint`, `decode_failed`, `persistence_failed`, or `unknown`.

### PlanStore.Service

```ts
interface Service {
  /** Records generation 0 of a plan. */
  readonly record: (plan: Plan.Plan, createdAtMs: number) => Effect.Effect<RecordResult, PlanStoreError>
  /** Appends the newest generation's nodes and edges and advances the digest. */
  readonly append: (plan: Plan.Plan) => Effect.Effect<void, PlanStoreError>
  /** Reads the whole plan back, nodes in recorded order. */
  readonly get: (planId: string) => Effect.Effect<Option.Option<Plan.Plan>, PlanStoreError>
}
```

`createdAtMs` comes from the caller's clock. Constructing the store requires `Crypto.Crypto` alongside SQL and the durable writer; individual operations use that captured implementation.

### PlanStore.RecordResult

```ts
type RecordResult =
  | { readonly _tag: "Recorded" }
  | { readonly _tag: "ExistingSame" }
  | { readonly _tag: "Conflict"; readonly digest: string }
```

`Conflict.digest` is the digest already stored under that plan id. Nothing was written.

### PlanStore.PlanStore

```ts
class PlanStore extends Context.Service<PlanStore, Service>()("@smthrs/plan/PlanStore") {}
```

The service tag.

### PlanStore.make

```ts
const make: Effect.Effect<Service, never, DurableWriter | SqlClient.SqlClient | Crypto.Crypto>
```

Builds the SQL-backed store.

### PlanStore.layer

```ts
const layer: Layer.Layer<PlanStore, never, DurableWriter | SqlClient.SqlClient | Crypto.Crypto>
```

Provides `make`.

### PlanStore.PlanStoreError

```ts
class PlanStoreError extends Schema.TaggedError<PlanStoreError>()("@smthrs/plan/PlanStoreError", {
  code: typeof PlanStoreErrorCode
  message: Schema.String
  cause: Schema.optional<Schema.Unknown>
})
```

| `code`               | Meaning                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `invalid_plan`       | the plan does not satisfy what the operation requires, or a node is not encodable         |
| `constraint`         | the compare-and-swap matched nothing, the persisted prefix diverged, or SQL refused a row |
| `decode_failed`      | a stored row did not decode                                                               |
| `persistence_failed` | the SQL layer failed for a reason that is not a constraint violation                      |
| `unknown`            | anything else, with `cause` carrying the original                                         |

`PlanStoreErrorCode` is exported as both a schema and a type.

## Migrations

[src/Migrations.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/src/Migrations.ts)

The namespaced set owns `flows_plans`, `flows_plan_nodes`, and `flows_plan_edges`
in id block `4000`, after journal (`0`), run store (`1000`), step cache (`2000`),
and engine store (`3000`). [`@smthrs/engine-store`](/api/engine-store)'s
`Migrations.sets` composes all five. The database loader handles forward
additions to already installed lower blocks before the ordinary migration pass;
earlier holes and entirely new lower blocks are refused rather than skipped.

The ordered steps live under `src/internal/migrations`, which the export map blocks, so `set` is the only way to reach them; a step imported on its own would run outside the namespaced ordering that migrator relies on.

### Migrations.set

```ts
const set: DatabaseMigrations.MigrationSet // namespace "plan", idOffset 4000
```

The namespaced migration set, for composition with the other storage packages.

### Migrations.run and Migrations.layer

```ts
const run: Effect.Effect<void, ..., SqlClient.SqlClient>
const layer: Layer.Layer<never, ..., SqlClient.SqlClient>
```

`run` creates the plan schema. `layer` runs the migrations before exposing the database to the plan store, which is what a standalone composition uses.

### The migrations

Append-only is enforced in SQL rather than by convention.

| Step                         | What it does                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001_initial`               | Creates the three tables, the `flows_plan_nodes_order` index, and triggers that raise on any UPDATE or DELETE of a node or edge row and on any backward move of a plan row.     |
| `0002_append_only_hardening` | Forbids deleting a plan row, extends the forward-only trigger to pin `flow` and `created_at_ms`, and makes `(plan_id, ordinal)` unique so recorded node order is deterministic. |
| `0003_forward_only_identity` | Recreates the forward-only trigger with `plan_id` pinned, so a forward UPDATE cannot rename a plan and strand its immortal node and edge rows under the old id.                 |
