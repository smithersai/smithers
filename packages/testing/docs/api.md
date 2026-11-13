---
title: "API reference"
description: "Every public export of @smthrs/testing: the tier layers, plan and journal assertions, the engine subject port and its conformance suite, the host suite, the record-and-replay model doubles, score gates, typed failures, and the process fault primitives."
---

`@smthrs/testing` exports module namespaces from its root entry point.
Import a namespace from the root or use a declared package subpath:

```ts
import { Conformance, EngineSubject, TestLayers } from "@smthrs/testing"
// or
import * as TestLayers from "@smthrs/testing/TestLayers"
```

Seven modules are reachable only by subpath. `TestHost` is the deterministic
host bundle and stays explicit at `@smthrs/testing/TestHost`. `Vitest` is ESM only, because
`vitest` refuses to load through `require()` and a barrel that carried it would
break `require("@smthrs/testing")` for every CommonJS consumer of the assertion
helpers. `Faults` is a set of real, machine-global process primitives rather
than a double, and keeping it off the barrel keeps that visible at the import
site.
`ProcessTable` spawns `ps` through `node:child_process`, which browser test
hosts cannot load, so it lives at `@smthrs/testing/ProcessTable`.
`ModelServer` listens through `node:http`, `ModelServerCli` reads the fixture
file through `node:fs`, and `TurnLog` appends its trace through `node:fs`, so
they live at `@smthrs/testing/ModelServer`, `@smthrs/testing/ModelServerCli`
and `@smthrs/testing/TurnLog`.

`@smthrs/testing/internal/*` and `@smthrs/testing/*/index` are not public.
`@smthrs/testing/package.json` is exported.

The package holds no runner. Every assertion is an ordinary `Effect`, every
conformance case is a value a runner registers, and `Vitest` is a thin adapter.
Services and tags are Effect constructs: a `Layer` provides a service, and a
test body reads it from context.

## Example

```ts
import { Conformance, EngineSubject, FlowEngineLike } from "@smthrs/testing"
import { describe, it } from "@smthrs/testing/Vitest"
describe("engine conformance", () => {
  for (const c of Conformance.coreSuite()) {
    it.scoped(
      c.name,
      () => Effect.flatMap(EngineSubject.EngineSubject, c.run).pipe(Effect.provide(FlowEngineLike.layerMemory))
    )
  }
})
```

## Vitest

The Vitest adapter for scoped Effect test bodies, and the only module here that
imports a test runner. The runner boundary is also the only sanctioned
`AbortSignal` touch in the package: cancellation is converted to fiber
interruption at the edge, and the signal never crosses into Effect code.

```ts
import { describe, expect, it, testEffect } from "@smthrs/testing/Vitest"
```

### Vitest.it

```ts
const it: typeof EffectVitest.it & { readonly scoped: typeof EffectVitest.it.effect }
```

The Effect-aware `it`, with `scoped` aliased onto `it.effect`.

It is a fresh callable built as a `Proxy` over `@effect/vitest`'s own `it`,
never by writing into it. That module is externalized and shared across every
test file in a worker process, so mutating its exports would replace
`it.scoped` for every other file in that worker. A copy would not work either:
vitest defines the chainable members of `it` as accessors, which
`Object.assign` silently drops.

### Vitest.assert, Vitest.describe, Vitest.expect

Re-exported from `vitest` unchanged, so a suite needs one import.

### Vitest.TestEffect

```ts
interface TestEffect<R> {
  readonly effect: EffectTest<R>
  readonly live: EffectTest<R>
  readonly scoped: EffectTest<R>
  readonly skip: TestRegistration<R>
  readonly only: TestRegistration<R>
}
```

The Effect-aware registrars, each carrying the requirements `R` a body may use.
`effect` runs under the test clock; `live` runs under the real one. Every
variant already wraps its body in `Effect.scoped`, so `scoped` is an alias of
`effect` retained because a scoped body reads better under that name. Each
`EffectTest` also carries `skip` and `only`.

Each registration takes a name, a body, and an optional third argument that is
either a timeout in milliseconds or a vitest `TestOptions`.

### Vitest.testEffect

```ts
const testEffect: <R, E>(layer: Layer.Layer<R, E>) => TestEffect<R>
```

Builds a **fresh** environment from the supplied layer for every test case and
runs each body in its own `Scope`, so no state, including the deterministic
variant's `TestClock`, is shared between tests and no test can depend on
registration order.

## TestLayers

Deterministic test layer bundles. A tier is a layer set, not a class; see
[Test tiers](./concepts/test-tiers.md).

### TestLayers.unit

```ts
const unit: <R, E>(
  engine: Layer.Layer<EngineSubject, E, R>
) => Layer.Layer<
  EngineSubject | Journal | Kernel.GrantStore.GrantStore | TestHost.TestHost,
  Kernel.Permission.GrantStoreError | SqlError | MigrationError | JournalError | E,
  R
>
```

The unit-tier bundle: a deterministic `TestHost`, an in-memory `TestJournal`,
the supplied engine subject, and the **real** permission kernel. The
`GrantStore` is built unattended over a test `Workspace`, so a sealing
violation fails typed instead of suspending. Sealing violations fail in tests
exactly as they do in production, which is the point of not stubbing the
kernel.

### TestLayers.poisoned

```ts
const poisoned: Layer.Layer<Kernel.HostServices.HostService | ModelLike>
```

A plan-time bundle in which `FileSystem`, `Path`, the shell spawner, `Jj`, the
HTTP client, the model, the clock, and randomness all reject instead of
reaching a real environment. It deliberately does not provide an engine.

Each poisoned service is a `Proxy` whose property getter **throws** a
`CapabilityContractError` carrying the `capability` and the `operation`. A
throw is neither a function-valued answer (which made a synchronous data read
such as `Path.sep` succeed) nor an `Effect.fail` (which a plan body could
swallow with `Effect.catch`, `Effect.option`, or `Effect.result`). It fires on
a data read as loudly as on a method call, and `Effect.catchTag` cannot reach
it.

A small set of property names answers `undefined` instead of throwing, because
a runtime reads them to classify a value rather than to use it: `$$typeof`,
`_id`, `_op`, `_tag`, `asymmetricMatch`, `catch`, `constructor`, `finally`,
`inspect`, `nodeType`, `then`, `toJSON`, `toString`, and `valueOf`. That is
what lets a poisoned service still be stored, logged, and awaited past.

The poisoned model dies rather than fails, so a stream that reaches it is a
defect.

### TestLayers.poisonedClockAndRandom

```ts
const poisonedClockAndRandom: Layer.Layer<never>
```

Poisoned `Clock` and `Random` references, exported separately because both are
`Context.Reference`s with ambient defaults: their poisoning cannot appear in a
layer's output type. Provide this beneath a bundle and any unprovided time or
randomness access fails loudly instead of silently using the Effect defaults.
`poisoned` already includes it.

## PlanLike

Read-only plan introspection types. These are the shapes the plan assertions
read, so a caller can project any planner onto them.

### PlanLike.PlanLike

```ts
interface PlanLike {
  readonly nodes: ReadonlyArray<PlanNodeLike>
  readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string }>
  readonly envelope?: Record<string, unknown>
  readonly digest?: string
}
```

### PlanLike.PlanNodeLike

```ts
interface PlanNodeLike {
  readonly id: string
  readonly key: string
  readonly kind: string
  readonly placement?: PlanPlacementLike
  readonly effects: ReadonlyArray<string>
  readonly mode?: string
  readonly tier: string
  readonly sealed: boolean
}
```

The fields mirror what [`@smthrs/flow`](/api/flow)'s `Graph.GraphNode` carries.
`mode` is the boundary mode of the node's own effect declaration (`hard` or
`expected`), omitted when the node declared none. `tier` is the tier the node
is keyed under (`sealed`, `compensable`, or `irreversible`), and every node has
one. `effects` entries are declared `read:<path>`, `write:<path>`, and
`remove:<path>` strings, or an empty list when the node declared none.

There is no per-node conflict strategy or envelope: write overlap is
`Plan.compile`'s verdict, and an effect envelope is a build-time ceiling
`Graph.build` checks a declaration against rather than a fact it records on a
node.

### PlanLike.PlanPlacementLike

```ts
interface PlanPlacementLike {
  readonly tag: string
  readonly options: Readonly<Record<string, unknown>>
}
```

A serializable projection of a node's placement directive: the placement tag
plus its option payload.

## Plan

Pure projection and presentation helpers for built plans. Plan projection never
touches Host, Model, or Clock, and is expected to succeed under
`TestLayers.poisoned`.

### Plan.planOf

```ts
const planOf: <F extends Flow.Any>(
  flow: F,
  input: unknown,
  options?: PlanOfOptions
) => Effect.Effect<PlanLike, Schema.SchemaError, F["payloadSchema"]["DecodingServices"]>
```

Decodes the flow payload through the flow's declared payload schema, then
builds and projects the plan. Un-defaulted input cannot reach a plan: the
schema's defaults are applied by construction before planning sees the value.
Building and projecting are pure, so this fails only on schema decoding.

### Plan.fromGraph

```ts
const fromGraph: (graph: Graph.Graph, options?: FromGraphOptions) => PlanLike
```

Projects [`@smthrs/flow`](/api/flow)'s graph introspection API into a
`PlanLike`. Keys come from each node's draft material by default; the `key`
resolver in the options is a test-only override for fixtures that need
synthetic keys.

### Plan.keys

```ts
const keys: (graph: Graph.Graph, options?: KeysOptions) => Record<string, string>
```

Derives every node's step key from the graph's draft key material. Sealed
material becomes a content key through `StepKey.fromKeyMaterial`, with
dependency references resolved to previously derived keys in the graph's own
dependency order. Every other tier becomes a run-local ordinal key, scoped to
`options.runId`, which defaults to `"plan"`. A graph holding a fatal build
refusal has no drafts and therefore no keys: `Graph.drafts` raises that refusal
rather than keying a truncated topology.

The material is handed over verbatim, so a sealed node's key here is the key
the persisted plan records. A non-sealed node's is not: `Plan.compile`
fingerprints every declaration with `StepKey.planIdentity`, which keys a
non-sealed tier in the `plan-declaration` namespace, while this helper keys it
as the run-local `ordinal` the engine dispatches under.

### Plan.make

```ts
const make: (plan: PlanLike) => PlanLike
```

Copies a built plan into a stable presentation order: nodes sorted by id,
edges sorted by endpoint, each node's effects sorted. Node ids, edge endpoints,
keys, envelopes, and every other semantic field are retained verbatim. It is
deliberately not a graph traversal or a key computation helper.

### Plan.render

```ts
const render: (plan: PlanLike) => string
```

Renders a plan as a stable, line-oriented canonical string. Nodes and edges
appear in the deterministic order of `make`, and object payloads render with
sorted keys. Byte-identical output for semantically identical plans is what
makes this the substrate for snapshot assertions.

### Plan.node

```ts
const node: (plan: PlanLike, id: string) => PlanNodeLike | undefined
```

### Plan.edge

```ts
const edge: (value: PlanLike["edges"][number]) => string
```

Renders one edge as `from -> to`.

### Plan.Plan, Plan.Node

Deprecated compatibility aliases for `PlanLike` and `PlanNodeLike`. Use the
shapes exported by `@smthrs/testing/PlanLike`. `make` returns `PlanLike` with
sorted presentation collections; the types do not encode ordering.

### Plan.KeysOptions, Plan.FromGraphOptions, Plan.PlanOfOptions

```ts
interface KeysOptions {
  readonly runId?: string | undefined
}

interface FromGraphOptions {
  readonly key?: ((node: Graph.GraphNode) => string) | undefined
  readonly runId?: string | undefined
  readonly envelope?: Record<string, unknown> | undefined
  readonly digest?: string | undefined
}

interface PlanOfOptions extends FromGraphOptions {
  readonly build?: Graph.BuildOptions | undefined
}
```

## PlanAssertions

Pure assertions for already-built plan graphs. Every assertion is an
`Effect.Effect<void, PlanAssertionError>`.

### PlanAssertions.expectPlan

```ts
const expectPlan: (plan: PlanLike) => PlanAssertions
```

Creates fluent pure assertions for a built plan.

```ts
interface PlanAssertions {
  readonly nodeCount: (expected: number) => Effect.Effect<void, PlanAssertionError>
  readonly contains: (id: string) => Effect.Effect<void, PlanAssertionError>
  readonly edges: (pairs: ReadonlyArray<Edge>, options?: EdgeOptions) => Effect.Effect<void, PlanAssertionError>
  readonly keys: (expected: Readonly<Record<string, string>>) => Effect.Effect<void, PlanAssertionError>
  readonly placement: (id: string, expected: PlacementExpectation) => Effect.Effect<void, PlanAssertionError>
  readonly declaresEffects: (id: string, expected: ReadonlyArray<string>) => Effect.Effect<void, PlanAssertionError>
  readonly envelope: (expected: Record<string, unknown> | undefined) => Effect.Effect<void, PlanAssertionError>
  readonly matchesSnapshot: (expected: string) => Effect.Effect<void, PlanAssertionError>
  readonly node: (id: string) => NodeAssertions
}
```

`edges` asserts the pairs are present and, with `{ exact: true }`, refuses any
edge outside them. `declaresEffects` sorts both sides. `matchesSnapshot`
compares `Plan.render` output and reports a line diff on a mismatch. A missing
node id fails with `missing_node` and lists the ids the plan does have.
Value comparisons run when the returned Effect executes. Envelope and placement
mismatch diagnostics use the shared structural renderer: cycles and depth limits
produce markers, and record accessors are described without invoking getters.
These mismatches remain typed `PlanAssertionError` failures.

### PlanAssertions.NodeAssertions

```ts
interface NodeAssertions {
  readonly key: (expected: string) => Effect.Effect<void, PlanAssertionError>
  readonly placement: (expected: PlacementExpectation) => Effect.Effect<void, PlanAssertionError>
  readonly mode: (expected: string | undefined) => Effect.Effect<void, PlanAssertionError>
  readonly tier: (expected: string) => Effect.Effect<void, PlanAssertionError>
  readonly declaresEffects: (expected: ReadonlyArray<string>) => Effect.Effect<void, PlanAssertionError>
}
```

Assertions scoped to a single built node, returned by `expectPlan(plan).node(id)`.
A conflict strategy and an envelope are not among them: the graph carries
neither on a node.

### PlanAssertions.expectKeyGoldens

```ts
const expectKeyGoldens: (
  actual: Readonly<Record<string, string>>,
  golden: Readonly<Record<string, string>>
) => Effect.Effect<void, PlanAssertionError>
```

Asserts key digests against checked-in goldens: the same logical input must
keep producing byte-identical `key1_` keys. A miss fails with
`key_golden_mismatch` and names the drift as a cache-identity break.

### PlanAssertions.expectPure

```ts
const expectPure: <A, E, R>(computation: Effect.Effect<A, E, R>) => Effect.Effect<A, PlanAssertionError, R>
```

Runs a plan computation that must be pure. Any failure or defect, for example a
poisoned Host or Model capability reached during planning, is surfaced as a
`purity_violation`.

The original value travels in the error's `actual` field, not only in the
message. The poisoned layers raise a `CapabilityContractError` carrying
`capability` and `operation` as typed fields precisely so a consumer can
separate "the plan called `FileSystem.readFile`" from "the plan called
`Jj.status`" from "the input schema failed to decode". Stringifying collapsed
all three into prose a test could only match with a regular expression.

### PlanAssertions.expectPlans

```ts
const expectPlans: (plans: ReadonlyArray<PlanLike>) => PlansAssertions
```

```ts
interface PlansAssertions {
  readonly covers: (ids: ReadonlyArray<string>, options?: CoverageOptions) => Effect.Effect<void, PlanAssertionError>
}
```

Static coverage across a suite of built plans. `CoverageOptions.allowUnreached`
takes node ids or `*` patterns that may be absent.

### PlanAssertions.PlacementExpectation, Edge, EdgeOptions, CoverageOptions

```ts
type PlacementExpectation =
  | string
  | { readonly tag: string; readonly options?: Readonly<Record<string, unknown>> | undefined }
  | undefined

type Edge = readonly [from: string, to: string] | { readonly from: string; readonly to: string }

interface EdgeOptions {
  readonly exact?: boolean | undefined
}

interface CoverageOptions {
  readonly allowUnreached?: ReadonlyArray<string> | undefined
}
```

A bare tag, or a tag whose `options` is omitted, compares only the tag.

## JournalAssertions

Effect-valued assertions over a flow journal.

### JournalAssertions.expectJournal

```ts
const expectJournal: (unordered: ReadonlyArray<JournalEntryLike>) => JournalExpectations
```

Builds fluent assertions over journal entries. Entries are read in
`entry.index` order rather than in the order the caller supplied them, because
ordering is data: an engine that reads its journal from a store with no
`ORDER BY`, or a caller that filtered and re-concatenated, hands over the same
entries in another order, and every assertion must still answer about the same
entry.

```ts
interface JournalExpectations {
  readonly executed: (stepKey: string) => Effect.Effect<void, JournalAssertionError>
  readonly executedInOrder: (keys: ReadonlyArray<string>) => Effect.Effect<void, JournalAssertionError>
  readonly terminal: (status: TerminalStatus) => Effect.Effect<void, JournalAssertionError>
  readonly effect: (key: string) => EffectExpectations
  readonly prefix: (untilIndex: number) => ReadonlyArray<JournalEntryLike>
}
```

`executedInOrder` asserts the keys appear as a **subsequence**: every key in
turn, in this relative order, with any other entries allowed between and around
them. It is not a contiguous or an exhaustive match. `terminal` asserts the
outcome of the entry with the highest `index`. `prefix` returns the raw entries
whose `index` is at most `untilIndex`, in index order.

### JournalAssertions.EffectExpectations

```ts
interface EffectExpectations {
  readonly atLeastOnce: () => Effect.Effect<void, JournalAssertionError>
  readonly journaledAtMostOnce: () => Effect.Effect<void, JournalAssertionError>
  readonly idempotencyKey: (key: string) => Effect.Effect<void, JournalAssertionError>
  readonly exactlyOnce: () => Effect.Effect<void, ExactlyOnceUnsupportedError>
}
```

Assertions about the journaled external **effect** entries under one key. An
ordinary step entry sharing the key never satisfies them: it fails with
`effect_kind_mismatch`. A key that appears nowhere still satisfies
`journaledAtMostOnce`, because nothing was journaled more than once.

`idempotencyKey` distinguishes three situations with three codes:
`effect_not_executed`, `missing_idempotency_key`, and
`idempotency_key_mismatch`.

`exactlyOnce` always fails. An engine can prove at-least-once delivery and
at-most-once journaling, but it cannot prove exactly-once external effect
execution. Keeping the method deliberately failing prevents the test vocabulary
from claiming a guarantee the engine does not provide.

### JournalAssertions.TerminalStatus

```ts
type TerminalStatus = "completed" | "aborted" | "failed" | "suspended"
```

## Divergence

Deterministic journal divergence attribution.

### Divergence.firstDivergence

```ts
const firstDivergence: (
  expected: ReadonlyArray<JournalEntryLike>,
  actual: ReadonlyArray<JournalEntryLike>
) => Option.Option<Divergence>
```

Finds the first differing journal entry, reporting the entry index and the
first differing field. Every field a `JournalEntryLike` carries is compared,
`index` included: two journals whose entries disagree about their own position
are not the same journal.

Values are compared through the shared canonical rendering, which distinguishes
two different `Date`s, a `Map` from a `Set`, `-0` from `0`, `NaN` from
`Infinity`, and ordinary records from special-value markers. Record and array
accessors compare by getter/setter identity without invocation. Cycles use
markers. Sparse array holes differ from `undefined`. Objects at the 128-level
depth limit or whose inspection throws compare by process-local reference
identity. Value rendering does not throw; differing values fail through
`assertNoDivergence` with `FixtureDivergenceError`. Entries must satisfy the
`JournalEntryLike` data shape.

### Divergence.assertNoDivergence

```ts
const assertNoDivergence: (
  expected: ReadonlyArray<JournalEntryLike>,
  actual: ReadonlyArray<JournalEntryLike>
) => Effect.Effect<void, FixtureDivergenceError>
```

Fails with the first journal divergence. CI callers must report this failure
rather than silently re-recording the fixture.

### Divergence.Divergence

```ts
interface Divergence {
  readonly index: number
  readonly field: string
  readonly expected: unknown
  readonly actual: unknown
}
```

## EngineSubject

The black-box engine **subject** seam used by conformance pins. A pin drives an
arbitrary engine implementation through it and asserts on the journal it
produced.

It is deliberately distinct from the production harness port `EngineLike` in
[`@smthrs/harness`](/api/harness), whose members are `sealStep`, `splice`, and
`suspend`. That port is the seam the built-in harness consumes; this one is the
seam a test drives. The two are never interchangeable.

### EngineSubject.EngineSubject

```ts
interface EngineSubject {
  readonly name: string
  readonly run: (options: {
    readonly flow: FlowSpec
    readonly payload: unknown
    readonly executionId?: string
    readonly idempotencyKey?: string
  }) => Effect.Effect<ExecutionResult, EngineSubjectError>
  readonly result: (executionId: string) => Effect.Effect<ExecutionResult, EngineSubjectError>
  readonly interrupt: (executionId: string) => Effect.Effect<void, EngineSubjectError>
  readonly resume: (executionId: string) => Effect.Effect<ExecutionResult, EngineSubjectError>
  readonly journal: (executionId: string) => Effect.Effect<ReadonlyArray<JournalEntryLike>, EngineSubjectError>
}

const EngineSubject: Context.Service<EngineSubject, EngineSubject>
```

The interface and its service tag share the name.

### EngineSubject.make, layer, makeNoop, layerNoop

```ts
const make: (implementation: EngineSubject) => EngineSubject
const layer: (implementation: EngineSubject) => Layer.Layer<EngineSubject>
const makeNoop: (overrides?: Partial<EngineSubject>) => EngineSubject
const layerNoop: (overrides?: Partial<EngineSubject>) => Layer.Layer<EngineSubject>
```

`makeNoop` fails every operation with `EngineUnavailableError`. Overrides
replace individual methods, which is how a partial subject is assembled.

### EngineSubject.FlowSpec and StepSpec

```ts
interface FlowSpec {
  readonly name: string
  readonly steps: ReadonlyArray<StepSpec>
}

type StepSpec =
  | {
    readonly key: string
    readonly sealed: boolean
    readonly kind: "step"
    readonly run: (input: unknown) => Effect.Effect<unknown, unknown>
  }
  | {
    readonly key: string
    readonly sealed: boolean
    readonly kind: "race"
    readonly branches: ReadonlyArray<StepSpec>
  }
```

A conformance flow is described only by its ordered steps, which is the
subject-neutral shape every engine under test is driven with.

`sealed` selects the step's **identity**, not whether a replay may reuse a
recorded result: both kinds replay their recorded outcome. Sealed means content
identity, so every aliased occurrence of the key shares one recorded result.
Unsealed means occurrence identity, so duplicate declared keys run and journal
separately.

A step body's error channel is `unknown` because the pin chooses the failure
value it wants the subject to journal. It is not a laundered engine error.

### EngineSubject.JournalEntryLike and ExecutionResult

```ts
interface JournalEntryLike {
  readonly index: number
  readonly stepKey: string
  readonly kind: string
  readonly outcome: "completed" | "aborted" | "failed" | "suspended"
  readonly value?: unknown
}

interface ExecutionResult {
  readonly executionId: string
  readonly status: "completed" | "aborted" | "failed" | "suspended"
  readonly value?: unknown
}
```

An engine's own richer entry is projected onto `JournalEntryLike` before
comparison.

## Conformance

Runner-independent conformance cases for flow engine implementations.

### Conformance.coreSuite

```ts
const coreSuite: (options?: {
  readonly filter?: ((conformanceCase: ConformanceCase) => boolean) | undefined
}) => ReadonlyArray<ConformanceCase>
```

Builds the mandatory black-box suite every `EngineSubject` must pass:
identity, interruption, replay, and race. This is the whole conformance
vocabulary; there is no second entry point.

The returned array is a frozen copy, and each case record is frozen too.
`ReadonlyArray` is erased at runtime, and losing a mandatory pin is the worst
failure a conformance registry has.

The race and interrupt cases advance time through `TestClock`, so a runner must
register them under a deterministic clock: `Vitest.testEffect(...)` supplies
one through `.effect` and its `scoped` alias, but not through `.live`.

The nine case names are:

| Name                               | What it holds the engine to                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `identity/distinct-executions`     | Two runs of one flow and payload, with no idempotency key, are two independent executions.       |
| `identity/idempotency-key`         | A repeated idempotency key returns the first execution instead of starting a second.             |
| `identity/digest-key-stability`    | Sealed aliases sharing one digest reuse one recorded result; unsealed duplicates run separately. |
| `interrupt/fiber-abort`            | An interrupt reaches the live body fiber, and the journal records the outcome.                   |
| `replay/completed-prefix`          | A resume replays the completed prefix and continues at the first unfinished step.                |
| `replay/suspended-frontier`        | A suspended execution resumes from its frontier.                                                 |
| `race/loser-interrupted`           | The losing branch is interrupted and journaled as `aborted`.                                     |
| `race/recorded-winner-replay`      | A replay reconstructs the journaled winner under inverted timing.                                |
| `race/recorded-loser-interruption` | The loser's recorded interruption replays as recorded.                                           |

### Conformance.ConformanceCase

```ts
interface ConformanceCase {
  readonly name: string
  readonly run: (engine: EngineSubject) => Effect.Effect<void, ConformanceViolation | EngineSubjectError>
}
```

The error channel is the closed union every pin already produces, never
`unknown`: a subject that laundered a foreign cause into `unknown` could not be
matched on by the runner that reports it.

## MemoryEngine

The reference in-memory flow engine, with an externally owned replay store.

### MemoryEngine.makeStore

```ts
const makeStore: () => Effect.Effect<EngineStore>
```

Creates an empty persistent store for memory-engine executions. The store owns
flow specifications, journals, terminal results, and the idempotency index.
Live fibers are intentionally engine-local.

### MemoryEngine.make

```ts
const make: (store: EngineStore) => Effect.Effect<EngineSubject, never, Scope.Scope>
```

Constructs an in-memory engine whose durable state is held by `store`. Closing
the construction scope interrupts only this engine instance's live fibers. A
fresh engine built with the same store replays completed journal entries and
continues at the first unfinished step. Completed, failed and aborted executions
retain their terminal result and journal. A worker that cannot start because
its construction scope closed fails its caller with `EngineUnavailableError`.

### MemoryEngine.layer

```ts
const layer: (store: EngineStore) => Layer.Layer<EngineSubject>
```

### MemoryEngine.EngineStore

```ts
interface EngineStore
```

Persistent state shared by one or more in-memory engine instances. Its contents
are opaque; construct one with `makeStore` and pass it to `make` or `layer`.

## RestartableEngine

A stable engine facade over one persistent `MemoryEngine` store, with controls
for replacing the live instance.

### RestartableEngine.make

```ts
const make: () => Effect.Effect<Restartable, EngineUnavailableError, Scope.Scope>
```

### RestartableEngine.Restartable

```ts
interface Restartable {
  readonly engine: EngineSubject
  readonly restart: Effect.Effect<void, EngineUnavailableError>
  readonly kill: Effect.Effect<void, EngineUnavailableError>
  readonly restartAndResume: (executionId: string) => Effect.Effect<ExecutionResult, EngineSubjectError>
  readonly killAndResume: (executionId: string) => Effect.Effect<ExecutionResult, EngineSubjectError>
}
```

`engine` is a stable facade that always delegates to the current instance.

`restart` closes the outgoing instance's scope, so its fibers are interrupted
and its finalizers run: the orderly shutdown a process performs when it is
asked to stop.

`kill` replaces the live instance **without** closing the one it replaces. It
runs neither interruption nor finalizers, so the abandoned instance keeps
whatever it held, exactly as `SIGKILL` leaves a durable owner holding a run it
will never release. That is the state lease-based reclaim has to recover from.
The abandoned scope is still closed when the harness's own scope closes, so a
killed instance leaks nothing past the test that killed it. The fresh instance
immediately fences the abandoned instance's store writes: its step body can
settle, but its late result cannot change the journal or terminal result, and
its waiting caller fails with `EngineUnavailableError`.

`restartAndResume` and `killAndResume` are those two followed by `resume` on
the fresh instance. Only `killAndResume` produces the hard-kill state.

## FlowEngineLike

The `EngineSubject` adapter over the real engine from
[`@smthrs/engine`](/api/engine). This is the authoritative subject for the core
conformance operations: identity, replay, race, and interruption run against
the production engine rather than a test-only model.

The adapter registers each `FlowSpec` as a real `Flow` whose execute function
runs every step as an `Action`. A sealed step declares its spec key as the
activity idempotency key, so the engine derives content identity from it and
aliased sealed steps replay one recorded result. An unsealed step declares no
idempotency key, so the engine derives occurrence identity. A race step runs
through `Action.raceAll`, the engine's durable race.

Cancellation uses `FlowRuntime.interrupt`, the durable engine's only
cancellation path: the release policy requires `interruptUnsafe` to fail there
with `unsafe_interrupt_unsupported`, so an adapter built on the unsafe path
could not run a single interrupt pin against the engine that ships.

### FlowEngineLike.make

```ts
const make: () => Effect.Effect<
  EngineSubject,
  never,
  Scope.Scope | FlowRuntime.FlowRuntime | (EffectDigest.Digest | SecureRandom.SecureRandom)
>
```

Constructs an `EngineSubject` over the flow engine in the ambient
`FlowRuntime` service. Each `run` registers the spec's flow scoped to the
construction scope, starts the execution, and waits on a completion latch until
it settles as completed, aborted, failed, or suspended.

### FlowEngineLike.layer

```ts
const layer: () => Layer.Layer<
  EngineSubject,
  never,
  FlowRuntime.FlowRuntime | (EffectDigest.Digest | SecureRandom.SecureRandom)
>
```

### FlowEngineLike.layerOver

```ts
const layerOver: <E, R>(
  runtime: Layer.Layer<FlowRuntime.FlowRuntime, E, R>
) => Layer.Layer<EngineSubject | (EffectDigest.Digest | SecureRandom.SecureRandom), E, R>
```

Provides an `EngineSubject` over any `FlowRuntime` implementation, and supplies
Web Crypto so the bundle stays zero configuration. This is the seam the
conformance suite binds to: `make` reads the runtime out of the ambient service
and never names an implementation, so the same case list runs against whichever
runtime is provided here.

The durable runtime is `EngineStore.layer({ owner, journalSource })` from
[`@smthrs/engine-store`](/api/engine-store), which this package does not depend
on and must not. Supplying that layer is the whole connection.

### FlowEngineLike.layerMemory

```ts
const layerMemory: Layer.Layer<EngineSubject | (EffectDigest.Digest | SecureRandom.SecureRandom)>
```

`layerOver(FlowEngine.layerMemory)`: the engine's in-memory implementation,
ready to certify with no configuration.

## HostSuite

The shared Host capability conformance suite, parameterized by a declared
profile.

### HostSuite.hostSuite

```ts
const hostSuite: (bundle: HostBundle, profile: HostProfile) => ReadonlyArray<HostSuiteCase>
```

Produces the suite. Supported capabilities receive behavioral assertions;
unsupported ones must fail the documented operation with their declared typed
code. The eight case names are `FileSystem round-trips`, `Path normalizes`,
`Shell behavior is deterministic`, `Jj has a declared capability result`,
`HttpTransport has a declared capability result`, `Clock is monotonic`,
`Random produces a valid value`, and
`Scoped resources clean up on fiber interruption`.

### HostSuite.HostProfile

```ts
interface HostProfile {
  readonly fileSystemScratchPath?: string | undefined
  readonly fileSystem: CapabilityExpectation
  readonly path: CapabilityExpectation
  readonly shell:
    | { readonly supported: true; readonly interruptCommand: ChildProcess.Command }
    | { readonly supported: false; readonly code: string }
  readonly jj: CapabilityExpectation
  readonly httpTransport: HttpTransportExpectation
  readonly clock: CapabilityExpectation
  readonly random: CapabilityExpectation
}
```

Every closed-list capability must be declared; omission is not an admission
mechanism.

`fileSystemScratchPath` is the directory the round-trip probe creates, writes a
file inside, and removes even when the write or assertion fails. Nonrecursive
directory creation atomically refuses an existing path, including dangling
symlinks and concurrent creations, with `FileSystem/scratchPath`. Removal is
registered only after successful directory creation. When omitted, the suite
builds a randomized absolute path under
`/tmp` from the bundle's own `Path` and `Random`, with a process-local invocation ordinal so repeated seeds remain distinct. A bundle whose platform has
no `/tmp` must declare a path of its own.

A supported `shell` supplies `interruptCommand`, which must stay running until
cancelled. The cleanup case acquires its Host process handle, checks
`isRunning`, interrupts its scoped consumer, and verifies that the handle is
no longer running. An unsupported shell is checked for its refusal code and
does not certify cleanup.

### HostSuite.CapabilityExpectation and HttpTransportExpectation

```ts
type CapabilityExpectation =
  | { readonly supported: true }
  | { readonly supported: false; readonly code: string }

type HttpTransportExpectation =
  | {
    readonly supported: true
    readonly request: HttpClientRequest.HttpClientRequest
    readonly expectedStatus: number
  }
  | { readonly supported: false; readonly code: string }
```

`code` is the stable code expected from the named operation when a capability is
unsupported. HTTP requires an explicit probe target when supported, so the
shared suite never invents a live network call.

### HostSuite.HostBundle

```ts
type HostBundle = Layer.Layer<
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Jj | HttpClient.HttpClient
>
```

The output shape of the public Host bundle contract. `Clock` and `Random` are
`Context.Reference`s, so they cannot appear here; the suite enforces them
behaviorally instead, running those cases over a poisoned base so a bundle that
supplies neither fails loudly rather than silently using the Effect defaults.

### HostSuite.HostSuiteCase and HostSuiteError

```ts
interface HostSuiteCase {
  readonly name: string
  readonly run: Effect.Effect<void, HostSuiteError>
}

type HostSuiteError =
  | CapabilityContractError
  | PlatformError.PlatformError
  | JjFailure
  | HttpClientError.HttpClientError
```

The channel names the typed contract violation plus the incidental host
failures a supported capability's own probe can produce, rather than widening
to `unknown`, so a runner can tell "this host violates the contract" from "the
scratch write failed because the disk is full".

## ModelLike

The provider-neutral model seam a test drives, copied structurally from
[`@smthrs/model`](/api/model) so a fixture stores plain data and a third-party
subject need not adopt that package's classes.

### ModelLike.ModelLike

```ts
interface ModelLike {
  readonly stream: (request: ModelRequestLike) => Stream.Stream<ModelEventLike, ModelLikeError>
}

const ModelLike: Context.Service<ModelLike, ModelLike>
const make: (implementation: ModelLike) => ModelLike
```

### ModelLike.ModelRequestLike

The public request shape of `ModelRequest`: `modelId`, `system` text parts,
`messages` (user, assistant, and tool roles), `tools` with their JSON
`parameters`, a `params` record of generation settings, and an optional
`toolChoice`.

`toolChoice` models only `none`, matching the production request. It is
declared request state rather than a wire field, so two requests that differ
only there are different calls and must not share a replay digest.

`cacheKey` and `cacheBoundary` mirror the production provider cache hints
(`ModelLike.ProviderCacheHint`). They never reach the model, and `cacheKey` is
keyed to the run, so `recordedRequest` drops both: a fixture stores a
`ModelLike.RecordedRequestLike`, and the replay digest ignores them.

### ModelLike.ModelEventLike

The public event shape of `ModelEvent`, copied from its streaming protocol.
Every member of that union is present: `text-start`, `text-delta`, `text-end`,
`thinking-start`, `thinking-delta`, `thinking-end`, `tool-call-start`,
`tool-call-delta`, `tool-call-end`, `tool-result`, `usage`, `retry`, and
`settle`.

`tool-result` and `retry` are included deliberately. A recorder that dropped
them would write a fixture that replays a different stream than the one the
provider produced, and the tool output a harness reported is what feeds the
next request's tool message.

### ModelLike.ModelErrorLike and modelErrorTag

```ts
const modelErrorTag = "flows/model/ModelError"

interface ModelErrorLike {
  readonly _tag?: typeof modelErrorTag | undefined
  readonly code:
    | "invalid_request"
    | "context_overflow"
    | "no_route"
    | "authentication"
    | "rate_limited"
    | "quota_exceeded"
    | "out_of_credit"
    | "content_policy"
    | "provider_internal"
    | "transport"
    | "call_timeout"
    | "invalid_provider_output"
    | "unknown"
  readonly message: string
  readonly path?: string | undefined
  readonly retryAfterMillis?: number | undefined
  readonly resetAtEpochMillis?: number | undefined
  readonly resetSource?: string | undefined
  readonly quotaScope?: "model" | "account" | undefined
  readonly providerCode?: string | undefined
  readonly requestId?: string | undefined
  readonly httpStatus?: number | undefined
}
```

`_tag` is optional because a recorded fixture stores the fields and not the
tag, and required in everything a replay hands back: a consumer that classifies
a provider refusal, such as a quota park, matches on the tag, so a replayed
refusal without one is not the failure that was recorded. `RecordedModel`
stamps it.

`path` is the key path a refusal is about, such as
`$.thinking.budget_tokens`. It is a path only and never a value, because a
request value may carry credentials or user content, which is what makes it
safe for a fixture to store. `RecordingModel` records it so a replayed
`invalid_request` names the field the provider rejected.

`code` is exactly the model package's `ModelErrorCode`. The permission and
grant-store codes belong to the kernel: they are separate typed error classes
the model package never raises, and a fixture that recorded one as a provider
failure would replay a kernel decision as a provider response.

### ModelLike.ModelLikeError

```ts
type ModelLikeError = CapabilityContractError | ModelErrorLike
```

Production model failures retain the exact production shape; a poisoned double
reports a capability contract violation.

`UnscriptedModelError` and `ReplayHarnessMismatchError` are deliberately not
here. Both say the fixture does not describe this run, which is a defect in the
test rather than an outcome the code under test can handle, and neither is a
member of the production `ModelFailure` union. A replay model that failed with
one could not be adapted to the production seam without laundering it into a
provider code, and code that retries or falls back on provider failures would
then retry against a fixture that will never match. The doubles die on both
instead.

## Fixture

The recorded-model fixture format and its replay identity.

### Fixture.Fixture

```ts
interface Fixture {
  readonly calls: ReadonlyArray<RecordedCall>
}

const Fixture: Schema.Struct<{ calls: Schema.Array<...> }>
```

The interface and the schema share one name and are one contract: every level
of both shapes carries the same key set.

The schema is narrower in exactly one place, deliberately: a tool's
`parameters` is `Record<string, unknown>` in the interface, mirroring the model
package's tool shape, and `Record<string, Json>` in the schema, because a
fixture is written to a file and read back.

### Fixture.RecordedCall

```ts
interface RecordedCall {
  readonly request: RecordedRequestLike
  readonly model: string
  readonly events: ReadonlyArray<ModelEventLike>
  readonly failure?: ModelErrorLike | undefined
}
```

`model` is the model the exchange was recorded against, and it is the same
value as `request.modelId`. Decoding enforces that. It is stored separately
because `RecordedModel` matches a call by request **shape**, with `modelId`
erased, so `model` is what answers "was this recorded against the model now
asking?" once the shape has already matched.

### Fixture.decode

```ts
const decode: (input: unknown) => Effect.Effect<Fixture, Schema.SchemaError>
```

Decodes a checked-in fixture. A call whose `model` disagrees with its own
`request.modelId` fails decoding.

### Fixture.canonicalRequestDigest

```ts
const canonicalRequestDigest: (request: ModelRequestLike) => string
```

The canonical JSON encoding of a request, and its replay identity. Object keys
sort recursively, array order is retained, and non-JSON values are rejected
with a typed `FixtureEncodingError` naming the offending path. A value nested
more than 128 levels deep is rejected rather than overflowing the stack.
Enumerable record accessors, array element accessors, sparse array holes, and
failed object inspection are rejected with reason `unsupported-type`.
Accessors are never invoked while encoding tool parameters. Own `__proto__`
keys are preserved as data properties; non-enumerable record fields are ignored.

It returns the canonical **encoding** rather than a fixed-length hash, despite
the name. A fixture cache selects the recorded call to replay by this value, so
a hash collision would replay another conversation's response as this one's;
the package owns no synchronous cryptographic hash, and a non-cryptographic one
buys shorter keys at the cost of a wrong answer nothing would detect.

### Fixture.index

```ts
const index: (fixture: Fixture) => ReadonlyMap<string, RecordedCall>
```

A digest-keyed index over a fixture's recorded calls, computed once and
memoized on the fixture object. Without it, both model doubles re-encoded the
incoming request **and** every call already in the fixture on every invocation:
O(n squared) full re-encodings of complete conversations per run.

The memo is keyed by object identity. `FixtureStore` replaces the whole fixture
on every append rather than mutating it, so a recorded call is visible to the
next lookup; a caller that instead mutates a fixture's `calls` in place would
read a stale index. First writer wins on a duplicate digest.

A recorded request is memoized on its own identity as well, so an append does
not force the next lookup to re-encode the calls already recorded. Only a
frozen request is memoized: a store's own copy of a recorded call is frozen,
and a fixture the caller still owns is re-encoded per fixture.

### Fixture.recordedRequest

```ts
const recordedRequest: (request: ModelRequestLike) => ModelRequestLike
```

Projects a request onto the plain JSON data a fixture stores, deep-copying
every collection including tool `parameters`, `stopSequences`, `itemIds`, and
`addedToolNames`.

The production `ModelRequest` is a `Schema.Class` whose messages, tools, and
params are class instances. A recorder that stored one verbatim would write a
fixture whose shape depends on the class, and `canonicalRequestDigest` rejects
any value that is not a plain object. This copy keeps the recorded request, the
decoded fixture, and the digest input the same value.

## FixtureStore

Loads and records a recorded-model fixture.

```ts
interface FixtureStore {
  readonly load: () => Effect.Effect<Option.Option<Fixture>>
  readonly append: (call: RecordedCall) => Effect.Effect<void>
}

const FixtureStore: Context.Service<FixtureStore, FixtureStore>
const make: (implementation: FixtureStore) => FixtureStore
```

Neither method has an error channel. A fixture that cannot be read or decoded
is a broken test setup, not an outcome the code under test can handle, so it is
a defect; a fixture that does not exist yet is `None`, which is what a first
recording run sees.

### FixtureStore.makeMemory and layerMemory

```ts
const makeMemory: (initial?: Fixture) => Effect.Effect<FixtureStore>
const layerMemory: (initial?: Fixture) => Layer.Layer<FixtureStore>
```

Keeps the fixture in memory. `load` reports `None` until the first call is
recorded, so an empty memory store behaves exactly like a file that does not
exist yet.

### FixtureStore.makeFile and layerFile

```ts
const makeFile: (path: string) => Effect.Effect<
  FixtureStore & {
    readonly flush: () => Effect.Effect<void>
  },
  never,
  FileSystem.FileSystem | Path.Path
>
const layerFile: (path: string) => Layer.Layer<FixtureStore, never, FileSystem.FileSystem | Path.Path>
```

A store over a JSON file and an append-only journal, requiring injected `FileSystem` and `Path` services. `append`
asynchronously persists only the new call. `flush` atomically publishes the
complete JSON and releases the writer lock; `layerFile` flushes on scope close.
The store recovers completed journal lines when reopened. Competing writers
fail with a path-naming defect. See [file persistence and recovery](concepts/fixtures.md#file-persistence-and-recovery).

## HttpRecording

Records, replays or passes through every request an `HttpClient` makes. See
[Record, replay or pass through an HTTP service](./guides/record-http.md).

```ts
const Mode: Schema.Literals<["passthrough", "record", "replay"]>

interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly body?: unknown
}
interface Exchange {
  readonly request: RecordedRequest
  readonly response: {
    readonly status: number
    readonly headers: Readonly<Record<string, string>>
    readonly body: unknown
  }
}
interface Recording {
  readonly label?: string | undefined
  readonly exchanges: ReadonlyArray<Exchange>
}

interface Options {
  readonly mode: Mode
  readonly path: string
  readonly live?: HttpClient.HttpClient | undefined
  readonly secrets?: ReadonlyArray<string | Redacted.Redacted<string>> | undefined
  readonly normalize?: ((request: RecordedRequest) => RecordedRequest) | undefined
  readonly label?: string | undefined
  readonly prune?: ((body: unknown, request: RecordedRequest) => unknown) | undefined
}

const make: (options: Options) => Effect.Effect<HttpClient.HttpClient, never, Scope.Scope>
const layer: (options: Options) => Layer.Layer<HttpClient.HttpClient>
const record: (
  path: string,
  options: Pick<Options, "live" | "secrets" | "normalize" | "label" | "prune">
) => Effect.Effect<HttpClient.HttpClient, never, Scope.Scope>
const replay: (
  recording: Recording,
  options?: Pick<Options, "normalize">
) => HttpClient.HttpClient & { readonly remaining: () => number }
const load: (path: string) => Effect.Effect<Recording>
const encode: (
  path: string,
  recording: Recording,
  secrets: Options["secrets"]
) => Effect.Effect<string, CredentialInRecordingError>
const scrubRequest: (request: RecordedRequest, options?: Pick<Options, "secrets" | "normalize">) => RecordedRequest
const scrubExchange: (exchange: Exchange, options?: Pick<Options, "secrets" | "normalize">) => Exchange
const scan: (text: string) => ReadonlyArray<string>

class UnrecordedRequestError {
  readonly method: string
  readonly url: string
  readonly recorded: number
}
class CredentialInRecordingError {
  readonly path: string
  readonly rules: ReadonlyArray<string>
}
```

`passthrough` returns `live` unchanged. `record` calls `live`, hands the code
under test the live answer, and writes the scrubbed recording when the scope
closes successfully; a failed or interrupted scope writes nothing. `replay`
answers from the recording and never reaches a network: each exchange is
claimed once, in recorded order per method, URL and body, and a request with no
answer left dies with `UnrecordedRequestError`. A missing or malformed
recording file, a missing `live` client, and a streamed or binary request body
are defects. Recording a nonempty response requires UTF-8 text or JSON
(`text/*`, `application/json`, or `application/*+json`); a missing
`Content-Type` is accepted when the bytes are valid UTF-8. Unsupported media
types and invalid UTF-8 cause a defect naming the content type and leave the
previous recording intact. Relative `Location` headers retain their reference
form after credential scrubbing; malformed values become `[REDACTED]`.

`label` is the run's identity, fixed at record time and written into the
recording: a test puts it in the names it creates on the service, so a real run
never meets an earlier run's data and a replay asks for exactly what was
recorded. Read it back with `load` before a replay.

`prune` removes what the code never reads from a response body before it is
recorded. While recording, the code under test receives the pruned body too, so
a field it needs fails the recording run rather than a later replay.

`scan` returns the ids of the journal's token-shaped rules that match `text`
(private key blocks, Smithers tokens, URL credentials, bearer tokens, JWTs and
`sk-`, GitHub, AWS, Slack, Google, GitLab and npm keys). `encode` also refuses a
nonempty named secret that survived, as rule `live-secret`. Named secrets are
scrubbed and checked regardless of length; empty strings are ignored.

## ContainerRecording

Records, replays or passes through every call a Durable Object makes on its
Cloudflare Container. Import it from `@smthrs/testing/ContainerRecording` in a
Worker; it imports no Node module. See
[Record, replay or pass through a Cloudflare Container](./guides/record-a-container.md).

```ts
const Mode: Schema.Literals<["passthrough", "record", "replay"]>
const Operation: Schema.Literals<[
  "running",
  "start",
  "setInactivityTimeout",
  "interceptOutboundHttp",
  "interceptAllOutboundHttp",
  "interceptOutboundHttps",
  "snapshotContainer",
  "destroy",
  "exec"
]>

interface Call {
  readonly operation: Operation
  readonly input: unknown
  readonly output?: unknown
  readonly failure?: string | undefined
}
interface ExecAnswer {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode?: number | undefined
  readonly exitFailure?: string | undefined
}
interface Recording {
  readonly label?: string | undefined
  readonly calls: ReadonlyArray<Call>
}
type Normalize = (operation: Operation, input: unknown) => unknown

const record: <C extends Container<any, any>>(
  live: C,
  options?: { readonly normalize?: Normalize; readonly onCall?: (call: Call, index: number) => Effect.Effect<void> }
) => { readonly container: C; readonly calls: () => ReadonlyArray<Call> }
const replay: <C extends Container<any, any>>(
  recording: Recording,
  options?: { readonly normalize?: Normalize; readonly polled?: ReadonlyArray<Operation> }
) => { readonly container: C; readonly remaining: () => number }
const make: <C extends Container<any, any>>(options: {
  readonly mode: Mode
  readonly live?: C
  readonly recording?: Recording
  readonly normalize?: Normalize
  readonly onCall?: (call: Call, index: number) => Effect.Effect<void>
}) => C
const encode: (
  recording: Recording,
  secrets?: ReadonlyArray<string | Redacted.Redacted<string>>
) => Effect.Effect<string, CredentialInRecordingError>
const decode: (text: string) => Recording

class UnrecordedCallError {
  readonly index: number
  readonly operation: string
  readonly recorded: string
}
class CredentialInRecordingError {
  readonly rules: ReadonlyArray<string>
}
class ReplayedFailure extends Error {
  readonly _tag: string
  readonly operation: Operation
}
```

`Container` is the slice of Alchemy's Durable Object container handle a
container object uses: `running`, `start`, `setInactivityTimeout`, the three
intercepts, `snapshotContainer`, `destroy` and `exec`. `record` calls `live` and
hands each completed call to `onCall` with its index in the order calls began; a
command's call completes when its scope closes. A `destroy` error reaches `live`
and is recorded by its tag. Every member `record` does not record (`monitor`,
`signal`, a method the handle dispatches to the container's own server) is
`live`'s, unchanged. `replay` reaches no container:
each call must match the recording's next call by operation and normalized
input, or it dies with `UnrecordedCallError`; a recorded failure replays as a
`ReplayedFailure` with the live failure's tag. Operations named in `polled`
(calls a timer makes, such as an alarm's `running` polls) may be made more or
fewer times than recorded: skipped calls are passed, an extra one is answered by
a matching recorded call since the last unpolled call, and `remaining()` counts
unpolled calls only. `make` picks one by mode; a
`replay` without a recording or another mode without `live` is a defect.
`encode` scrubs and scans as `HttpRecording.encode` does; `decode` throws on a
malformed recording.

## RecordingModel

Wraps a live model so each call is written to a sink when its stream ends.

```ts
type Sink = (call: RecordedCall) => Effect.Effect<void>

const make: (live: Model.Model, sink: Sink) => Model.Model
const layer: (live: Model.Model, sink: Sink) => Layer.Layer<Model.Model>
```

The sink cannot fail and needs no services, so wrapping a model never widens
its stream's error channel or its requirements.

The recorder flushes only on an exhausted stream and on a provider failure, and
stays silent otherwise. Interruption, a defect, and a consumer that stops
pulling early all leave a truncated exchange: recording one would write a stream
with no `settle` event, which replays as an aborted turn and poisons any cache
built from the same fixture. A `PermissionRequired`, `PermissionDenied`, or
`GrantStoreError` failure is not recorded either, because the kernel refused the
call before the provider saw it; the failure still reaches the caller
unchanged.

The request is projected at stream acquisition rather than after the exchange,
and each event is snapshotted as it is emitted, so a caller that mutates its own
request or its own event objects mid-exchange does not change what was
recorded.

## RecordedModel

The strict replay double.

### RecordedModel.make

```ts
const make: (fixture: Fixture, options?: Options) => Effect.Effect<Replay>
```

Builds a replay model and its controller. Calls are claimed before the returned
stream starts, so stream interruption leaves no pending claim and no background
replay fiber. A request the fixture does not describe dies with
`UnscriptedModelError`, and a fixture recorded against another model dies with
`ReplayHarnessMismatchError`.

### RecordedModel.layer and scripted

```ts
const layer: (fixture: Fixture, options?: Options) => Layer.Layer<ModelLike | RecordedModel>
const scripted: (...calls: ReadonlyArray<RecordedCall>) => Effect.Effect<Replay>
```

`layer` provides both the model seam and the controller. `scripted` creates a
fixture-backed model from handwritten calls.

### RecordedModel.Replay, RecordedModel, and Options

```ts
interface Replay {
  readonly model: ModelLike
  readonly controller: RecordedModel
}

interface RecordedModel {
  readonly unconsumed: () => Effect.Effect<ReadonlyArray<RecordedCall>>
}

interface Options {
  readonly strictRequestOrder?: boolean | undefined
}

const RecordedModel: Context.Service<RecordedModel, RecordedModel>
```

`unconsumed` returns fixture calls that were never selected for replay, which
is how a test asserts that exactly the recorded calls happened.
`strictRequestOrder` requires calls to be consumed in their fixture order.

## CachedModel

A model that replays a fixture hit and records a miss.

```ts
interface Options {
  readonly live?: Model.Model | undefined
  readonly fixture: FixtureStore
  readonly normalize?: ((request: RecordedRequestLike) => RecordedRequestLike) | undefined
}

const make: (options: Options) => Model.Model
const layer: (options: Options) => Layer.Layer<Model.Model>
```

Without `live` the model only replays: a miss dies with `UnscriptedModelError`,
records nothing, and never reaches the network. A CI run uses this mode.

`normalize` rewrites run-varying text, such as a temporary path, a port or a
run id, out of a request before it is keyed and recorded, so the next run's
request finds the same recording. The live model still receives the original
request. Leave `modelId` alone.

The fixture is consulted per call rather than once, so a miss recorded by one
call is a hit for the next identical one inside the same run. Nothing is
claimed: a cache serves the same recording to every request that matches it,
which is what makes a retried step deterministic.

`CachedModel` keys on the whole canonical request, `modelId` included, so
switching models is an ordinary miss that records a second entry. Use it when a
test only needs its calls to be free and deterministic; use `RecordedModel`
when the test must assert that exactly the recorded calls happened.

## CachedEvaluator

`CachedModel` for the `/model/Evaluator` seam, recording into the same fixture.

```ts
interface Options {
  readonly live?: Evaluator.Evaluator | undefined
  readonly fixture: FixtureStore
  readonly modelId?: string | undefined
  readonly normalize?: CachedModel.Options["normalize"]
}

const make: (options: Options) => Evaluator.Evaluator
const layer: (options: Options) => Layer.Layer<Evaluator.Evaluator>
```

An evaluation is stored as one model call: its request is `modelId`
(`Evaluator.defaultModel` by default) with one user message holding the
canonical JSON of the state and the encoded questions, and its answer is one
text part holding the answers, the confidence and the usage. The recorder's
credential guard covers it like any model call. A replay reports `latencyMs: 0`
and no timing. A recorded `EvaluatorError` replays with the same code, status
and reset. Without `live` a miss dies with `UnscriptedModelError`. A state that
is not JSON fails `invalid_question` before anything is recorded.

## TurnGate

Hold a model turn until the test releases it.

```ts
interface TurnGate {
  readonly hold: (key: string) => Effect.Effect<void>
  readonly release: (key: string) => Effect.Effect<void>
  readonly held: () => Effect.Effect<ReadonlyArray<string>>
}

interface ModelOptions {
  readonly gate: TurnGate
  readonly key: (request: ModelRequest) => string | undefined
}

const make: () => Effect.Effect<TurnGate>
const model: (inner: Model.Model, options: ModelOptions) => Model.Model
```

`model` calls `inner` only after the turn's key is released; a turn whose `key`
is `undefined` passes at once. A release is sticky: it answers every turn held
on the key, and every later turn on it passes at once. `held` lists one entry
per waiting turn, in arrival order; an interrupted turn leaves the list.

## ScriptedModel

A model that answers from a script, for the turns a recording cannot make: a
question asked on cue, a build broken once, a turn held until released.

```ts
interface Reply {
  readonly name: string
  readonly text: string
  readonly hold?: string | undefined
  readonly detail?: Readonly<Record<string, unknown>> | undefined
}
type Script = (request: ModelRequest) => Reply | undefined

interface Turn {
  readonly name: string
  readonly when: (request: ModelRequest) => boolean
  readonly reply: (request: ModelRequest) => string
  readonly hold?: ((request: ModelRequest) => string | undefined) | undefined
}

interface Options {
  readonly script: Script
  readonly fallback?: Model.Model | undefined
  readonly gate?: TurnGate.TurnGate | undefined
  readonly log?: TurnLog.TurnLog | undefined
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number } | undefined // 100 and 100
}

interface TranscriptMessage {
  readonly role: "system" | "user" | "assistant" | "tool"
  readonly content: string
}

const make: (options: Options) => Model.Model
const fromTurns: (turns: ReadonlyArray<Turn>) => Script
const transcript: (request: ModelRequest) => ReadonlyArray<TranscriptMessage>
```

A matched request streams `text` as one text part, a `stop` settle, and then a
usage event, which `ModelServer` writes as OpenAI's choice-less usage chunk. An
unmatched request goes to `fallback`; without one it dies with
`UnscriptedModelError`. A reply with `hold` waits on `gate` first; without a
gate it answers at once. A script that throws fails the turn with an
`invalid_request` `ModelError` (`httpStatus` 400) naming the reason. With `log`,
each turn is recorded at dispatch under the reply's `name`, or `unscripted`,
with its `hold` and `detail`. `fromTurns` answers with the first turn whose
`when` holds. `transcript` gives one system message per system part, then each
message's text, tool-call arguments and tool results joined.

## BuiltinScript

A `ScriptedModel` script for the built-in flows a Smithers install runs: a
TODO's coding steps, the pull request review, a conflict resolution, `/review`
and the wiki review. A test steers each TODO with directives written into its
prompt as bracketed tags.

```ts
interface Directives {
  readonly ask?: boolean | undefined // [ASK]
  readonly fail?: boolean | undefined // [FAIL]
  readonly failOnce?: boolean | undefined // [FAILONCE]
  readonly restore?: boolean | undefined // [RESTORE]
  readonly fixed?: boolean | undefined // [FIXED]
  readonly hold?: string | undefined // [HOLD key]
  readonly noResolve?: boolean | undefined // [NORESOLVE]
  readonly file?: string | undefined // [FILE path]
  readonly flowEdit?: boolean | undefined // [FLOWEDIT]
  readonly changelog?: boolean | undefined // [CHANGELOG]
  readonly observeUid?: number | undefined // [OBSERVEUID uid]
  readonly probeReview?: boolean | undefined // [PROBEREVIEW]
}

interface Options {
  readonly greeting?: string | undefined // GREETING
  readonly todoFlow?: string | undefined // the source of .smithers/flows/todo/flow.ts
  readonly holdAt?: ReadonlyArray<string> | undefined
  readonly reviewFindings?: ReadonlyArray<ReviewFinding> | undefined
}

interface BuiltinScript {
  readonly respond: (messages: ReadonlyArray<ChatMessage>) => ScriptedModel.Reply | undefined
  readonly script: ScriptedModel.Script
}

const make: (options?: Options) => BuiltinScript
const tag: (directives: Directives) => string
const directives: (value: unknown) => Directives
const unscripted: ScriptedModel.Script
const isJudgement: (questions: Readonly<Record<string, unknown>> | null | undefined) => boolean
const answer: (name: string, question: { readonly type?: unknown; readonly criteria?: unknown }) => Evaluator.RawAnswer
const evaluator: Evaluator.Evaluator
const teachings: Readonly<Record<string, string>>
const QUESTION: string
const GREETING: string
const SUBJECT: string
const CHANGELOG_STEP: string
const REVIEW_ANSWER: string
```

A turn is recognized by the system teaching in `teachings` and answered with one
`cell` that settles the step's output. `tag` throws for a hold key outside
`[A-Za-z0-9._-]+`, a path outside `[A-Za-z0-9._/-]+` or a uid that is not a
non-negative integer. `directives` reads `fail` and `failOnce` as ended by
`fixed`. A `flowEdit` edit throws without `todoFlow`. `unscripted` settles any
other turn with `{ messages: ["scripted"] }` and keeps the teaching and last
message, 6,000 characters each, as trace detail. `answer` throws for a choice it
cannot route or an unknown type; `evaluator` fails those as `invalid_question`
and reports 120 input tokens per evaluation.

## TurnLog

Count and trace the turns a model double serves.

```ts
type Kind = "chat" | "evaluation" | "refused"

interface Entry {
  readonly n: number
  readonly at: string
  readonly kind: Kind
  readonly step: string
  readonly [field: string]: unknown
}

interface Summary {
  readonly total: number
  readonly chat: number
  readonly evaluation: number
  readonly refused: number
  readonly steps: Readonly<Record<string, number>>
}

interface TurnLog {
  readonly chat: (
    request: ModelRequest,
    step: string,
    detail?: Readonly<Record<string, unknown>>
  ) => Effect.Effect<void>
  readonly record: (kind: Kind, step: string, detail?: Readonly<Record<string, unknown>>) => Effect.Effect<void>
  readonly entries: () => Effect.Effect<ReadonlyArray<Entry>>
  readonly summary: () => Effect.Effect<Summary>
}

const make: (options?: { readonly file?: string; readonly messages?: boolean }) => Effect.Effect<TurnLog>
const model: (
  inner: Model.Model,
  options: { readonly log: TurnLog; readonly step: (request: ModelRequest) => string }
) => Model.Model
const evaluator: (inner: Evaluator.Evaluator, options: { readonly log: TurnLog }) => Evaluator.Evaluator
```

A chat entry carries `model` and `messageCount`, and with `messages: true` the
request's `ScriptedModel.transcript` as `messages`. A detail never overwrites
`n`, `at`, `kind` or `step`. With `file`, each entry is appended as one JSON
line to an owner-only file. `evaluator` records `evaluation` with the answers,
or `refused` with the failure's message, under the question ids joined with
commas (`empty` for none). An entry never holds a header or credential.

## ScoreGate

`@smthrs/testing/ScoreGate` re-exports the pure grading contract from
`@smthrs/scorers/ScoreGate` and adds the fixed-suite runner and `ciGrade`
report helper. Runtime applications import scorers directly; testing stays a
development dependency. `TestingError.ScoreGateError`, `ScoreGateCode`, and
`InvalidScoreSample` re-export the same class and schemas from scorers, so
constructor identity, tags, fields, and existing test imports are preserved.

Fixed-suite score gates and their three-way verdicts.

### ScoreGate.ScoreSample

```ts
type ScoreSample =
  & { readonly case: string; readonly stepKey: string; readonly scorer: string }
  & (
    | { readonly kind: "score"; readonly value: number; readonly reason?: string | undefined }
    | { readonly kind: "inconclusive"; readonly reason: string }
  )
```

One score observation collected for one fixed test case and step key. A `score`
value must be inside `[0, 1]`.

### ScoreGate.Verdict

```ts
type Verdict =
  | { readonly _tag: "Passed"; readonly inconclusive: ReadonlyArray<string> }
  | { readonly _tag: "Failed"; readonly reasons: ReadonlyArray<string>; readonly inconclusive: ReadonlyArray<string> }
  | { readonly _tag: "Inconclusive"; readonly reasons: ReadonlyArray<string> }
```

The two kinds of bad news are separate members because they answer different
questions. `Failed` is a finding: the scores a run produced did not meet a
gate, which is a measurement and a red. `Inconclusive` is an environment fault:
nothing could be measured, which is a broken harness to repair rather than a
result to read. A fault observed beside a decidable gate travels in
`inconclusive` alongside the verdict, never instead of it.

### ScoreGate.expectScores

```ts
const expectScores: (samples: ReadonlyArray<ScoreSample>) => ScoreExpectation
```

```ts
interface ScoreExpectation {
  readonly mean: (threshold: number) => Effect.Effect<Verdict, ScoreGateError>
  readonly min: (threshold: number) => Effect.Effect<Verdict, ScoreGateError>
  readonly perCase: (thresholds: Readonly<Record<string, number>>) => Effect.Effect<Verdict, ScoreGateError>
}
```

`mean` gates the arithmetic mean of every score observation, `min` gates every
observation, and `perCase` gates each named case's lowest observation.

A gate is evaluated over the score observations that exist. An inconclusive
observation is reported beside the verdict, and it withholds a decision only
when it leaves the gate nothing to measure. A gate the surviving scores miss is
`Failed`, not inconclusive. The error channel is reserved for misuse of the
gate itself: a threshold or a score outside `[0, 1]`.

### ScoreGate.validateSamples

```ts
const validateSamples: (samples: ReadonlyArray<ScoreSample>) => Effect.Effect<void, ScoreGateError>
```

Rejects every score observation outside `[0, 1]`, naming each one in the
error's `samples` field. A gate builder validates its own samples, but a caller
that constructs samples itself, a suite runner or a reporter, has no other way
to reach this check, and an unvalidated `NaN` reaches a report as a passing
number.

### ScoreGate.combine

```ts
const combine: (verdicts: ReadonlyArray<Verdict>, environmentFaults?: ReadonlyArray<string>) => Verdict
```

Reduces the verdicts of several gates, plus the environment faults observed
outside them, to one verdict. Precedence is findings first: a gate a run
measurably missed is a red even when another observation went missing, because
the failing measurement happened. A gate that could not be evaluated at all
keeps the run inconclusive, and faults that decided nothing travel alongside a
pass.

### ScoreGate.grade

```ts
const grade: (verdict: Verdict) => { readonly exitCode: 0 | 1 | 5; readonly summary: string }
```

Maps a verdict to the shared CI convention: a finding exits 1, an undecidable
run exits 5, and a clean pass exits 0. A pass that carries unresolved
observations exits 5 as well, because the gates it met were met over fewer
observations than the suite declared.

### ScoreGate.suite

```ts
const suite: <I>(options: SuiteOptions<I>) => Effect.Effect<SuiteReport, ScoreGateError>
```

```ts
interface SuiteOptions<I> {
  readonly cases: ReadonlyArray<SuiteCase<I>>
  readonly run: (suiteCase: SuiteCase<I>) => Effect.Effect<ReadonlyArray<ScoreSample>, unknown>
  readonly gates?: SuiteGates | undefined
}

interface SuiteCase<I> {
  readonly name: string
  readonly input: I
  readonly minScore?: number | undefined
}

interface SuiteGates {
  readonly mean?: number | undefined
  readonly min?: number | undefined
}
```

Runs a fixed suite through its case runner, collects every score sample,
applies the declared gates over the samples that exist, and grades the whole
run. Every returned sample is rebound to the case that was actually run:
trusting the runner's own `case` field let a runner bug attribute samples to
another case, so the per-case gates silently measured the wrong one.

Any failure or defect the runner raises is an environment fault. That case
contributes no samples and its reason to the verdict's `inconclusive` list, and
it no longer cancels the gates the finished cases can still be judged by.

### ScoreGate.SuiteReport, CaseReport, and CaseVerdict

```ts
interface SuiteReport {
  readonly cases: ReadonlyArray<CaseReport>
  readonly samples: ReadonlyArray<ScoreSample>
  readonly verdict: Verdict
}

interface CaseReport {
  readonly name: string
  readonly verdict: CaseVerdict
  readonly samples: ReadonlyArray<ScoreSample>
}

type CaseVerdict =
  | { readonly _tag: "Scored" }
  | { readonly _tag: "Inconclusive"; readonly reasons: ReadonlyArray<string> }
```

A per-case environment fault grades `Inconclusive`, never `Failed`.

### ScoreGate.ciGrade

```ts
const ciGrade: (report: SuiteReport) => { readonly exitCode: 0 | 1 | 5; readonly summary: string }
```

`grade` over a whole report, with a summary that counts the cases and samples
behind a clean pass.

## TestingError

Every typed failure this package raises, and the closed unions of stable codes
they carry. Consumers match on codes, never on message prose. Every literal is
`snake_case`.

### The code unions

```ts
const PlanAssertionCode: Schema.Literals<[...]>
const JournalAssertionCode: Schema.Literals<[...]>
const ScoreGateCode: Schema.Literals<[...]>
const Code: Schema.Union<[...]>
```

Each has a matching decoded type of the same name.

| Union                  | Members                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PlanAssertionCode`    | `missing_node`, `node_count_mismatch`, `key_mismatch`, `placement_mismatch`, `declared_effect_mismatch`, `envelope_mismatch`, `missing_edge`, `unexpected_edge`, `coverage_mismatch`, `snapshot_mismatch`, `key_golden_mismatch`, `purity_violation`, `input_decode_failed`                                                                                                                                                                                                  |
| `JournalAssertionCode` | `step_not_executed`, `execution_order_mismatch`, `terminal_status_mismatch`, `effect_not_executed`, `effect_kind_mismatch`, `effect_journaled_more_than_once`, `missing_idempotency_key`, `idempotency_key_mismatch`                                                                                                                                                                                                                                                         |
| `ScoreGateCode`        | `invalid_threshold`, `invalid_score`, `mean_below_threshold`, `min_below_threshold`, `case_below_threshold`                                                                                                                                                                                                                                                                                                                                                                  |
| `Code`                 | The three above, plus `conformance_violation`, `unscripted_model`, `fixture_not_encodable`, `replay_harness_mismatch`, `fixture_divergence`, `exactly_once_unsupported`, `capability_contract_violation`, `conformance_skipped`, `engine_unavailable`, `execution_conflict`, `capability_operation_failed`, `transaction_commit_failed`, `rewind_failed`, `flow_hash_mismatch`, plus upstream `flow_cycle_detected`, `cancel_request_failed`, `unsafe_interrupt_unsupported` |

### The errors

Every error is a `Schema.TaggedError`, so it carries its `_tag`, a stable
`code`, and typed fields.

| Error                         | `code`                          | Fields                                                                                                            |
| ----------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `PlanAssertionError`          | a `PlanAssertionCode`           | `message`, optional `expected`, optional `actual`                                                                 |
| `JournalAssertionError`       | a `JournalAssertionCode`        | `message`, optional `expected`, optional `actual`                                                                 |
| `ConformanceViolation`        | `conformance_violation`         | `pin`, `message`, optional `expected`, optional `actual`                                                          |
| `UnscriptedModelError`        | `unscripted_model`              | `modelId`, `messageCount`, `toolNames`                                                                            |
| `FixtureEncodingError`        | `fixture_not_encodable`         | `path`, `reason` (`cycle`, `non-plain-object`, `non-finite-number`, `symbol-key`, `unsupported-type`, `too-deep`) |
| `ReplayHarnessMismatchError`  | `replay_harness_mismatch`       | `expected`, `actual`                                                                                              |
| `FixtureDivergenceError`      | `fixture_divergence`            | `index`, `field`, `expected`, `actual`                                                                            |
| `ExactlyOnceUnsupportedError` | `exactly_once_unsupported`      | `message`                                                                                                         |
| `CapabilityContractError`     | `capability_contract_violation` | `capability`, `operation`, optional `expectedCode`, optional `actualCode`                                         |
| `ConformanceSkipped`          | `conformance_skipped`           | `pin`, `capability`, `reason`                                                                                     |
| `ScoreGateError`              | a `ScoreGateCode`               | optional `threshold`, optional `actual`, optional `samples`                                                       |
| `EngineUnavailableError`      | `engine_unavailable`            | `message`                                                                                                         |
| `ExecutionConflictError`      | `execution_conflict`            | `executionId`, `field` (`flow` or `payload`), `expected`, `actual`                                                |
| `CapabilityOperationError`    | `capability_operation_failed`   | `capability`, `operation`, `message`                                                                              |
| `TransactionCommitError`      | `transaction_commit_failed`     | `boundary` (a `TransactionBoundary`)                                                                              |
| `RewindFailureError`          | `rewind_failed`                 | `executionId`, `frame`, `boundary` (a `RewindBoundary`)                                                           |
| `FlowHashMismatchError`       | `flow_hash_mismatch`            | `executionId`, `expectedFlowHash`, `actualFlowHash`, `expectedImportHash`, `actualImportHash`                     |

`UnscriptedModelError`'s fields are a bounded identity, not the request. It is
raised as a defect, so a runner prints it in full; carrying the whole request
put every system block, every turn of the conversation, and every tool schema
into CI logs and into any attached error reporter.

`CapabilityContractError` carries a wrong observed code in `actualCode` rather
than encoded into `operation`, so a consumer never has to parse a message to
learn which code it got.

`ScoreGateError`'s `threshold` and `actual` are optional because not every code
has both: `invalid_threshold` has no observation and `invalid_score` has no
threshold, and a placeholder `0` in either position is a number a consumer
would read as meaningful. `samples` names every rejected observation.

`ExecutionConflictError` reports a `run` that named an existing execution id
with a different flow or payload. An engine that accepted the id and silently
ran the original flow on the original payload would give a caller no signal
that its arguments were ignored, on the seam that defines engine conformance.
`expected` and `actual` are bounded renderings, never the payloads themselves.

Approval timeout and loop-limit failures are not part of this contract. The
reserved `TaskTimeoutError` and `RalphMaxReachedError` classes and their codes
have been removed; concrete subjects and behavioral pins must precede new
capability-specific failures.

### The boundary unions

```ts
const TransactionBoundary: Schema.Literals<["frame", "snapshot", "output", "attempt", "event"]>
const RewindBoundary: Schema.Literals<[
  "load-frame",
  "validate-frame",
  "truncate-journal",
  "restore-snapshot",
  "restore-output",
  "restore-attempt",
  "append-audit",
  "resume"
]>
const InvalidScoreSample: Schema.Struct<{ case; stepKey; scorer; value }>
```

The two boundary unions name where a commit or a rewind was when it failed.
`TransactionCommitError` carries a `TransactionBoundary` and
`RewindFailureError` carries a `RewindBoundary`, so a pin can tell a failed
journal truncation from a failed snapshot restore without parsing a message.
Each union has a matching decoded type.

### TestingError.EngineSubjectError

```ts
type EngineSubjectError =
  | EngineUnavailableError
  | ExecutionConflictError
  | CapabilityContractError
  | ConformanceSkipped
  | CapabilityOperationError
  | TransactionCommitError
  | RewindFailureError
  | FlowHashMismatchError
  | FlowCycleDetected
  | CancelRequestFailed
```

Every typed failure an engine subject, or one of its optional capabilities, may
raise. The conformance seam never carries an `unknown` error channel.

`FlowCycleDetected` and `CancelRequestFailed` come from
[`@smthrs/flow`](/api/flow) and are re-declared here because they are part of
the engine's typed `execute` and interrupt contracts: pins must be able to
match on the cycle `path` rather than on a stringified dump. `Code` includes
their upstream code schemas: `flow_cycle_detected`, `cancel_request_failed`,
and `unsafe_interrupt_unsupported`.

## Faults

Real, machine-global process fault primitives, imported by subpath:

```ts
import { isAlive, killProcess, skewClock, waitForReparent } from "@smthrs/testing/Faults"
```

Every helper that waits takes an optional `timeoutMs` as its last argument. A
`timeoutMs` that is `NaN` or negative throws `RangeError` before the helper
waits or signals.

### Faults.isAlive and isGroupAlive

```ts
const isAlive: (pid: number) => boolean
const isGroupAlive: (pgid: number) => boolean
```

Signal 0 performs the permission and existence check without delivering
anything. `ESRCH` is the only answer that means "gone"; `EPERM` means the
process exists and belongs to somebody else. Both helpers require a positive
integer identifier and return `false` for invalid inputs without signalling.
`isGroupAlive` accepts a positive group id and negates it internally to address
the whole process group, which is the unit host containment works in.

### Faults.parentPid and waitForReparent

```ts
const parentPid: (pid: number) => number | undefined
const waitForReparent: (pid: number, expected: number, timeoutMs?: number) => Promise<number>
```

`parentPid` is the orphan test: a child whose parent was killed is reparented,
and on macOS and Linux the new parent is pid 1 or a subreaper. It answers
`undefined` when the process is gone.

`waitForReparent` waits until the operating system has moved `pid` away from
`expected`, and returns the parent it settled on. Reparenting is not
instantaneous: the kernel moves the child when the old parent is reaped, which
is after the signal is delivered, so a suite that reads `parentPid` once races
that.

### Faults.waitFor

```ts
const waitFor: (predicate: () => boolean, label: string, timeoutMs?: number) => Promise<void>
```

Waits until `predicate` holds, or rejects with `label` in the message. The
timeout runs on the real clock, so a `skewClock` jump during the wait neither
ends it early nor extends it.

### Faults.killProcess

```ts
const killProcess: (
  handle: { readonly pid?: number | undefined },
  signal?: NodeJS.Signals,
  timeoutMs?: number
) => Promise<void>
```

Sends `signal` (default `SIGKILL`) to a real pid and waits for it to leave. A
pid that is already dead is an error rather than a no-op: the test that called
this believed it was injecting a fault, and it was not. A missing pid or one
that is not a positive integer rejects with `killProcess: invalid pid` before
sending any signal.

### Faults.killGroup

```ts
const killGroup: (pgid: number, signal?: NodeJS.Signals) => void
```

Kills a whole process group, used to clean up what a test deliberately
orphaned. Takes a positive integer group id and negates it internally. Invalid
group ids are a no-op. Never throws: this is teardown.

### Faults.skewClock

```ts
const skewClock: (skewMs: number) => SkewedClock

interface SkewedClock {
  readonly now: () => number
  readonly advance: (ms: number) => void
  readonly restore: () => void
}
```

Skews `Date.now`, `Date()`, and a bare `new Date()` by `skewMs` for **this process
only**. `Date()` returns a string for the skewed instant. Explicit constructor
arguments, the Date prototype, and static parsing helpers are preserved. A
child does not inherit the skew, so a child runner takes an explicit skew instead.

Each skew is relative to the real clock, and the latest installation controls
the global clock. Restoring any live handle reinstalls the Date constructor and
`Date.now` captured at module load, even when handles are restored out of order.
`restore` is idempotent; it does not reinstate an earlier skew.

`skewClock` and `advance` throw `RangeError` when given a value that is not a
finite number of milliseconds, so `NaN` or `Infinity` can never reach `Date.now`.

## ProcessTable

Bounded, explicit-column POSIX process probes for real-process tests, imported
by subpath:

```ts
import * as ProcessTable from "@smthrs/testing/ProcessTable"
```

### ProcessTable.query

```ts
type Column = "pid" | "ppid" | "pgid" | "stat" | "comm" | "args" | "rss" | "lstart"

interface Query {
  readonly columns: readonly [Column, ...Array<Column>]
  readonly pid?: number
  readonly timeoutMs?: number
}

const query: (query: Query, spawn?: Spawn) => string
```

Runs `ps -ww -o <columns>` for the whole table, or for `pid` when given, with a
64 MiB output buffer, `LC_ALL=C`, and `PATH=/usr/bin:/bin`. Returns the raw
header-less text. Use `comm` for executable names and `args` when a script
marker must be distinguished from its interpreter. A selected `pid` that does
not exist returns empty text. Every other failure throws: a spawn error, a
timeout, a buffer overflow, or a non-zero exit, so a failed probe cannot pass
for a clean process table. `Spawn` has the signature of `spawnSync` and is the
injection point for tests of the probe itself.

## ModelServer

Serve a model, and optionally a judge, as a local OpenAI-compatible endpoint,
for an install that calls its model from another process. Imported by subpath:

```ts
import * as ModelServer from "@smthrs/testing/ModelServer"

const paths: {
  readonly health: "/health"
  readonly chat: "/v1/chat/completions"
  readonly evaluation: "/v4/ai/evaluation-model"
  readonly held: "/__testing/held"
  readonly release: "/__testing/release/"
  readonly turns: "/__testing/turns"
}

interface Options {
  readonly model: Model.Model
  readonly evaluator?: Evaluator.Evaluator | undefined
  readonly gate?: TurnGate.TurnGate | undefined
  readonly log?: TurnLog.TurnLog | undefined
  readonly hostname?: string | undefined // 127.0.0.1
  readonly port?: number | undefined // 0, any free port
  readonly heartbeatMs?: number | undefined // 15000
}

interface ModelServer {
  readonly url: string
}

const make: (options: Options) => Effect.Effect<ModelServer, never, Scope.Scope>
```

The server listens for the lifetime of the scope. Failing to listen is a defect.

| Route                          | Behavior                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET /health`                  | `200 ok`.                                                                                                                      |
| `POST /v1/chat/completions`    | Decodes exactly `OpenAIChatCompletions.Body`, streamed; streams `model`'s events back as Chat Completions chunks and `[DONE]`. |
| `POST /v4/ai/evaluation-model` | Served only with `evaluator`. Answers `{ answers, usage?, providerMetadata.typesafe.confidence? }`.                            |
| `GET /__testing/held`          | Served only with `gate`. The keys turns wait on, as a JSON array.                                                              |
| `POST /__testing/release/<k>`  | Served only with `gate`. Releases `k` (letters, digits, `.`, `_`, `-`) and answers `204`.                                      |
| `GET /__testing/turns`         | Served only with `log`. The log's `Summary` plus `held`, the keys turns wait on now.                                           |

The chat request is lifted back into the `ModelRequest` that lowers to it, so a
recording made through the server keys exactly as the product's own request.
A field the client never sends, `stream: false`, or `response_format` is a
`400` naming the field. `max_completion_tokens`, which a metering proxy adds,
is read as `max_tokens` when `max_tokens` is absent and dropped otherwise. A `ModelError` before any output answers its
`httpStatus` (500 when absent) with `{ error: { message, type: code, code? } }`;
after output it ends the stream with an `error` chunk. An `EvaluatorError`
answers its `status`, else `400` for `invalid_question`, `504` for `timeout`
and `502` for the rest. A request the backing model or evaluator has no answer
for (it dies, as a replay miss does) answers `501` with `type: "unrecorded"`
and logs a warning naming the model and message count, never the text. If
streaming already started, the status stays `200` and the stream ends with an
`unrecorded` error chunk instead. Any other handler defect ends the response
with a generic `500`, or an error chunk when headers have already been sent.
A silent answer opens the stream after `heartbeatMs` and writes `: held` comments
until output arrives.

## ModelServerCli

The `smthrs-model-server` command: a `ModelServer` over a fixture file, a
script, or both.
Imported by subpath, or run as the package's bin:

```ts
import * as ModelServerCli from "@smthrs/testing/ModelServerCli"

interface Config {
  readonly fixture?: string | undefined
  readonly record?: {
    readonly upstream: string
    readonly model?: string | undefined
    readonly apiKey: Redacted.Redacted<string>
  } | undefined
  readonly hold: ReadonlyArray<RegExp>
  readonly normalize: ReadonlyArray<RegExp>
  readonly hostname?: string | undefined
  readonly port?: number | undefined
  readonly script?: BuiltinScript.Options | undefined
  readonly trace?: { readonly file: string; readonly messages: boolean } | undefined
}

interface Io {
  readonly print: (line: string) => void
  readonly stopped: Promise<void>
}

const parse: (argv: ReadonlyArray<string>, env: Readonly<Record<string, string | undefined>>) => Config
const serve: (config: Config) => Effect.Effect<ModelServer.ModelServer, never, Scope.Scope>
const run: (argv: ReadonlyArray<string>, env: Readonly<Record<string, string | undefined>>, io: Io) => Promise<void>
```

| Flag                    | Meaning                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--fixture <path>`      | The fixture file. Required unless `--script` is given without `--record`. Replay refuses a path that does not exist.          |
| `--record`              | Record misses. Needs `--upstream` and `--key-env`.                                                                            |
| `--upstream <origin>`   | The Chat Completions origin a miss is sent to; its judge is `<origin>/v4/ai/evaluation-model`.                                |
| `--upstream-model <id>` | The model the upstream is asked for. The fixture keeps the requested id.                                                      |
| `--key-env <NAME>`      | The environment variable holding the upstream's bearer key.                                                                   |
| `--hold <regex>`        | Hold a turn whose text matches until its key, capture group 1, is released. Repeatable.                                       |
| `--normalize <regex>`   | Replace every match in a request's strings, except its model id, with `<normalized>` before keying and recording. Repeatable. |
| `--host`, `--port`      | Where to listen: `127.0.0.1` and any free port by default.                                                                    |
| `--script builtin`      | Answer with `BuiltinScript` first. The only script.                                                                           |
| `--script-config <p>`   | `BuiltinScript.Options` as JSON; `todoFlow` names a file, relative to the config, that is read in.                            |
| `--trace <path>`        | Append each turn to this file as one JSON line through `TurnLog`.                                                             |
| `--trace-messages`      | Keep each traced chat turn's messages. Needs `--trace`.                                                                       |

Every run keeps a `TurnLog` and serves `GET /__testing/turns`. With `--script`
the script answers first and its judge answers every evaluation; a turn it does
not script replays from `--fixture`, or without one is settled by
`BuiltinScript.unscripted`. With `--record` as well, nothing is scripted: every
turn and evaluation goes to the upstream and is recorded, and the script only
names each traced turn. Unscripted turns are traced as `replayed` or
`recorded`.

`parse` throws an `Error` naming the first problem and the usage line. Replay
reads the fixture once into memory and never writes it, so parallel runs can
share one file. Recording appends through `FixtureStore.makeFile` and publishes
the fixture when the scope closes. `run` prints `{"url":"..."}` once listening
and closes the scope when `io.stopped` settles; the bin settles it on SIGINT or
SIGTERM and exits `1` with the message on a parse or startup failure.

## Documented limits

| Limit                                                                   | Behavior at the limit                                                   |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `Fixture.canonicalRequestDigest` nesting depth: 128                     | Fails `fixture_not_encodable`, `too-deep`                               |
| `FlowEngineLike` scheduler passes awaiting a published result: 1000     | Fails typed rather than spinning                                        |
| Conformance pin wait: a bounded live-clock schedule, roughly one second | Fails rather than hanging                                               |
| `ScoreGate` sample count                                                | No limit; the minimum is an iterative reduction, not an argument spread |

## RealCliDriver

Import `{ RealCliDriver }` from `@smthrs/testing`. `make(options)` allocates a
scoped temporary project and fresh HOME, XDG, auth, session and temporary roots.
`run(args, input?)` executes literal arguments and optional piped input, returning
`{ code, stdout, stderr }`. `execute({ executable, args?, cwd, env?, input?,
timeoutMs?, maxBytes? })` runs one command without allocating state.

Provide the library catalog's injected filesystem, path and supervised process
services, such as `NodeHost.layer` from `@smthrs/platform-node`. No ambient
environment is inherited; explicitly supply PATH and required configuration.
State roots override caller-supplied values. Both output pipes drain concurrently
with UTF-8 decoding. The default deadline is 30 seconds and the combined byte
budget is 1 MiB. `DriverError.reason` distinguishes invalid bounds, timeout and
output overflow; platform failures retain their typed errors. Scope closure
terminates the owned process group and removes temporary state.

## TerminalRecording

Import `{ TerminalRecording }` from `@smthrs/testing`. `make({ title, columns?,
rows?, frameDurationMs?, maxFrames?, renderer?, env? })` creates a bounded
recording. `capture(label, screen)` accepts public, settled plain-text screens;
never pass credentials, private input or ANSI escapes. `write(newDirectory)`
returns `{ gif, cast, manifest }` after successful conversion through real
FFmpeg 7+ with drawtext, fontconfig and palette filters.

Defaults are 110 columns, 40 rows, 800 ms per frame and 64 frames. Durations
use GIF's 10 ms precision. Frames must fit the row count and terminal display
width, including wide and combining glyphs, checked with the TUI's existing
`string-width` library inside the Effect capture boundary. Fixed geometry,
explicit row positioning and an asciinema v2 timeline make replay independent of
process latency. Replaying identical saved frames in the same renderer/font
environment produces identical GIF bytes. Each new destination retains text
frames, row files, `terminal.filter`, `terminal.cast` and renderer diagnostics;
`manifest.json` is created only after a successful GIF conversion. A failed
conversion preserves evidence without a success manifest; stale destinations
are refused.

The CLI journey in `packages/smithers/test/e2e/cli-journey.test.ts` covers fresh
signed-out state, credential refusal and current repository URLs. The
`terminal recording evidence` case in `apps/tui/e2e/tui.test.ts` uses the
production TUI in a real PTY for session commands and keyboard navigation.
`SMITHERS_TERMINAL_ARTIFACTS` selects the parent evidence directory; each run
creates a fresh child. The CLI additionally accepts `SMITHERS_TERMINAL_PATH`
for a native executable PATH when a host shim depends on its original HOME.

## Feedback-guided fuzzing

`it.effect.fuzz`, `it.fuzz`, and root `FuzzCorpus` provide corpus-backed regression tests and bounded search. See [fuzzing](guides/fuzzing.md) for inputs, budgets, revisions and simulation.
