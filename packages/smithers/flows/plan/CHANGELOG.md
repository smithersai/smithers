# @smthrs/plan

## [Unreleased]

### Added

- `Scheduling.make` exposes the pure ready-work priority, aging and capacity
  policy used by the durable plan scheduler. Its exact integer comparison does
  not round away priority differences after aging. Conditional readiness and
  effect execution remain the coordinator's responsibilities.

### Fixed

- `StepKey.EnvironmentIdentity` now also supplies the runtime schema. Identity
  constructors reject malformed/unknown environment fields with typed errors.
  `StepKey.environmentIdentity` fingerprints a runtime environment for durable
  recovery binding, using content-key normalization in a separate namespace.
  Existing valid content and dispatch keys are unchanged.

- Explicit `Ref`/`Pending` read-before-write sequences compile and verify,
  including transitive paths and appended generations. Conflicting inferred
  producer/serialize orders still fail with `cycle`.

- `Plan.compile`, `append`, and `verify` accept compensable and irreversible
  declarations. New `StepKey.planIdentity` separates their approval fingerprints
  from cache eligibility. Existing sealed keys are unchanged;
  `fromKeyMaterial` and `dispatchIdentity` remain sealed-only.

## [1.0.0-rc.0] - 2026-08-31

### Added

- The persisted plan: `Plan` (compile, append, conflict annotation),
  `PlanStore` (append-only SQL, migration block `4000`), `PlanDiff`, and the
  `KeyMaterial` to `StepKey` compiler revived from the deleted
  `packages/smithers/flows/keys` modules, now producing `@smthrs/keys` `Key`
  values rather than a second digest format.
- Added `Node.priority`, which attaches a scheduling priority to a node, and
  `Node.declaredPriority`, which reads one back. The value is a plain JSON
  field on the AST rather than a `Context` annotation, so a stored plan keeps
  it. `Plan.compile` copies it from `NodeDraft.priority` onto the plan node and
  folds it into the plan digest a human approves; it never enters a node's key
  material, so raising a priority reorders work without re-keying a step. A
  priority that is not a safe integer is a `GraphBuildError` with the new
  `invalid_priority` code.
- Added package-owned documentation. `packages/plan/docs` and the public JSDoc
  in `src` are the single source for the published API page.

### Breaking Changes

- Bumped key material to `flows/key-material/v2` and captured-function
  identity to `sha256-source-captures/v4`. Existing persisted step keys are
  intentionally invalidated rather than being reused across changed identity
  semantics.

- Plan approval digests now include each node's conflict and runtime
  strategies. This moves plan digests without moving step keys. A running run
  pinned to the old digest needs a new approval before it can use the changed
  plan.
- A node payload is now cloned as its JSON mirror, so a payload carrying a
  `toJSON`, such as a `Date` or a `URL`, keys as the value it serializes to
  rather than as an empty object. Payloads of that shape re-key once.
- A flow call's `KeyMaterial.body` no longer has a body-less shape. `Flow.make`
  requires `body`, so `@smthrs/flow` never records `declaration.body:
  undefined` for a call whose declaration survived beside its AST.
  `StepKey.content` therefore folds a body digest into every such node, and the
  keys `Plan.compile` derives for the flow calls that previously carried none
  move with it.
- The raw migration steps moved beneath `src/internal/migrations`, so
  `@smthrs/plan/migrations/0001_initial` and its siblings no longer resolve.
  `Migrations.set` is the supported surface; a step imported on its own ran
  outside the namespaced ordering `Migrator` relies on.
- `Node.isNode` no longer accepts the public `TypeId` marker on its own. It
  recognizes a node this package built by registration at construction, and a
  rehydrated node, an object sharing the node prototype whose own `ast` is a
  well-formed AST, by that shape, which is what `@smthrs/flow` hands back for
  an AST that crossed a serialization boundary. `Node.all`, `andThen`,
  `branch`, and `catch` therefore refuse a forged object carrying the marker,
  one inheriting it from a node, and one whose `ast` is missing, malformed, or
  cyclic with their usual `GraphBuildError` instead of storing an `ast` the
  package never built.
- `StepKey.EnvironmentIdentity` is now a discriminated union. A declared
  environment may not carry a `runScope` and an undeclared one must, which
  `StepKey.dispatchIdentity` also enforces at run time with the new
  `invalid_environment` code.
- A plan may no longer contain an unbounded number of nodes. `Plan.compile` and
  `Plan.append` refuse a plan above `Plan.maximumPlanNodes` with the new
  `graph_too_large` code, before any pair comparison runs. The conflict pass
  compares node pairs and adds a reachability walk per overlapping pair, so an
  unbounded plan had an unbounded planning cost; a graph larger than the bound
  now has to be split.
- `NodeDraft.effects` is now the single derivation point for effect identity.
  `Plan.compile` and `Plan.append` fold the decoded declaration into the hashed
  material, replacing any `material.effects` a caller supplied. Every plan
  re-keys once, and editing `reads`, `writes`, `removes`, or `boundaryMode`
  now re-keys the node and is attributed by `PlanDiff` as `effects`. Before
  this, the two channels were independent: a draft could change what a node
  writes without moving its key, and `PlanDiff` reported it `unchanged`.
- Compiled material is stored as its deeply frozen JSON mirror. A `Date`, a
  `URL`, or any value with a data-valued callable `toJSON` is stored as the
  value it serializes to, which is what its key already covered. A material
  accessor or a prototype with no JSON representation is now refused with
  `invalid_node` rather than passed through by reference; the message names the
  node and the payload path and never the value.
- A payload whose `toJSON` returns its own receiver now fails with the
  `cyclic_payload` `GraphBuildError` instead of being silently omitted from the
  clone. The clone and the input now agree: canonical serialization refused
  that shape all along, while the clone quietly keyed as `{}`.

### Fixed

- The migration steps under `internal/migrations` are named exports, and
  `Migrations` imports them by name. The CommonJS build compiled each
  `export default` step to `exports.default`, and Node's default-import interop
  then handed the importer the whole exports object instead of the Effect, so
  `require("@smthrs/plan/Migrations")` produced a set whose entries had no
  `pipe`.
- Plan payload capture now refuses accessors and unsupported prototypes with
  `invalid_payload` instead of executing getters or collapsing `Map`, `Set`,
  `RegExp`, and class instances onto the same `{}` identity.
- `StepKey.content` and `dispatchIdentity` now share one environment validator;
  undeclared environments require a non-empty run scope on both paths.

- `PlanStore.append` now advances the stored plan row with a compare-and-swap
  on the previous generation, so appending a skipped generation is refused
  instead of persisting node rows whose dependencies are missing and which the
  append-only triggers then forbid removing. Node ordinals are derived from the
  store rather than from the caller's array, `PlanStore.record` refuses
  anything that is not generation 0, and an append with no new nodes is
  refused rather than advancing the generation for nothing.
- A node payload no longer keeps live functions, and different `Date`, `URL`
  or other `toJSON` payloads no longer share one step key.
- `StepKey.fromKeyMaterial` resolves dependency digests as own properties, so a
  dependency named `toString` or `constructor` is a `missing_dependency`
  refusal rather than a colliding key.
- A `StepKey.DigestMemo` waiter no longer inherits the leader's interruption;
  it recomputes its own digest instead.
- `StepKey.project` resolves only own data properties, so a projection path
  through `toString`, `constructor` or `__proto__` yields `undefined` as
  documented and no getter runs during key derivation.
- The conflict pass now decides orderedness against the live edge set, so a
  writer pair a dependency path already orders is neither annotated, nor given
  a redundant edge, nor refused with `overlap_forbidden`.
- `Plan.compile` now fails with `cycle` when a reader-after-writer edge would
  close a cycle, because a declared dependency or a `serialize` edge already
  orders the producer behind its reader. The edge was dropped before, which
  left the reader ahead of its producer to measure and cache pre-producer
  bytes as a legitimate execution. The message names the reader, the producer,
  the overlapping paths, and the dependency chain.
- `Plan.compile` no longer recurses per dependency edge and no longer
  materializes a transitive closure, so a large graph compiles in bounded
  memory instead of raising an untyped `RangeError`.
- `Plan.compile` and `Plan.append` validate drafts before keying, with the new
  `invalid_node` code, so an empty plan id, an unsafe-integer priority, or a
  key material version this release does not know is refused at the plan rather
  than at the store.
- `PlanDiff` attributes a key move caused by `nondeterministic` or `placement`,
  and `Node.capture` refuses a capture nested past its documented limit with a
  path-bearing error rather than overflowing the stack.
- `Plan.compile` and `Plan.append` decode `NodeDraft.effects` through
  `NodeEffects` before keying, so a malformed declaration is a typed
  `invalid_node` naming the node and the failing path instead of an untyped
  defect. A filesystem declaration containing C0 controls or DEL, or one that is
  not workspace-relative, is refused there rather than reaching a host
  filesystem, and path comparison is Unicode NFC normalized, so two spellings of
  one name are detected as an overlap. `invalid_effects` is now reserved for the
  cross-field rule that one path cannot be both a write and a removal.
- `Planned.reference` validates the reference shape, so a forged carrier can no
  longer inject a fabricated projection path into a payload.
- Compiled and appended plans now keep the exact material and filesystem
  authority that their keys and approval digest cover, even if caller-owned
  draft objects are later mutated.
- Persisted plans can no longer be deleted or have their plan id, flow, or
  creation time rewritten, and node order is now unique and deterministic within
  each plan. Migration `4003` adds the plan-id pin the forward-only trigger was
  missing, which a rename could otherwise use to strand a plan's immortal node
  rows under an id nothing can record again.
