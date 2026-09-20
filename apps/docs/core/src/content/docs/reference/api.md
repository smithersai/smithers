---
title: "API reference"
description: "Every public export of @smthrs/core: the Flow and Node builders, the Graph planner, effect declarations, placement, annotations, key material, Markdown lowering, Digest, and the TestRuntime evaluator."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/core/docs/api.md"
---

`@smthrs/core` exports ten modules from its root entry point, and each is also
importable from `@smthrs/core/<Module>`:

```ts
import { Effects, Flow, Graph, Node } from "@smthrs/core"
// or
import * as Flow from "@smthrs/core/Flow"
```

`@smthrs/core/internal/*` and `@smthrs/core/*/index` are not public.
`@smthrs/core/package.json` is exported.

Flow and Node construction records declarations without executing planned
steps. JavaScript and TypeScript declarations and all planning callbacks must
be trusted: `Graph.build` executes them in the caller process with ambient
process authority. Purity is a caller obligation; placement, capability, and
effect metadata does not sandbox planning. Use a constrained data-only
ingestion boundary or an externally isolated planner for untrusted declarations.
`TestRuntime` also executes deferred callbacks and requires trusted code.
For the trust boundary and the model behind these signatures, see [Plan time](/concepts/plan-time/),
[Identity and key material](/concepts/identity/), and
[Effect envelopes](/concepts/effects/).

## Flow

Callable, schema-described flow declarations and their immutable combinators.
Calling a flow constructs a `FlowCall` node; it never evaluates the body.

### Flow.Flow

```ts
interface Flow<in out I extends Schema.Top, out O extends Schema.Top, out E = never> extends Pipeable {
  (input: I["Type"]): Node.Node<O["Type"], E>
  readonly input: I
  readonly output: O
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly capabilities: ReadonlyArray<string>
  readonly effects: Effects.Declaration | undefined
  readonly model?: Seat | undefined
  readonly flows?: ReadonlyArray<Reference> | undefined
  readonly prompt?: string | undefined
  readonly annotations: Context.Context<never>
  readonly body: ((input: I["Type"]) => Node.Node<O["Type"], E>) | undefined
  readonly implementation: Implementation | undefined
}
```

The input schema is invariant because it participates in both decoding and
encoding. Output schemas and errors are covariant. `model`, `flows`, and
`prompt` are advisory metadata a host reads; they also form the declaration
recorded beside the flow's implementation identity.

### Flow.Any

```ts
interface Any {
  readonly [TypeId]: object
  readonly input: Schema.Top
  readonly output: Schema.Top
}
```

The marker-only existential type, for a heterogeneous collection of flows.

### Flow.Reference

```ts
type Reference = Any | string
```

A callable flow reference accepted by a dynamic flow. Module-authored flows
pass callable flow values; markdown loaders pass unresolved registry names,
which the harness resolves before execution.

### Flow.Seat

```ts
type Seat = string & {}
```

The name of a model seat a flow may run on. A seat is referred to by name,
never by provider model id, and never by credential.

### Flow.BodyDeclaration

```ts
interface BodyDeclaration {
  readonly model?: Seat | undefined
  readonly flows?: ReadonlyArray<Reference> | undefined
  readonly prompt?: string | undefined
}
```

The seat, collaborator, and prompt declaration a body-backed flow records
beside its body digest, so a decorator that changes the declared seat changes
the flow's key material instead of disappearing from it. A flow declaring none
of the three records no declaration.

### Flow.Implementation

```ts
type Implementation =
  | {
    readonly _tag: "Body"
    readonly algorithm: "sha256-source-ephemeral/v4" | "sha256-source-captures/v4"
    readonly digest: string
    readonly declaration?: BodyDeclaration | undefined
  }
  | {
    readonly _tag: "Dynamic"
    readonly model: Seat | undefined
    readonly flows: ReadonlyArray<Reference>
    readonly prompt: string | undefined
  }
```

Implementation identity. An unannotated body receives process-local
`sha256-source-ephemeral/v4` identity because JavaScript cannot inspect closure
state; [`Node.capture`](#nodecapture) produces the cross-process-stable
`sha256-source-captures/v4` identity.

### Flow.MakeOptions

```ts
interface MakeOptions<Input extends Schema.Top, Output extends Schema.Top, E> {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly input?: Input | undefined
  readonly output?: Output | undefined
  readonly capabilities?: ReadonlyArray<string> | undefined
  readonly effects?: Effects.Declaration | undefined
  readonly model?: Seat | undefined
  readonly flows?: ReadonlyArray<Reference> | undefined
  readonly prompt?: string | undefined
  readonly body?: ((input: Input["Type"]) => Node.Node<Output["Type"], E>) | undefined
}
```

`input` defaults to `Schema.Void` and `output` to `Schema.Unknown`.
`capabilities` is deduplicated and sorted.

### Flow.make

```ts
const make: <
  Input extends Schema.Top = typeof Schema.Void,
  Output extends Schema.Top = typeof Schema.Unknown,
  E = never
>(
  config: MakeOptions<Input, Output, E>
) => Flow<Input, Output, E>
```

Creates a callable flow. With a `body`, the flow's implementation is `Body` and
`model`, `flows`, and `prompt` form its `BodyDeclaration`. With no body but a
`model` or `flows`, the same fields form a `Dynamic` implementation and the
body defaults to one dynamic node. With none of the three, the flow is
declaration-only and throws [`FlowError`](#flowflowerror) with code
`missing_body` when called or built.

### Flow.agent

```ts
const agent: typeof make
```

An alias for `make`. An agent flow is an ordinary flow whose omitted body is
filled by its model or collaborator declaration.

### Flow.isFlow

```ts
const isFlow: (value: unknown) => value is Any
```

Returns `true` when a value is a flow.

### Flow.withCapabilities

```ts
const withCapabilities: {
  (capabilities: ReadonlyArray<string>): <I, O, E>(self: Flow<I, O, E>) => Flow<I, O, E>
  <I, O, E>(self: Flow<I, O, E>, capabilities: ReadonlyArray<string>): Flow<I, O, E>
}
```

Adds capabilities, returning a fresh flow whose capabilities are sorted and
duplicate-free.

### Flow.within

```ts
const within: {
  (placement: Placement.Placement): <I, O, E>(self: Flow<I, O, E>) => Flow<I, O, E>
  <I, O, E>(self: Flow<I, O, E>, placement: Placement.Placement): Flow<I, O, E>
}
```

Places a flow within a host directive, returning a fresh flow. The
placement-shaped special case of [`annotate`](#flowannotate).

### Flow.annotate

```ts
const annotate: {
  <I2, S>(key: Context.Key<I2, S>, value: S): <I, O, E>(self: Flow<I, O, E>) => Flow<I, O, E>
  <I, O, E, I2, S>(self: Flow<I, O, E>, key: Context.Key<I2, S>, value: S): Flow<I, O, E>
}
```

Attaches one typed annotation, returning a fresh flow. Annotations are metadata
a host or a decorator reads; they do not change the flow's implementation
digest.

### Flow.annotateMerge

```ts
const annotateMerge: {
  (annotations: Context.Context<never>): <I, O, E>(self: Flow<I, O, E>) => Flow<I, O, E>
  <I, O, E>(self: Flow<I, O, E>, annotations: Context.Context<never>): Flow<I, O, E>
}
```

Merges an annotation bag onto a fresh flow. Supplied values override existing
values for matching keys. The original flow, its body, and its implementation
identity are unchanged. Decorators use this to retain metadata read by hosts.

### Flow.withFlows

```ts
const withFlows: {
  (flows: ReadonlyArray<Reference>): <I, O, E>(self: Flow<I, O, E>) => Flow<I, O, E>
  <I, O, E>(self: Flow<I, O, E>, flows: ReadonlyArray<Reference>): Flow<I, O, E>
}
```

Replaces the collaborators a flow declares, returning a fresh flow that keeps
its name, schemas, capabilities, effects, and annotations. For a body-backed
flow the body is untouched and the new collaborators replace the `Body`
implementation's declaration. For a body-less dynamic flow, both the default
body and the `Dynamic` implementation are rebuilt.

### Flow.withEffects

```ts
const withEffects: {
  (declaration: Effects.Declaration): <I, O, E>(self: Flow<I, O, E>) => Flow<I, O, E>
  <I, O, E>(self: Flow<I, O, E>, declaration: Effects.Declaration): Flow<I, O, E>
}
```

Replaces a flow's effect declaration, returning a fresh flow.

### Flow.sealed

```ts
const sealed: {
  (): <I, O, E>(self: Flow<I, O, E>) => Flow<I, O, E>
  <I, O, E>(self: Flow<I, O, E>): Flow<I, O, E>
}
```

Returns a fresh flow whose declaration is `hermetic` and `sealed`. A flow with
no declaration gets an empty one with those two values.

### Flow.FlowError

```ts
class FlowError extends Schema.TaggedError<FlowError>()("flows/core/FlowError", {
  code: FlowErrorCode,
  message: Schema.String
}) {}
```

Thrown by a flow call and by `Graph.build`. `FlowErrorCode` is the literal
schema of its one code, `"missing_body"`.

### Flow.Input, Flow.Output, Flow.Error

```ts
type Input<F> = F extends { readonly input: infer I extends Schema.Top } ? I["Type"] : never
type Output<F> = F extends { readonly output: infer O extends Schema.Top } ? O["Type"] : never
type Error<F> = F extends Flow<infer _I, infer _O, infer E> ? E : never
```

Extract a flow's decoded input type, decoded output type, and error type.

### Flow.TypeId

```ts
const TypeId: TypeId = "~flows/core/Flow"
type TypeId = "~flows/core/Flow"
```

The runtime type identifier carried by flow values.

## Node

Pipeable, pure-data nodes describing a flow graph. Constructing and combining
them records an inspectable AST.

### Node.Node

```ts
interface Node<out A, out E = never> extends Pipeable.Pipeable {
  readonly ast: Ast
}
```

`Ast` is the recorded AST type. Its shape is internal; read a plan through
[`Graph`](#graph) rather than through the AST.

### Node.Any, Node.Success, Node.Error

```ts
type Any = Node<unknown, unknown>
type Success<N> = N extends Node<infer A, infer _E> ? A : never
type Error<N> = N extends Node<infer _A, infer E> ? E : never
```

### Node.isNode

```ts
const isNode: (value: unknown) => value is Any
```

### Node.succeed

```ts
const succeed: <A>(value: A) => Node<A>
```

A node that succeeds with a constant value. The value is retained by reference
and read when `Graph.build` runs, so mutating it in between changes the
recorded identity.

### Node.fail

```ts
const fail: <E>(error: E) => Node<never, E>
```

A node that always fails with the given typed error, for re-raising inside a
recovery arm. The error enters key material, so two failures carrying different
data are two declarations. It is retained by reference, like a success value.

### Node.all

```ts
const all: <const R extends Readonly<Record<string, Any>>>(
  nodes: R
) => Node<Simplify<{ readonly [K in keyof R]: Success<R[K]> }>, Error<R[keyof R]>>
```

Combines a record of independent child nodes. A member that is not a node
raises [`NodeBuildError`](#nodenodebuilderror) with code `invalid_all_member`,
naming the member.

### Node.dynamic

```ts
function dynamic<A>(options: DynamicOptions & { readonly output?: { readonly Type: A } }): Node<A>
function dynamic(options: DynamicOptions): Node<unknown>
```

An unelaborated dynamic model node. Passing an `output` schema types the
node's success channel. `Dynamic` is the only node kind that participates in
write-conflict analysis.

### Node.DynamicOptions

```ts
interface DynamicOptions {
  readonly model?: string | undefined
  readonly flows?: ReadonlyArray<string | { readonly "~flows/core/Flow": object }> | undefined
  readonly output?: unknown
  readonly prompt?: string | undefined
  readonly effects?: Effects.Declaration | undefined
}
```

### Node.map

```ts
const map: {
  <A, B>(f: (a: A) => B): <E>(self: Node<A, E>) => Node<B, E>
  <A, E, B>(self: Node<A, E>, f: (a: A) => B): Node<B, E>
}
```

Records a deferred pure function to apply to the eventual success value.
`Graph.build` never calls it; only its identity enters the plan.

### Node.andThen

```ts
const andThen: {
  <A, B, E2>(f: (a: A) => Node<B, E2>): <E>(self: Node<A, E>) => Node<B, E | E2>
  <B, E2>(next: Node<B, E2>): <A, E>(self: Node<A, E>) => Node<B, E | E2>
  <A, E, B, E2>(self: Node<A, E>, f: (a: A) => Node<B, E2>): Node<B, E | E2>
  <A, E, B, E2>(self: Node<A, E>, next: Node<B, E2>): Node<B, E | E2>
}
```

Sequences a pure node-producing builder after a node, or a node directly when
the first success value is not needed. `Graph.build` evaluates the builder once
against a symbolic placeholder, so the downstream topology and its input
references are known before execution.

The placeholder is a name, not a value. Reading a member records an input
reference and is the intended use. Arithmetic and string interpolation coerce
it to the literal text `[planned:<path>]`, a conditional on it always takes the
truthy branch, and neither produces a diagnostic. Its `then` member is reserved
and reads as `undefined`, so the placeholder is never mistaken for a thenable.

### Node.catch

```ts
const catch: {
  <Handled, B, E2>(
    options: CatchOptions<unknown, B, E2, Handled> & { readonly error: Schema.Schema<Handled> }
  ): <A, E>(self: Node<A, E>) => Node<A | B, Exclude<E, Handled> | E2>
  <E, B, E2>(
    options: CatchOptions<E, B, E2> & { readonly error?: undefined }
  ): <A>(self: Node<A, E>) => Node<A | B, E2>
  <A, E, Handled, B, E2>(
    self: Node<A, E>,
    options: CatchOptions<E, B, E2, Handled> & { readonly error: Schema.Schema<Handled> }
  ): Node<A | B, Exclude<E, Handled> | E2>
  <A, E, B, E2>(
    self: Node<A, E>,
    options: CatchOptions<E, B, E2> & { readonly error?: undefined }
  ): Node<A | B, E2>
}
```

Recovers a node's typed failures with a statically planned arm, built once at
plan time against a symbolic error naming the protected node. With no schema
the whole typed error channel is handled; with one, the remainder stays in the
error type. The symbolic error carries the same placeholder rules as
[`andThen`](#nodeandthen).

### Node.CatchOptions

```ts
interface CatchOptions<E, B, E2, Handled = E> {
  readonly error?: Schema.Schema<Handled> | undefined
  readonly onFailure: (error: Handled) => Node<B, E2>
}
```

### Node.capture

```ts
const capture: <C extends Readonly<Record<string, unknown>>, Args extends ReadonlyArray<unknown>, A>(
  captures: C,
  operation: (this: Readonly<C>, ...args: Args) => A
) => (...args: Args) => A
```

Binds a deeply frozen plain copy of declared data as the callback's `this`
receiver. The returned function keeps its ordinary arguments. Use a function
expression when reading captured data; arrow functions retain their lexical
`this`. Caller objects are never changed or retained by the capture wrapper.

```ts
const config = { increment: 2 }
const increment = Node.capture(config, function(value: number) {
  return value + this.increment
})
config.increment = 99
increment(3) // 5
```

Admission uses one sequence:

1. Walk the original graph depth first, refusing cycles and nesting beyond 256
   levels. Side-effect-free intrinsic brand checks reject Map, Set, WeakMap,
   WeakSet, Date, RegExp, ArrayBuffer, SharedArrayBuffer, views, boxed primitives,
   WeakRef and FinalizationRegistry even after prototype replacement. These
   checks never iterate collections, coerce values or read Symbol.toStringTag.
   Each object must have Object.prototype or null as its prototype; arrays must
   have Array.prototype. Other prototypes, including Promise.prototype, are
   refused. Enumerate every own key and read each own descriptor once, including
   shared references and array length. Refuse accessors without evaluating them.
   Records support only enumerable string-keyed data; arrays support dense
   enumerable indices and their standard length. Symbols, functions, bigint,
   undefined, non-finite numbers and extra array keys are refused. Frozen,
   sealed and non-extensible states are ignored, so shallow-frozen records,
   null-prototype records and Immer trees all follow the same path.
2. Only after that pass succeeds, structured-clone the original objects in
   reverse discovery order. This refuses every Proxy with a path-bearing
   TypeError before cloning a parent or earlier object its traps could have
   changed. Uncloneable built-ins, including a prototype-swapped Promise, are
   also refused. A built-in revealed by the host clone, such as Error, is
   refused; the host's clone is discarded. No input getter or collection
   iterator is called. Proxy reflection traps can run during the structural
   pass and can have side effects; admission is not a sandbox for those traps.
   The host clone function is selected before visiting caller data. Like the
   intrinsic brand checks, it relies on trusted host built-ins.
   Hosts without structuredClone refuse object capture, including an empty
   capture record, because they cannot prove the graph Proxy-free.
3. Build plain objects and arrays solely from the descriptors saved in step 1,
   preserving shared references and inserting record keys in canonical order.
   Deep-freeze those copies, encode identity from the copy, and give only the
   copy to the callback. Drop the admission maps and all original references.
   No original is re-read or locked after the clone probe.

The digest folds callback source with canonical copy data. Freezing or sealing
caller data does not change identity. Comparison is structural, so aliasing is
not identity; callbacks must not use reference equality as semantic input.
Capturing an already-captured function nests identities and retains the inner
function's receiver.

Migration from original-object locking: read captured records through `this`
in a function expression. An existing lexical alias still names the original
and is outside the snapshot contract, even if that object was declared.
JavaScript cannot rebind free variables. Callbacks must depend only on the
snapshot's own data, ordinary arguments and explicitly versioned implementation
behavior, not mutable aliases, ambient state or inherited behavior. The
callback itself can retain its lexical aliases; capture neither rewrites its
source nor claims to erase those bindings. The wrapper's dynamic call receiver
is ignored in favor of the frozen capture receiver. Raw functions retain
process-local identity.

### Node.functionIdentity

```ts
const functionIdentity: (operation: unknown) => {
  readonly _tag: "FunctionIdentity"
  readonly algorithm: "sha256-source-ephemeral/v4" | "sha256-source-captures/v4"
  readonly digest: string
}
```

Returns the same identity recorded by node combinators. Captured operations
use their original source and all nested capture sets. Uncaptured operations
receive process-local, per-function entropy. Non-functions throw a `TypeError`.
`@smthrs/plan/Node` shares this implementation and recognizes the same captured
wrappers.

### Node.within

```ts
const within: {
  (placement: Placement.Placement): <A, E>(self: Node<A, E>) => Node<A, E>
  <A, E>(self: Node<A, E>, placement: Placement.Placement): Node<A, E>
}
```

Adds a placement annotation without changing the original node.

### Node.priority

```ts
const priority: {
  (value: number): <A, E>(self: Node<A, E>) => Node<A, E>
  <A, E>(self: Node<A, E>, value: number): Node<A, E>
}
```

Adds a scheduling priority annotation. A scheduler runs ready work with a
higher number first, and children inherit the value lexically. Priority never
enters key material. A value that is not a safe integer raises
`NodeBuildError` with code `invalid_priority`.

### Node.withEffects

```ts
const withEffects: {
  (declaration: Effects.Declaration): <A, E>(self: Node<A, E>) => Node<A, E>
  <A, E>(self: Node<A, E>, declaration: Effects.Declaration): Node<A, E>
}
```

Adds an effect declaration annotation. On a non-work node the declaration
narrows the envelope its children inherit and enters that container's identity;
containers are not counted a second time against their own children.

### Node.NodeBuildError

```ts
class NodeBuildError extends Schema.TaggedError<NodeBuildError>()("flows/core/NodeBuildError", {
  code: NodeBuildErrorCode,
  member: Schema.String,
  message: Schema.String
}) {}
```

`NodeBuildErrorCode` is the literal schema of its four codes:
`invalid_all_member`, `invalid_continuation`, `invalid_priority`, and
`unrepresentable_value`.

### Node.TypeId

```ts
const TypeId: TypeId
type TypeId = "~flows/core/Node"
```

## Graph

Pure graph introspection for flow declarations.

### Graph.build

```ts
const build: (flowOrNode: Flow.Any | Node.Any, input?: unknown, options?: BuildOptions) => Graph
```

Builds a graph by evaluating flow bodies against their inputs and
`Node.andThen` builders and `Node.catch` recovery callbacks against symbolic
predecessor values. It does not execute planned steps, a `Node.map` value
transformation, or a dynamic elaboration. `input` is the flow's input and is
ignored for a node.

All declarations and planning callbacks must be trusted and pure. They run
with ambient process authority; purity is not enforced, and placement,
capability, and effect metadata does not sandbox planning. See
[Planning requires trusted declarations](/concepts/plan-time/#planning-requires-trusted-declarations).

Values supplied to `Node.succeed`, `Node.fail`, and flow calls are retained by
reference and read here.

Throws [`Flow.FlowError`](#flowflowerror) for a body-less flow,
[`Node.NodeBuildError`](#nodenodebuilderror) for a malformed continuation, and
[`GraphBuildError`](#graphgraphbuilderror) with a limit code for an oversized
plan. Declaration problems are recorded in [`diagnostics`](#graphdiagnostics)
instead.

### Graph.BuildOptions

```ts
interface BuildOptions {
  readonly resolveLayers?: ((request: LayerRequest) => Iterable<string>) | undefined
}
```

`resolveLayers` is invoked independently for each node and must be trusted
and pure under the same
[planning obligation](/concepts/plan-time/#planning-requires-trusted-declarations).
It returns resolved host, model, and permission implementation identities as
strings, not Effect layers or runtime handles, and the result becomes the
node's `layers` key material.

### Graph.LayerRequest

```ts
interface LayerRequest {
  readonly nodeId: string
  readonly kind: NodeAst["_tag"] | "LaneMerge"
  readonly model: string | undefined
  readonly capabilities: ReadonlyArray<string>
  readonly effects: Effects.Declaration | undefined
  readonly placement: Placement.Placement | undefined
}
```

### Graph.Graph

```ts
interface Graph
```

An immutable, observation-only flow graph. `build` deep-freezes everything it
constructs, so the getters hand back the graph's own values rather than copies.
Read a graph through [`nodes`](#graphnodes), [`edges`](#graphedges),
[`effects`](#grapheffects), [`placements`](#graphplacements),
[`conflicts`](#graphconflicts), [`diagnostics`](#graphdiagnostics), and
[`keyMaterial`](#graphkeymaterial). The type is opaque and names no storage
field, so a getter is the only way to read a graph and no write to a frozen
node can typecheck.

### Graph.nodes

```ts
const nodes: (graph: Graph) => ReadonlyArray<GraphNode>
```

Returns the graph's nodes in structural preorder.

### Graph.GraphNode

```ts
interface GraphNode {
  readonly id: string
  readonly kind: NodeAst["_tag"] | "LaneMerge"
  readonly dependencies: ReadonlyArray<string>
  readonly declaredEffects: Effects.Declaration | undefined
  readonly effectiveEffects: Effects.Declaration | undefined
  readonly placement: Placement.Placement | undefined
  readonly lane: Graph.Lane | undefined
  readonly priority: number | undefined
  readonly capabilities: ReadonlyArray<string>
  readonly annotations: AnnotationsProjection
  readonly keyMaterial: KeyMaterial.KeyMaterial
}
```

`id` is the node's structural position, such as `root.andThen.all.api`. It is
traversal data and never reaches a step key. `kind` is the AST tag, or
`LaneMerge` for a merge node this package synthesized. `effectiveEffects` is
populated for work nodes only.

### Graph.Lane

```ts
interface Lane {
  readonly id: string
}
```

The worktree lane the write-conflict pass assigns to a laned writer, named
after the node it belongs to. Nothing declares one: this is the only thing that
produces a lane.

### Graph.AnnotationsProjection

```ts
interface AnnotationsProjection {
  readonly placement: Placement.Placement | undefined
  readonly effects: Effects.Declaration | undefined
  readonly lane: Graph.Lane | undefined
  readonly priority: number | undefined
}
```

A serializable projection of the four annotations this package resolves.

### Graph.edges

```ts
const edges: (graph: Graph) => ReadonlyArray<Edge>
```

Returns dependency edges in structural preorder.

### Graph.Edge and Graph.EdgeReason

```ts
interface Edge {
  readonly from: string
  readonly to: string
  readonly reason: EdgeReason
}

type EdgeReason = "value" | "continuation" | "conflict" | "lane-merge"
```

`value` is a structural dependency, `continuation` is a statically planned
`andThen` or `catch` arm, `conflict` is an ordering edge the write-conflict
pass added, and `lane-merge` orders laned writers, their merges, and consumers.
Continuation prerequisites reach the executable entries inside `All`, `Map`,
`FlowCall`, `AndThen`, and `Catch`. Recovery entries retain a conditional
prerequisite on the protected node, represented by a `Pending` key input.

### Graph.effects

```ts
const effects: (graph: Graph) => ReadonlyArray<EffectEntry>
```

Returns declared and inherited effect data for the nodes that carry either.

### Graph.EffectEntry

```ts
interface EffectEntry {
  readonly nodeId: string
  readonly declared: Effects.Declaration | undefined
  readonly effective: Effects.Declaration | undefined
}
```

### Graph.placements

```ts
const placements: (graph: Graph) => ReadonlyArray<PlacementEntry>
```

Returns resolved placement data in structural preorder, skipping nodes that
resolved none.

### Graph.PlacementEntry

```ts
interface PlacementEntry {
  readonly nodeId: string
  readonly placement: Placement.Placement
}
```

### Graph.conflicts

```ts
const conflicts: (graph: Graph) => ReadonlyArray<Conflict>
```

Returns overlapping-write conflict data.

### Graph.Conflict

```ts
interface Conflict {
  readonly nodes: readonly [string, string]
  readonly paths: ReadonlyArray<string>
  readonly strategy: "serialize" | "lane" | "fail"
  readonly mergeNodeId?: string | undefined
}
```

`strategy` is the stricter of the two declarations' `onConflict` values: `fail`
beats `lane`, and `lane` beats `serialize`. `mergeNodeId` is set only for a
`lane` conflict. Merges sharing a writer run in conflict order. Consumer
dependencies exclude serialization edges and prerequisites of either writer.
The completed graph is checked for dependency cycles.

### Graph.diagnostics

```ts
const diagnostics: (graph: Graph) => ReadonlyArray<GraphBuildError>
```

Returns build diagnostics without throwing.

### Graph.GraphBuildError

```ts
class GraphBuildError extends Schema.TaggedError<GraphBuildError>()("@smthrs/plan/GraphBuildError", {
  code: GraphBuildErrorCode,
  node: Schema.String,
  path: Schema.Array(Schema.String),
  message: Schema.String
}) {}
```

This is [`@smthrs/plan`](https://plan.smithers.sh/reference/api/#graphbuilderror)'s `GraphBuildError`, the one build refusal,
which [`@smthrs/flow`](https://flow.smithers.sh/reference/api/)'s graph builder raises too. `Graph` re-exports the class, its
code union, and `isFatalDiagnostic`.

`node` names the site. `path` carries the escaping effect paths, the dropped
capabilities, or an oversized plan value's path, and is empty for every other
code. `message` states the fix.

`Graph.build` raises thirteen of the codes the union carries:

| Code                       | Meaning                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `effect_outside_envelope`  | A step declared a path its envelope does not cover. `path` names them.                                   |
| `effect_mode_widening`     | A `hermetic` envelope with an `expected` step.                                                           |
| `effect_tier_widening`     | A step whose tier is less reversible than its envelope's.                                                |
| `write_conflict`           | Two work nodes overlap under `onConflict: "fail"`. `node` names the first, `Graph.conflicts` names both. |
| `capability_outside_grant` | A called flow declares a capability the grant excludes. Advisory.                                        |
| `duplicate_node`           | Two nodes claim one structural id.                                                                       |
| `dependency_cycle`         | Dependencies cannot be ordered. `node` names a node in the cycle.                                        |
| `missing_key_material`     | A node reached `keyMaterial` without any.                                                                |
| `invalid_node`             | A malformed node AST. Thrown, not recorded.                                                              |
| `graph_too_deep`           | Nesting past `maximumGraphDepth`. Thrown.                                                                |
| `plan_too_large`           | A node, edge, conflict, or effect-path limit crossed. Thrown.                                            |
| `payload_too_deep`         | Nesting past `maximumPayloadDepth` inside one plan value. Thrown.                                        |
| `payload_too_large`        | Members past `maximumPayloadMembers` inside one plan value. Thrown.                                      |

For `plan_too_large`, `node` names the node whose admission crossed the limit.
`path` carries the offending value path for `payload_too_large`.

### Graph.isFatalDiagnostic

```ts
const isFatalDiagnostic: (diagnostic: GraphBuildError) => boolean
```

Reports whether a diagnostic blocks [`keyMaterial`](#graphkeymaterial). Every
code except `capability_outside_grant` is fatal. The five thrown codes are
listed as fatal so a future caller that records one cannot compile it.

### Graph.keyMaterial

```ts
const keyMaterial: (graph: Graph) => Result.Result<ReadonlyArray<KeyMaterial.Entry>, GraphBuildError>
```

Returns node-associated, digest-free key material in topological dependency
order, or fails with the first fatal diagnostic the graph carries, unchanged.
A cyclic graph fails with `dependency_cycle`, including a graph supplied
directly by a caller. The graph-local node id is outside the material
`@smthrs/plan` hashes.

### Graph limits

Every bound is exported so a test can assert on it and a generator can stay
inside it. See [Build limits](/concepts/limits/) for the reasoning.

| Constant                  | Value   | Bounds                                                        |
| ------------------------- | ------- | ------------------------------------------------------------- |
| `maximumGraphDepth`       | 512     | Nested node structure.                                        |
| `maximumPayloadDepth`     | 128     | Nesting inside one reflected plan value.                      |
| `maximumGraphNodes`       | 4,096   | Nodes, synthesized lane merges included.                      |
| `maximumGraphEdges`       | 65,536  | Edges, conflict and lane-merge edges included.                |
| `maximumGraphConflicts`   | 65,536  | Recorded write conflicts.                                     |
| `maximumPayloadMembers`   | 100,000 | Members one plan value expands to, summed across every level. |
| `maximumEffectPaths`      | 1,024   | Read and write paths, summed, in one declaration.             |
| `maximumPlanEffectPaths`  | 65,536  | Effect paths admitted across the plan.                        |
| `maximumEffectPathLength` | 4,096   | UTF-16 code units in one effect path.                         |
| `maximumEffectGlobs`      | 128     | Patterns, entries ending in `*`, in one read or write list.   |

## Effects

Pure effect declarations describing read and write envelopes.

The model lives in [`@smthrs/plan`](https://plan.smithers.sh/reference/api/#effects), the lowest package this
one and the library that executes a flow both depend on. `@smthrs/core/Effects`
re-exports it and adds nothing, so a declaration narrowed here and a declaration
narrowed by `@smthrs/flow` are narrowed by the same rule. The plan reference
documents `Declaration`, `MakeOptions`, `make`, `covers`, `narrow`,
`NarrowResult`, `overlaps`, `sealed`, and the prepared matching API `Graph.build`
uses.

```ts
import { Effects } from "@smthrs/core"

const envelope = Effects.make({
  reads: ["src/**"],
  writes: ["dist/**"],
  mode: "hermetic",
  onConflict: "serialize",
  tier: "sealed"
})
```

## Placement

Serializable placement annotations for flow graph values.

### Placement.Placement

```ts
type Placement = Data.TaggedEnum<{
  readonly "flows/core/Placement/Local": Readonly<Record<never, never>>
  readonly "flows/core/Placement/Client": Readonly<Record<never, never>>
  readonly "flows/core/Placement/Sandbox": Options
  readonly "flows/core/Placement/Remote": Options
}>
```

A serializable directive describing where a flow node should run.

### Placement.Options

```ts
interface Options {
  readonly image?: string | undefined
  readonly profile?: string | undefined
  readonly target?: string | undefined
}
```

Host-selection details. These fields identify a host profile; they never
contain a host implementation, credentials, or any other runtime handle.

### Placement constructors

```ts
const local: () => Placement
const client: () => Placement
const sandbox: (options?: Options) => Placement
const remote: (options?: Options) => Placement
```

`local` is the local process host, `client` is the viewer's browser host,
`sandbox` is an isolated sandbox host, and `remote` is a remote control-plane
host.

## Annotations

Typed immutable annotations attached to flow graph values. The bag is an Effect
`Context`, so a decorator may define its own key.

### Annotations.empty, add, merge, getOption

```ts
const empty: Context.Context<never>
const add: typeof Context.add
const merge: (parent: Context.Context<never>, child: Context.Context<never>) => Context.Context<never>
const getOption: <I, S>(context: Context.Context<never>, key: Context.Key<I, S>) => Option.Option<S>
```

`add` sets or replaces one annotation without changing the original. `merge`
combines a parent and a child bag, with the child's values winning.
`getOption` returns `Option.none()` when the key is absent.

### The three keys

```ts
const Placement: Context.Key<Placement.Placement, Placement.Placement>
const Effects: Context.Key<Effects.Declaration, Effects.Declaration>
const Priority: Context.Service<number>
```

These are the three keys `Graph.build` projects onto each node. `Placement` and
`Effects` are not declared here: they are [`@smthrs/plan`](https://plan.smithers.sh/reference/api/)'s
`Placement.Annotation` and `Effects.Envelope`, the same objects
[`@smthrs/flow`](https://flow.smithers.sh/reference/api/) publishes as `Flow.Placement` and
`Flow.EffectEnvelope`, so a flow annotated for one graph builder is visible to
the other. `Priority` is a signed integer ordering ready work; it is never part
of step identity, so raising it never invalidates a cached step.

A fourth key, `Lane`, and its `LaneOptions` are gone. They were a second
spelling of `Effects.Declaration.onConflict: "lane"` with no caller outside
this package's own tests; the lane a node carries is now only the one the
write-conflict pass assigns it, typed as `Graph.Lane`.

## KeyMaterial

The digest-free input to [`@smthrs/plan`](https://plan.smithers.sh/reference/api/). Types only; this module
exports no runtime values.

### KeyMaterial.KeyMaterial

```ts
interface KeyMaterial {
  readonly version: "flows/key-material/v2"
  readonly kind: "sealed" | "compensable" | "irreversible"
  readonly body: unknown
  readonly inputs: ReadonlyArray<InputRef>
  readonly layers: ReadonlyArray<string>
  readonly capabilities: ReadonlyArray<string>
  readonly effects: Effects.Declaration | undefined
  readonly placement: Placement.Placement | undefined
}
```

`kind` is the effective declaration's tier, defaulting to `sealed`. `body` is
the node's own declaration projected into inert data: a `FlowCall` records the
called flow's schema identity, capabilities, effects, and implementation, never
its name.

### KeyMaterial.InputRef

```ts
type InputRef =
  | { readonly _tag: "Literal"; readonly value: unknown }
  | { readonly _tag: "Ref"; readonly from: string; readonly path: ReadonlyArray<string> }
  | { readonly _tag: "Pending"; readonly from: string }
```

A declared input used to identify a planned node. A `Ref` records a placeholder
member read: the node it came from and the path read from it. Graph-local ids
occur only inside these references, and the key compiler replaces them with
dependency digests before hashing.

### KeyMaterial.Entry

```ts
interface Entry {
  readonly nodeId: string
  readonly material: KeyMaterial
}
```

`nodeId` is traversal data and is never part of the material handed to the key
compiler.

## Markdown

Parses Agent Skills documents and lowers markdown prompts into ordinary flows.
General markdown discovery, and the one specification rule that needs the file
system, belong to [`@smthrs/registry`](https://registry.smithers.sh/reference/api/).

### Markdown.parseSkill

```ts
const parseSkill: (text: string) => Result.Result<SkillDocument, MarkdownError>
```

Parses an Agent Skills document with failsafe-schema YAML semantics and
validates its frontmatter with
[`validateSkillFrontmatter`](#markdownvalidateskillfrontmatter).

### Markdown.SkillDocument and Markdown.SkillFrontmatter

```ts
interface SkillFrontmatter {
  readonly name: string
  readonly description: string
  readonly allowedTools: ReadonlyArray<string>
  readonly extra: Record<string, unknown>
}

interface SkillDocument extends SkillFrontmatter {
  readonly body: string
}
```

`allowedTools` is the specification's space-separated `allowed-tools` scalar
split into tool names. `extra` holds every other field, including the validated
optional `license`, `compatibility`, and `metadata`, as a frozen
null-prototype record.

### Markdown.validateSkillFrontmatter

```ts
const validateSkillFrontmatter: (
  fields: Record<string, unknown>
) => Result.Result<SkillFrontmatter, MarkdownError>
```

Checks already-parsed frontmatter against the specification's intrinsic rules:
`name` is 1 to 64 lowercase ASCII letters, digits, or single hyphens and cannot
start or end with a hyphen; `description` is 1 to 1024 characters counted in
code points; `allowed-tools` and `license` are scalars; `compatibility` is 1 to
500 characters; `metadata` maps string keys to scalar values. A field that is
absent reports a `missing` code, and a field that is present but malformed
reports its own `invalid` code without echoing the offending value.

### Markdown.lowerSkill

```ts
const lowerSkill: (text: string) => Result.Result<Flow.Flow<typeof input, typeof output, never>, MarkdownError>
```

Parses and lowers an Agent Skills document to an ordinary flow whose input is
`{ args: string }` and whose output is `string`. Only `name`, `description`,
and `allowed-tools` are lowered; every other field stays in `parseSkill`'s
`extra` record.

### Markdown.lowerMarkdown

```ts
const lowerMarkdown: (
  frontmatter: MarkdownFrontmatter,
  body: string
) => Flow.Flow<typeof input, typeof output, never>
```

Lowers already-typed markdown metadata and a body to an ordinary flow. The
prompt is the markdown body; harnesses append non-empty runtime `args` when
rendering it. Flow names remain declarations at this layer, and no
implementation is resolved. The `smart` seat is the explicit fallback when the
frontmatter declares no `model`.

### Markdown.MarkdownFrontmatter

```ts
interface MarkdownFrontmatter {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly model?: string | undefined
  readonly flows?: ReadonlyArray<string> | undefined
  readonly capabilities?: ReadonlyArray<string> | undefined
  readonly effects?: {
    readonly reads?: ReadonlyArray<string> | undefined
    readonly writes?: ReadonlyArray<string> | undefined
    readonly mode?: "hermetic" | "expected" | undefined
    readonly onConflict?: "serialize" | "lane" | "fail" | undefined
    readonly tier?: "sealed" | "compensable" | "irreversible" | undefined
  } | undefined
  readonly placement?: "sandbox" | "remote" | "client" | "local" | undefined
}
```

An omitted `effects.reads` or `effects.writes` becomes empty, an omitted `mode`
becomes `hermetic`, and an omitted `onConflict` becomes `serialize`.

### Markdown.MarkdownError

```ts
class MarkdownError extends Schema.TaggedError<MarkdownError>()("flows/core/MarkdownError", {
  code: MarkdownErrorCode,
  message: Schema.String
}) {}
```

`MarkdownErrorCode` is the literal schema of ten codes:
`skill_missing_frontmatter`, `skill_invalid_frontmatter`, `skill_missing_name`,
`skill_invalid_name`, `skill_missing_description`,
`skill_invalid_description`, `skill_invalid_allowed_tools`,
`skill_invalid_compatibility`, `skill_invalid_metadata`, and
`skill_invalid_license`.

## Digest

Synchronous identity construction, for the pure constructors that compute a
content fingerprint without suspending. The digest is the same digest an
Effect-shaped derivation produces: the same canonical bytes, the same hash, and
the same hexadecimal encoding.

### Digest.digest

```ts
const digest: (input: string | Uint8Array) => string
```

The full lowercase SHA-256 digest of UTF-8 string or byte input.

### Digest.canonical

```ts
const canonical: (value: unknown) => string
```

The RFC 8785 canonical JSON serialization of a value. A function, symbol,
`bigint`, cyclic object, non-finite number, or top-level `undefined` has no
canonical JSON representation; for those values this throws the `SchemaError`
from `effect/Schema` raised through `Effect.runSync`, unwrapped.

### Digest.provideSync

```ts
const provideSync: <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>) => Effect.Effect<A, E>
```

Provides the synchronous SHA-256 service to an Effect-shaped derivation, so a
pure constructor can run one without a platform layer.

## TestRuntime

Pure, synchronous execution support for tests of node-building libraries. It
evaluates the deferred callbacks an in-memory node AST stores. It models no
capabilities, persistence, scheduling, retries, cache, concurrency, or
output-schema enforcement, and it is not a substitute for the durable engine.

### TestRuntime.evaluate

```ts
const evaluate: <A, E, E2 = EvaluationError>(
  node: Node.Node<A, E>,
  resolver?: Resolver<E2>
) => Result.Result<A, E | E2 | EvaluationError>
```

Evaluates a node's in-memory declaration with a deterministic leaf resolver. A
declaration nested more than 1,024 levels is refused before unbounded
recursion. With no resolver, reaching a leaf fails with code
`unresolved_node`.

### TestRuntime.evaluateInline

```ts
const evaluateInline: <A, E, E2 = EvaluationError>(
  node: Node.Node<A, E>,
  resolver?: Resolver<E2>
) => Result.Result<A, E | E2 | EvaluationError>
```

Evaluates a node while recursively entering every called flow that carries an
in-memory body. Body-less model or adapter flows still cross the resolver.

### TestRuntime.Resolver

```ts
type Resolver<E = never> = (request: Request) => Result.Result<unknown, E>

type Request = DynamicRequest | FlowCallRequest

interface DynamicRequest {
  readonly _tag: "Dynamic"
  readonly model?: string | undefined
  readonly flows: ReadonlyArray<unknown>
  readonly output?: unknown
  readonly prompt?: string | undefined
  readonly effects?: unknown
}

interface FlowCallRequest {
  readonly _tag: "FlowCall"
  readonly flow: unknown
  readonly target: unknown
  readonly input: unknown
}
```

Supplies deterministic values or typed failures for the execution leaves a pure
evaluator cannot invent. The resolver's error type flows into the result's
error channel.

### TestRuntime.EvaluationError

```ts
class EvaluationError extends Error {
  readonly code: EvaluationErrorCode
  override readonly cause: unknown
}

type EvaluationErrorCode =
  | "callback_threw"
  | "depth_exceeded"
  | "invalid_continuation"
  | "invalid_schema"
  | "missing_flow"
  | "missing_operation"
  | "resolver_threw"
  | "unresolved_node"
```

A malformed or unresolved declaration encountered by the evaluator. `cause`
carries the original thrown value where one exists. For what each code means,
see [Test a declaration without a host](/guides/test-a-declaration/).
