/**
 * The body interpreter: what a flow does when it runs.
 *
 * A `Flow` has no handler to register — its `body` IS the behavior, per
 * `docs/concepts/flows-and-actions.md` — so something has to turn
 * the graph that body describes into execution. That is this
 * module. {@link layer} registers a flow with the runtime, and the
 * handler it installs builds the graph with {@link module:Graph.build} and
 * walks it: each node settles once, in dependency order, and the root's value
 * is the flow's result.
 *
 * What each variant does is the run-time half of what the AST recorded. An
 * `ActionCall` runs its declaration's implementation — looked up by tag in
 * {@link module:Implementations.Implementations} before the walk starts — as
 * the ordinary durable action `toLayer` built, so a node driven here takes
 * the same attempt journal, retry policy, and tier as the same action called
 * from a handler. Its invocation identity additionally folds this node's
 * structural address, keeping concurrent graph sites replay-stable. A `Map`
 * applies its deferred function to the real upstream value. A `Branch`
 * evaluates its digested predicate on the real
 * subject and settles ONLY the arm it took: the other arm is topology the plan
 * shows and the run skipped, and it is reported as such rather than silently
 * absent. An `All` joins its members by name, a `Succeed` yields its value, and
 * an inline `FlowCall` was already flattened by graph building, so it settles
 * with the body spliced beneath it. A `FlowCall` the author wrote as
 * `.child(payload)` is the one node that is NOT flattened: it opens a real child
 * execution under a deterministically derived id
 * ({@link childExecutionId}), which is what gives it its own journal lineage and
 * makes the parent's interruption and the child's suspension travel between
 * them.
 *
 * Planned references are resolved the way the plan names them: a payload
 * placeholder carries the `Ref` `{from, path}` its key material recorded, so
 * `result.files` reads `files` off the settled value of the node that produced
 * it.
 *
 * The walk is demand-driven from the root rather than a sweep over the node
 * list, because dependency order puts BOTH branch arms before the branch that
 * chooses between them, and executing an arm to discover it was not taken is
 * exactly what static topology exists to avoid.
 *
 * @since 0.1.0
 */

import { isRecord } from "@smthrs/canonical/Record"
import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import { DerivedKey, digest } from "@smthrs/keys"
import { isFatalDiagnostic } from "@smthrs/plan/GraphBuildError"
import * as KeyMaterial from "@smthrs/plan/KeyMaterial"
import * as Node from "@smthrs/plan/Node"
import * as Planned from "@smthrs/plan/Planned"
import * as StepKey from "@smthrs/plan/StepKey"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { type Implementation, Implementations, layerImplementations } from "./Action/Implementations.ts"
import { type DispatchOutcome, DispatchReport, DispatchSite } from "./Action/StepIdentity.ts"
import * as DurableDeferred from "./DurableDeferred.ts"
import { attenuateCapabilities } from "./Flow/CapabilityCeiling.ts"
import type { Any as AnyFlow, AnyStructSchema, AnyWithProps, Flow } from "./Flow/Flow.ts"
import * as Outcome from "./Flow/Outcome.ts"
import { Handoff } from "./Flow/Result.ts"
import { suspend } from "./Flow/Runtime.ts"
import { TypeId as FlowTypeId } from "./Flow/TypeId.ts"
import { FlowInstance } from "./FlowRuntime/FlowInstance.ts"
import { FlowRuntime } from "./FlowRuntime/FlowRuntime.ts"
import type * as NodeRecord from "./FlowRuntime/NodeRecord.ts"
import { annotateWaiting } from "./FlowRuntime/WaitingAnnotation.ts"
import * as Graph from "./Graph.ts"
import * as HumanTask from "./HumanTask.ts"
import * as BoundedJson from "./internal/BoundedJson.ts"
import { ExecutionMiddleware } from "./internal/ExecutionMiddleware.ts"
import { InterpreterError } from "./internal/InterpreterError.ts"
import { OutcomeValueTypeId } from "./internal/OutcomeMarker.ts"
import { recordedPlanDrafts } from "./internal/RecordedPlan.ts"
import * as Sleep from "./Sleep.ts"
import * as WaitFor from "./WaitFor.ts"

export { InterpreterError } from "./internal/InterpreterError.ts"

/**
 * The message a durable resume refused a changed plan with, before a stored
 * failure kept its code. @private
 */
const legacyPlanChanged = "The rebuilt plan differs from the recorded plan; start a new execution"

/**
 * The code of the interpreter refusal a run ended with, if it ended with one.
 *
 * A refused run settles failed with its `InterpreterError` as a defect. In
 * the process that drove it the defect is the error itself, and from `poll`,
 * from `result` or from another process it is the same error decoded from
 * the stored result. So `plan_changed` or `payload_changed` here means the
 * run was parked under one build and refused under the next, and an
 * application closes what the run was feeding, such as an answer still
 * streaming.
 *
 * A failure stored before results kept the code carries only the error's
 * name and message. It answers `plan_changed` when its message is the one
 * that refusal was stored with, and nothing for any other refusal.
 *
 * @category errors
 * @since 1.0.0
 */
export const refusalCode = (cause: Cause.Cause<unknown>): Option.Option<InterpreterError["code"]> => {
  for (const reason of cause.reasons) {
    const error = Cause.isDieReason(reason) ? reason.defect : Cause.isFailReason(reason) ? reason.error : undefined
    if (Schema.is(InterpreterError)(error)) return Option.some(error.code)
    if (
      error instanceof Error && error.name === "@smthrs/flow/InterpreterError" && error.message === legacyPlanChanged
    ) {
      return Option.some("plan_changed")
    }
  }
  return Option.none()
}

/**
 * What one interpretation produced: the root's value, every node that settled
 * with the value it settled with, and the nodes the run never reached because
 * a branch went the other way.
 *
 * @category models
 * @since 0.1.0
 */
export interface Interpretation {
  readonly value: unknown
  readonly settled: ReadonlyMap<string, unknown>
  /** Typed failures observed before a catch recovered them. */
  readonly failed: ReadonlyMap<string, unknown>
  readonly skipped: ReadonlyArray<string>
}

/**
 * The services a driven node needs: the runtime that executes an action, and
 * the execution it is part of.
 *
 * @private
 */
type Services = Crypto.Crypto | FlowRuntime | FlowInstance | Implementations

/** Reads one own data property without invoking an accessor or letting a proxy trap escape. */
const ownDataProperty = (value: unknown, key: PropertyKey): unknown => {
  if (Object(value) !== value) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

/**
 * The execution id a `.child()` boundary runs its child under.
 *
 * DECIDED: the id is DERIVED from the parent
 * execution and the child node's structural address, not minted. That is what
 * makes a boundary at-most-once under replay, exactly as
 * `docs/concepts/trampoline-rounds.md` requires of a round handoff: a
 * parent that is re-driven re-derives the same id, so the engine lands on the
 * child execution that already exists instead of starting a second copy of it.
 * The canonical tuple includes the callee and a canonical payload digest, so
 * delimiter splicing and a changed invocation cannot alias an earlier child.
 * SHA-256 uses the same injected derivation services as the repository's
 * other durable identities. The versioned key prefix is dropped because the
 * child-id wire format is the bare digest. `digest` owns the
 * prefix knowledge, so this package never guesses at a stored-key format.
 *
 * @since 0.1.0
 * @category constructors
 */
export const childExecutionId = (
  parentExecutionId: string,
  nodeId: string,
  calleeTag: string,
  payload: unknown
): Effect.Effect<string, never, Crypto.Crypto> =>
  Effect.gen(function*() {
    const payloadDigest = yield* Schema.decodeUnknownEffect(DerivedKey)(payload).pipe(Effect.orDie)
    const tupleDigest = yield* Schema.decodeUnknownEffect(DerivedKey)([
      parentExecutionId,
      nodeId,
      calleeTag,
      payloadDigest
    ]).pipe(Effect.orDie)
    return digest(tupleDigest)
  })

/**
 * The largest encoded page of a recorded plan.
 *
 * A journal entry has a byte bound and a projection clips an oversized one, so
 * a graph is PAGED rather than truncated: whatever does not fit in the plan
 * record follows as appended subgraph pages. The budget is deliberately well
 * under the 16 KiB gateway limit on graph events. The runtime measures the
 * encoded journal envelope; absent that hook, the complete node record is
 * measured in UTF-8. A node too large for one page is a typed preflight refusal.
 *
 * @since 1.0.0
 * @category constants
 */
export const maximumPageBytes = 12_000

/**
 * How many distinct step key digests one node's settlement names.
 *
 * A journal entry has a byte bound and a digest is 64 characters, so the list
 * is capped rather than left to grow with whatever a node dispatched. The
 * cap is far above what any node reaches today — an action node drives one
 * dispatch and keeps one step key however many times it is retried — and a
 * node past it names the dispatches it started with rather than none.
 *
 * @since 1.0.0
 * @category constants
 */
export const maximumDispatchDigests = 16

/** The declared tag a node dispatches, if it dispatches one. @private */
const actionTag = (ast: Node.Ast): string | undefined =>
  ast._tag === "ActionCall" ? ast.action : ast._tag === "FlowCall" ? ast.flow : undefined

/** What one node of a driven graph tells a monitor about itself. @private */
const summarize = (node: Graph.GraphNode): NodeRecord.NodeSummary => {
  const action = actionTag(node.ast)
  return {
    id: node.id,
    kind: node.kind,
    dependsOn: KeyMaterial.dependencies(node.draft.material),
    tier: node.draft.material.kind,
    effects: node.draft.effects,
    ...(action === undefined ? {} : { action }),
    ...(node.declaredAt === undefined ? {} : { declaredAt: node.declaredAt })
  }
}

/**
 * The graph, as the pages a journal can hold.
 *
 * Nothing about one node has to fit one page. A node's summary is seated on a
 * page with no dependencies on it, and then its dependency list and the edges
 * that END on it are spread over as many following pages as they need: a
 * continuation page re-seats the same summary and carries the next disjoint
 * slice of `dependsOn`, so a reader that unions `dependsOn` per node id and
 * concatenates edges reassembles exactly the graph that was built. That is
 * what lets an input-driven fan-in — `Node.all` over a caller-sized list — be
 * recorded at any width instead of refused.
 *
 * A node's summary is seated no later than the first page naming one of its
 * dependencies or one of its incoming edges, so an assembled PREFIX of pages
 * never names an edge whose destination is unknown.
 *
 * The typed refusal is left for the one thing paging cannot divide: a node
 * whose summary with NO dependencies on it still exceeds the budget.
 *
 * @private
 */
const planPages = Effect.fnUntraced(function*(
  flow: string,
  graph: Graph.Graph,
  measure: (record: NodeRecord.NodeRecord) => Effect.Effect<number, never, FlowInstance>
) {
  const graphNodes = Graph.nodes(graph)
  const incoming = incomingEdges(graph)
  const pager: Pager = {
    flow,
    measure,
    identity: yield* planIdentity(flow, graph),
    nodeCount: graphNodes.length,
    reserved: graphNodes.reduce(
      (total, node) => total + KeyMaterial.dependencies(node.draft.material).length,
      graphNodes.length + Graph.edges(graph).length
    ),
    pages: [],
    current: emptyPage()
  }
  for (const node of graphNodes) yield* pageNode(pager, node, incoming.get(node.id) ?? [])
  pager.pages.push(pager.current)
  return pager.pages.map((page, index) => pageRecord(pager, page, index, pager.pages.length))
})

/** One page of the recorded plan: whole node summaries and the edges it carries. @private */
interface Page {
  readonly nodes: ReadonlyArray<NodeRecord.NodeSummary>
  readonly edges: ReadonlyArray<NodeRecord.EdgeSummary>
}

/** The plan being paged: the pages already full, and the page being filled. @private */
interface Pager {
  readonly flow: string
  readonly measure: (record: NodeRecord.NodeRecord) => Effect.Effect<number, never, FlowInstance>
  /** The content identity of the whole recorded plan, carried by its first page. */
  readonly identity: string
  readonly nodeCount: number
  /**
   * Every page is started by a node seat or by an edge, and a node is seated
   * once plus at most once per dependency that starts a continuation page, so
   * the page count is at most nodes + dependencies + edges. Reserving that
   * many digits is what makes replacing the reservation with the final count
   * shrink an encoded envelope or leave it alone, never grow it.
   */
  readonly reserved: number
  readonly pages: Array<Page>
  current: Page
}

/** A page with nothing on it yet. @private */
const emptyPage = (): Page => ({ nodes: [], edges: [] })

/** The content identity of the plan a graph records. @private */
const planIdentity = (flow: string, graph: Graph.Graph): Effect.Effect<string, InterpreterError, Crypto.Crypto> =>
  StepKey.content({
    body: { flow, nodes: recordedPlanDrafts(graph), edges: Graph.edges(graph) },
    inputs: {},
    layers: [],
    capabilities: {}
  }).pipe(Effect.mapError((cause) =>
    new InterpreterError({
      code: "incomplete_graph",
      flow,
      node: "root",
      message: `Cannot identify recorded plan: ${String(cause)}`
    })
  ))

/** Appends `value` to the list `lists` keeps under `key`. @private */
const append = <V>(lists: Map<string, Array<V>>, key: string, value: V): void => {
  const list = lists.get(key)
  if (list === undefined) lists.set(key, [value])
  else list.push(value)
}

/** The edges that end on each node, in graph order. @private */
const incomingEdges = (graph: Graph.Graph): Map<string, Array<NodeRecord.EdgeSummary>> => {
  const incoming = new Map<string, Array<NodeRecord.EdgeSummary>>()
  for (const edge of Graph.edges(graph)) {
    append(incoming, edge.to, { from: edge.from, to: edge.to, reason: edge.reason })
  }
  return incoming
}

/** The record page `index` of `count` is written as. @private */
const pageRecord = (
  pager: Pager,
  page: Page,
  index: number,
  count: number
): NodeRecord.PlanRecorded | NodeRecord.SubgraphAppended => ({
  ...(index === 0
    ? { _tag: "PlanRecorded" as const, nodeCount: pager.nodeCount, digest: pager.identity }
    : { _tag: "SubgraphAppended" as const }),
  sourceId: `plan/0/${index}`,
  flow: pager.flow,
  generation: 0,
  page: index,
  pages: count,
  ...page
})

/** Whether `page`, written as the next page, stays within {@link maximumPageBytes}. @private */
const fits = (pager: Pager, page: Page) =>
  Effect.map(
    pager.measure(pageRecord(pager, page, pager.pages.length, pager.reserved)),
    (bytes) => bytes <= maximumPageBytes
  )

/** Closes the current page and starts an empty one. @private */
const flush = (pager: Pager): void => {
  pager.pages.push(pager.current)
  pager.current = emptyPage()
}

/**
 * How many of the remaining items the page still holds.
 *
 * A page only grows as items are added to it, so the boundary is found by
 * bisection: a thousand-way fan-in costs a logarithmic number of measurements
 * per page rather than one per item. Taking none is the page as it stands,
 * which was measured before anything was offered to it.
 *
 * @private
 */
const admits = <T>(pager: Pager, rest: ReadonlyArray<T>, grow: (take: number) => Page) =>
  Effect.gen(function*() {
    if (yield* fits(pager, grow(rest.length))) return rest.length
    let low = 0
    let high = rest.length - 1
    while (low < high) {
      const mid = low + Math.ceil((high - low) / 2)
      if (yield* fits(pager, grow(mid))) low = mid
      else high = mid - 1
    }
    return low
  })

/**
 * Puts every item somewhere, starting a page whenever the current one is
 * full. `resume` prepares a freshly started page so what follows still says
 * which node it belongs to, and a page that was just started and admits
 * nothing is the end of what paging can do.
 *
 * @private
 */
const spread = <T>(
  pager: Pager,
  items: ReadonlyArray<T>,
  onto: (page: Page, taken: ReadonlyArray<T>) => Page,
  resume: (page: Page) => Page,
  refusal: () => InterpreterError
): Effect.Effect<void, InterpreterError, FlowInstance> =>
  Effect.gen(function*() {
    let rest = items
    let started = false
    while (rest.length > 0) {
      const take = yield* admits(pager, rest, (count) => onto(pager.current, rest.slice(0, count)))
      if (take > 0) {
        pager.current = onto(pager.current, rest.slice(0, take))
        rest = rest.slice(take)
        started = false
        continue
      }
      if (started) return yield* refusal()
      flush(pager)
      pager.current = resume(pager.current)
      started = true
    }
  })

/** Adds dependencies to the summary the page seated last. @private */
const withDependencies = (page: Page, taken: ReadonlyArray<string>): Page => {
  const seated = page.nodes[page.nodes.length - 1]!
  return {
    nodes: [...page.nodes.slice(0, -1), { ...seated, dependsOn: [...seated.dependsOn, ...taken] }],
    edges: page.edges
  }
}

/** Adds edges to the page. @private */
const withEdges = (page: Page, taken: ReadonlyArray<NodeRecord.EdgeSummary>): Page => ({
  nodes: page.nodes,
  edges: [...page.edges, ...taken]
})

/**
 * Pages one node: its summary alone first, because what a page must hold
 * whole is the node itself and that is the only thing left to refuse. Then
 * its dependencies, onto the summary the page just seated, and then the
 * edges that end on it. Either may run past this page onto the next.
 *
 * @private
 */
const pageNode = Effect.fnUntraced(function*(
  pager: Pager,
  node: Graph.GraphNode,
  arriving: ReadonlyArray<NodeRecord.EdgeSummary>
) {
  const summary = summarize(node)
  const bare: NodeRecord.NodeSummary = { ...summary, dependsOn: [] }
  const seat = (page: Page): Page => ({ nodes: [...page.nodes, bare], edges: page.edges })
  const tooLarge = () =>
    new InterpreterError({
      code: "node_record_too_large",
      flow: pager.flow,
      node: node.id,
      message: `Node "${node.id}" and its encoded envelope exceed ${maximumPageBytes} bytes with no dependencies on it`
    })
  if (!(yield* fits(pager, seat(pager.current)))) {
    if (pager.current.nodes.length > 0 || pager.current.edges.length > 0) flush(pager)
    if (!(yield* fits(pager, seat(pager.current)))) return yield* tooLarge()
  }
  pager.current = seat(pager.current)
  yield* spread(pager, summary.dependsOn, withDependencies, seat, tooLarge)
  yield* spread(pager, arriving, withEdges, (page) => page, tooLarge)
})

/**
 * Interprets a flow body, or a bare node, against real values.
 *
 * The graph is built first and in full — planning is a pure function of the
 * declarations and the payload, so the whole shape of the round is known before
 * the first action runs — and then driven. The low-level default permits
 * process-local callbacks; pass `callbackIdentity: "stable"` for reproducible
 * callback identity. {@link layerWithImplementations} selects that policy by
 * default.
 *
 * @since 0.1.0
 * @category constructors
 */
export const interpret = (
  flowOrNode: Parameters<typeof Graph.build>[0],
  payload?: unknown,
  options: Graph.BuildOptions = {}
): Effect.Effect<Interpretation, unknown, Services> => interpretWithPolicy(flowOrNode, payload, options)

/**
 * Every interpreter requires versions before permitting content-key reuse.
 *
 * The graph is built and checked in full before the first node runs, and
 * then driven from the root.
 *
 * @private
 */
const interpretWithPolicy = (
  flowOrNode: Parameters<typeof Graph.build>[0],
  payload: unknown,
  options: Graph.BuildOptions,
  registerReachable?: (flow: AnyWithProps) => Effect.Effect<void>
): Effect.Effect<Interpretation, unknown, Services> =>
  Effect.gen(function*() {
    const table = yield* Implementations
    const name = "_tag" in flowOrNode ? flowOrNode._tag : "node"
    const graph = yield* Effect.try({
      try: () => Graph.build(flowOrNode, payload, options),
      catch: (cause) => buildRefusal(name, cause)
    })
    const fatal = fatalRefusal(name, graph)
    if (fatal !== undefined) return yield* fatal
    const runtime = yield* FlowRuntime
    yield* recordPlan(runtime, name, graph)
    // Everything the walk needs that the built graph can be asked for before it
    // runs, is asked for here — so no such refusal can surface halfway through
    // a body with the actions ahead of it already committed.
    //
    // A reference out of the graph is the first: a round may be PLANNED against
    // a node an earlier generation settled — `Plan.append` exists for exactly
    // that — but one interpretation settles one graph, so there is nothing to
    // read it from. A missing implementation is the second, and it is a wiring
    // error rather than a run-time contingency: every action the graph names
    // is resolved up front, including the ones only an untaken branch arm would
    // have reached, because the plan is the declared ceiling of what may run.
    // Deferred operations must likewise survive beside every AST, even when
    // the walk would skip their branch or catch arm.
    const unready = unreadyNode(name, graph)
    if (unready !== undefined) return yield* unready
    const declarations = yield* resolveDeclarations(name, table, graph, registerReachable)
    const cycle = cycleRefusal(name, graph)
    if (cycle !== undefined) return yield* cycle
    const walk = makeWalk(name, runtime, graph, declarations, yield* Scope.make())
    // Closing the node scope on every exit — value, failure, or the
    // interpretation's own interruption — is the fail-fast half of the
    // ownership model: whatever is still running when the walk ends is
    // interrupted before the interpretation reports, so no execution
    // outlives it.
    const value = yield* settleNode(walk, options.root ?? "root").pipe(
      Effect.onExit((exit) => Scope.close(walk.scope, exit)),
      Effect.onExit((exit) => recordSkipped(walk, exit))
    )
    const skipped = walk.nodes.filter((node) => !walk.settled.has(node.id) && !walk.failed.has(node.id))
    return { value, settled: walk.settled, failed: walk.failed, skipped: skipped.map((node) => node.id) }
  })

/** An interpreter refusal of `flow` at `node`. @private */
const refusal = (flow: string, code: InterpreterError["code"], node: string, message: string): InterpreterError =>
  new InterpreterError({ code, flow, node, message })

/**
 * The refusal a graph build's throw becomes.
 *
 * Graph.build normalizes its own refusals to GraphBuildError, but the flow
 * body runs inside this boundary and a body throws whatever it throws.
 * Reading `node` and `message` off the value without checking built an
 * InterpreterError its own schema rejects, and the constructor's "Schema
 * validation failed" then replaced the reason the author needed. All three
 * fields are read through own data descriptors and narrowed here so a plain
 * Error from a body arrives as a typed failure that still says why. A body
 * that threw produced no topology, so it reports `incomplete_graph`.
 *
 * @private
 */
const buildRefusal = (name: string, cause: unknown): InterpreterError => {
  const thrownNode = ownDataProperty(cause, "node")
  const thrownCode = ownDataProperty(cause, "code")
  const thrownMessage = ownDataProperty(cause, "message")
  const node = typeof thrownNode === "string" ? thrownNode : ""
  const reported = typeof thrownMessage === "string" ? thrownMessage : ""
  return refusal(
    name,
    thrownCode === "duplicate_node" ? "duplicate_node_id" : "incomplete_graph",
    node,
    reported === ""
      ? `building the graph of flow ${name} threw ${typeof cause === "string" ? cause : BoundedJson.render(cause, 512)}`
      : reported
  )
}

/**
 * The refusal of a graph with a fatal diagnostic. Advisory diagnostics
 * describe a graph that is exactly what will run, so they are reported by
 * `Graph.diagnostics` and do not stop a run. A fatal one means the topology
 * is not what the author wrote.
 *
 * @private
 */
const fatalRefusal = (name: string, graph: Graph.Graph): InterpreterError | undefined => {
  const fatal = graph.diagnostics.find(isFatalDiagnostic)
  if (fatal === undefined) return undefined
  return refusal(
    name,
    "incomplete_graph",
    fatal.node,
    `Graph of "${name}" is missing topology and cannot be driven: ${fatal.message}`
  )
}

/**
 * Writes the whole graph, before the first node runs. Planning is pure, so
 * this is the complete declared ceiling of the round rather than a prefix of
 * what happened to run, and a monitor can draw the round it is watching from
 * the first record it receives. Every page is validated before the first is
 * written or any action dispatched.
 *
 * @private
 */
const recordPlan = (runtime: FlowRuntime["Service"], name: string, graph: Graph.Graph) => {
  const recordNode = runtime.recordNode
  if (recordNode === undefined) return Effect.void
  const measure = runtime.nodeRecordBytes ??
    ((record: NodeRecord.NodeRecord) => Effect.succeed(new TextEncoder().encode(JSON.stringify(record)).byteLength))
  return Effect.flatMap(
    planPages(name, graph, measure),
    (pages) => Effect.forEach(pages, (page) => recordNode(page), { discard: true })
  )
}

/** What a deferred node lost beside its AST, if it lost anything. @private */
const lostOperation = (node: Graph.GraphNode): string | undefined => {
  const ast = node.ast
  if (ast._tag === "Map" && Node.mapper(ast) === undefined) return `Map at "${node.id}" lost its mapper.`
  if (ast._tag === "Branch" && Node.predicate(ast) === undefined) return `Branch at "${node.id}" lost its predicate.`
  if (ast._tag === "Catch" && ast.filter !== undefined && Node.catchFilter(ast) === undefined) {
    return `Catch at "${node.id}" lost its schema filter.`
  }
  return undefined
}

/** The refusal of the first node that lost an operation or reads outside the graph. @private */
const unreadyNode = (name: string, graph: Graph.Graph): InterpreterError | undefined => {
  const graphNodes = Graph.nodes(graph)
  const ids = new Set(graphNodes.map((node) => node.id))
  for (const node of graphNodes) {
    const lost = lostOperation(node)
    if (lost !== undefined) return refusal(name, "missing_operation", node.id, lost)
    const missing = KeyMaterial.dependencies(node.draft.material).find((dependency) => !ids.has(dependency))
    if (missing !== undefined) {
      return refusal(
        name,
        "unresolved_reference",
        node.id,
        `Node "${node.id}" reads "${missing}", which this graph does not hold.`
      )
    }
  }
  return undefined
}

/** What the walk resolved before the first node ran. @private */
interface Declarations {
  /** Each named action's implementation, by tag. */
  readonly implementations: Map<string, Implementation>
  /** Each handoff node's target, by node id. */
  readonly handoffs: Map<string, AnyFlow>
  /** Each `.child()` node's callee, by node id. */
  readonly children: Map<string, AnyWithProps>
}

/**
 * Resolves every callee and implementation the graph names, in graph order.
 * Lost operations were diagnosed first, regardless of graph order.
 *
 * @private
 */
const resolveDeclarations = Effect.fnUntraced(function*(
  name: string,
  table: Implementations["Service"],
  graph: Graph.Graph,
  registerReachable: ((flow: AnyWithProps) => Effect.Effect<void>) | undefined
) {
  const declarations: Declarations = { implementations: new Map(), handoffs: new Map(), children: new Map() }
  for (const node of Graph.nodes(graph)) {
    const ast = node.ast
    if (ast._tag === "FlowCall" && (ast.mode === "handoff" || ast.mode === "boundary")) {
      yield* resolveCallee(name, declarations, node, ast, ast.mode, registerReachable)
    }
    if (ast._tag === "ActionCall") yield* resolveImplementation(name, table, declarations, node, ast)
  }
  return declarations
})

/** What a handoff or a `.child()` boundary that lost its declaration is refused with. @private */
const lostCallee = {
  handoff: (flow: string, id: string) =>
    `Handoff to flow "${flow}" at "${id}" lost its declaration. ` +
    "Build and interpret the authored node in the same process so its payload can be encoded.",
  boundary: (flow: string, id: string) =>
    `Child boundary to flow "${flow}" at "${id}" lost its declaration. ` +
    "Build and interpret the authored node in the same process so the child can be executed."
}

/**
 * Resolves the flow a handoff or a `.child()` boundary names, and registers
 * it. A boundary is one node here and a real execution underneath, so what it
 * needs resolved up front is the callee itself: the declaration is what
 * `execute` is called on, and losing it is a wiring error rather than a
 * run-time contingency, exactly like an unimplemented action.
 *
 * @private
 */
const resolveCallee = Effect.fnUntraced(function*(
  name: string,
  declarations: Declarations,
  node: Graph.GraphNode,
  ast: Extract<Node.Ast, { readonly _tag: "FlowCall" }>,
  mode: "handoff" | "boundary",
  registerReachable: ((flow: AnyWithProps) => Effect.Effect<void>) | undefined
) {
  const declaration = Node.declaration(ast)
  if (!Predicate.hasProperty(declaration, FlowTypeId)) {
    return yield* refusal(name, "unsupported_call", node.id, lostCallee[mode](ast.flow, node.id))
  }
  if (mode === "handoff") declarations.handoffs.set(node.id, declaration as unknown as AnyFlow)
  else declarations.children.set(node.id, declaration as unknown as AnyWithProps)
  if (registerReachable !== undefined) yield* registerReachable(declaration as unknown as AnyWithProps)
})

/** Resolves an action's implementation, refusing a version it does not attest. @private */
const resolveImplementation = Effect.fnUntraced(function*(
  name: string,
  table: Implementations["Service"],
  declarations: Declarations,
  node: Graph.GraphNode,
  ast: Extract<Node.Ast, { readonly _tag: "ActionCall" }>
) {
  const implementation = yield* table.get(ast.action)
  if (Option.isNone(implementation)) {
    return yield* refusal(
      name,
      "unresolved_action",
      node.id,
      `Action "${ast.action}" has no implementation. ` +
        `Provide ONE Action.layerImplementations under both ${ast.action}.toLayer(execute) and ` +
        "this interpreter layer: an implementation files itself with the table that is in scope " +
        "while IT is built, so a table merged beside it, or a second one built above it, is not the " +
        "table this driver reads."
    )
  }
  const refused = versionRefusal(name, node, ast, implementation.value)
  if (refused !== undefined) return yield* refused
  declarations.implementations.set(ast.action, implementation.value)
})

/** The refusal of an implementation whose version the declaration does not admit. @private */
const versionRefusal = (
  name: string,
  node: Graph.GraphNode,
  ast: Extract<Node.Ast, { readonly _tag: "ActionCall" }>,
  implementation: Implementation
): InterpreterError | undefined => {
  const declaration = Node.declaration(ast)
  const declaredVersion = ownDataProperty(declaration, "implementationVersion")
  const tier = ownDataProperty(declaration, "tier")
  if (tier === undefined) {
    return refusal(
      name,
      "incomplete_graph",
      node.id,
      `Action "${ast.action}" lost its declaration, so its implementation identity cannot be checked. ` +
        "Build the canonical composition from the authored action nodes."
    )
  }
  if (
    tier === "sealed" && ownDataProperty(declaration, "idempotencyKey") !== undefined &&
    declaredVersion === undefined
  ) {
    return refusal(
      name,
      "missing_implementation_version",
      node.id,
      `Sealed action "${ast.action}" declares an idempotency key and can reuse recorded content. ` +
        "Declare implementationVersion on Action.make and attest the same version in toLayer."
    )
  }
  if (declaredVersion === implementation.implementationVersion) return undefined
  return refusal(
    name,
    "implementation_version_mismatch",
    node.id,
    `Action "${ast.action}" does not match its registered implementationVersion. ` +
      "Register the declared version and start a newly planned execution when its semantics change."
  )
}

/**
 * The refusal of a graph with a dependency cycle, naming the first node it
 * blocks.
 *
 * Graph.build also accepts authored references. Unlike Plan.compile, this
 * entry point has not yet checked them for cycles: a self-reference would
 * join its own in-flight deferred forever. The entire dependency graph is
 * validated before dispatch, including branch arms the execution might skip.
 *
 * @private
 */
const cycleRefusal = (name: string, graph: Graph.Graph): InterpreterError | undefined => {
  const graphNodes = Graph.nodes(graph)
  const remaining = new Map<string, number>()
  const dependents = new Map<string, Array<string>>()
  const ready: Array<string> = []
  for (const node of graphNodes) {
    const dependencies = KeyMaterial.dependencies(node.draft.material)
    remaining.set(node.id, dependencies.length)
    if (dependencies.length === 0) ready.push(node.id)
    for (const dependency of dependencies) append(dependents, dependency, node.id)
  }
  for (let index = 0; index < ready.length; index++) {
    for (const consumer of dependents.get(ready[index]!) ?? []) {
      const count = remaining.get(consumer)! - 1
      remaining.set(consumer, count)
      if (count === 0) ready.push(consumer)
    }
  }
  if (ready.length === graphNodes.length) return undefined
  const blocked = graphNodes.find((node) => remaining.get(node.id)! > 0)!
  return refusal(
    name,
    "incomplete_graph",
    blocked.id,
    `Graph of "${name}" contains a dependency cycle blocking "${blocked.id}". ` +
      "Use an acyclic reference, a child boundary, or a trampoline handoff."
  )
}

/** One interpretation being walked: its graph, what it resolved up front, and what it has settled. @private */
interface Walk {
  readonly name: string
  readonly runtime: FlowRuntime["Service"]
  readonly nodes: ReadonlyArray<Graph.GraphNode>
  readonly byId: ReadonlyMap<string, Graph.GraphNode>
  readonly declarations: Declarations
  /**
   * The children a node settles with, in the order graph building recorded
   * them: `first` then the arms of a branch, `first` then the continuation of
   * a sequence, the members of a combination, the spliced body of an inline
   * call. Payload references are NOT here — they are named by the key
   * material, and settled from it.
   */
  readonly sources: ReadonlyMap<string, ReadonlyArray<string>>
  /**
   * The nodes that read each node's value through their key material: the
   * payload references and barriers a structural subtree does not show.
   */
  readonly readers: ReadonlyMap<string, ReadonlyArray<string>>
  readonly settled: Map<string, unknown>
  readonly failed: Map<string, unknown>
  /**
   * The settlement currently in flight for a node, for as long as it is.
   *
   * `settled.has(id)` alone is not a memo once the walk runs concurrently: it
   * answers "has this node FINISHED", and two demands that arrive while the
   * node is still running both see `false` and both execute it. A diamond
   * would then run its shared node twice, which for an action with effects is
   * a correctness bug rather than a wasted cycle.
   */
  readonly inFlight: Map<string, Deferred.Deferred<unknown, unknown>>
  /**
   * The interpretation's own scope. Every node computation runs on a fiber
   * forked into it, so an orphaned execution cannot outlive the
   * interpretation.
   */
  readonly scope: Scope.Closeable
  /**
   * The execution fiber of every node still running, so a join that settled
   * early can interrupt the work of the members it no longer waits for.
   */
  readonly executions: Map<string, Fiber.Fiber<unknown, unknown>>
  /**
   * The child execution id each `.child()` node opened. Interrupting the
   * node's fiber only stops its join: a losing child is cancelled through
   * the runtime, the same request a caller's cancellation makes.
   */
  readonly childExecutions: Map<string, string>
  /**
   * The nodes this walk has already settled a record for.
   *
   * Everything else is what the walk never reached, which is exactly the
   * `skipped` set reported at the end — an untaken branch arm, or a
   * dependent of something that failed.
   */
  readonly reported: Set<string>
  /**
   * Writes a node record, if the runtime keeps any. A runtime without the
   * seam costs a comparison per node and nothing else: the record is built
   * by the thunk only when something will hold it.
   */
  readonly record: (make: () => NodeRecord.NodeRecord) => Effect.Effect<void, InterpreterError, FlowInstance>
}

/** Starts the walk of a checked graph. @private */
const makeWalk = (
  name: string,
  runtime: FlowRuntime["Service"],
  graph: Graph.Graph,
  declarations: Declarations,
  scope: Scope.Closeable
): Walk => {
  const graphNodes = Graph.nodes(graph)
  const sources = new Map<string, Array<string>>()
  for (const edge of Graph.edges(graph)) {
    if (edge.reason === "value") append(sources, edge.to, edge.from)
  }
  const readers = new Map<string, Array<string>>()
  for (const node of graphNodes) {
    for (const dependency of KeyMaterial.dependencies(node.draft.material)) append(readers, dependency, node.id)
  }
  const recordNode = runtime.recordNode
  return {
    name,
    runtime,
    nodes: graphNodes,
    byId: new Map(graphNodes.map((node) => [node.id, node])),
    declarations,
    sources,
    readers,
    settled: new Map(),
    failed: new Map(),
    inFlight: new Map(),
    scope,
    executions: new Map(),
    childExecutions: new Map(),
    reported: new Set(),
    record: recordNode === undefined ? () => Effect.void : (make) => recordNode(make())
  }
}

/** A null-prototype record of `entries`, each defined as data so a `__proto__` key stays a field. @private */
const dataRecord = (entries: Iterable<readonly [string, unknown]>): Record<string, unknown> => {
  const record = Object.create(null) as Record<string, unknown>
  for (const [key, value] of entries) {
    Object.defineProperty(record, key, { configurable: true, enumerable: true, value, writable: true })
  }
  return record
}

/** Marks `target` as the value of a flow outcome tagged `tag`. @private */
const markOutcome = (target: object, tag: unknown): void => {
  Object.defineProperty(target, OutcomeValueTypeId, {
    configurable: false,
    enumerable: false,
    value: tag,
    writable: false
  })
}

/**
 * Replaces every placeholder in a hydrated payload with what it stands for.
 *
 * A placeholder is projected along the property path its `Ref` recorded,
 * through `StepKey.project`, the one projection semantics for the value
 * channel. The scheduler digests exactly what this returns; resolving a `Ref`
 * any other way here would let two executions that key identically consume
 * different values.
 *
 * The record is rebuilt with a null prototype and `defineProperty`, for the
 * reason {@link module:Graph.build}'s cloners are: `output[key] = …` on an
 * object literal routes `__proto__` through `Object.prototype`'s accessor,
 * which drops an own `__proto__` field carrying a primitive and reparents
 * the clone when it carries an object. A graph hydrates that field as data,
 * so the value handed to an action has to keep it as data too.
 *
 * @private
 */
const resolve = (walk: Walk, value: unknown): unknown => {
  const reference = Planned.reference(value)
  if (reference !== undefined) {
    const upstream = walk.settled.has(reference.node)
      ? walk.settled.get(reference.node)
      : walk.failed.get(reference.node)
    return StepKey.project(upstream, reference.path)
  }
  if (Array.isArray(value)) return value.map((item) => resolve(walk, item))
  if (!isRecord(value)) return value
  const output = dataRecord(Object.keys(value).map((key) => [key, resolve(walk, value[key])]))
  const outcome = Object.getOwnPropertyDescriptor(value, OutcomeValueTypeId)
  if (outcome !== undefined && "value" in outcome) markOutcome(output, outcome.value)
  return output
}

/**
 * Settles one node, at most once however many demands reach it.
 *
 * The check-and-register below is the whole reason this is a `suspend` and
 * not a generator: the callback runs synchronously, so no other fiber can
 * observe the gap between the lookup and the insert.
 *
 * Every computation runs on a fiber forked into the walk's scope, and every
 * demand — the first included — is a join on the node's deferred. Ownership
 * by the interpretation rather than by whichever demand arrived first is
 * what makes a ref-diamond sound: a failing `All` interrupts its member
 * JOINS, never a shared node's execution, so recovery arms above can still
 * join the shared work; and when the walk itself ends, closing the scope
 * interrupts whatever is still running, so an orphaned execution cannot
 * outlive the interpretation or write a phantom success into `settled`
 * afterwards (Skyframe's and `MemoMap`'s ownership model).
 *
 * @private
 */
const settleNode = (walk: Walk, id: string): Effect.Effect<unknown, unknown, Services> =>
  Effect.suspend(() => {
    if (walk.settled.has(id)) return Effect.succeed(walk.settled.get(id))
    const waiting = walk.inFlight.get(id)
    // A later demand joins the execution rather than starting one.
    if (waiting !== undefined) return Deferred.await(waiting)
    const deferred = Deferred.makeUnsafe<unknown, unknown>()
    walk.inFlight.set(id, deferred)
    const execution = execute(walk, walk.byId.get(id)!, deferred)
    // `startImmediately` keeps the first demand's latency identical to the
    // old inline execution: the node runs synchronously until its first
    // real suspension, so a body that parks does so before the driver's
    // next tick — the same observable cadence a sequential walk had.
    return Effect.forkIn(
      Effect.withFiber((fiber) => {
        walk.executions.set(id, fiber)
        return execution
      }),
      walk.scope,
      { startImmediately: true }
    ).pipe(Effect.andThen(Deferred.await(deferred)))
  })

/**
 * What one node's dispatches did, as the engine underneath it reports them.
 *
 * A node whose dispatches were ALL served from durable records rebuilt
 * nothing, and says so. The digests name those dispatches, so the attempt
 * rows the engine wrote under them belong to THIS node, and the highest
 * attempt reported is the node's real attempt count. A `Set` keeps the
 * digests unrepeated in report order: one dispatch retried three times keeps
 * one step key and reports it three times.
 *
 * @private
 */
interface Dispatches {
  executed: number
  replayed: number
  attempts: number
  readonly digests: Set<string>
}

/** Counts one dispatch the engine reported. @private */
const countDispatch = (dispatches: Dispatches, dispatch: DispatchOutcome): void => {
  if (dispatch.outcome === "executed") dispatches.executed = dispatches.executed + 1
  else dispatches.replayed = dispatches.replayed + 1
  // Bounded where it is COLLECTED, not where it is written: a cap applied at
  // the end still holds every digest in memory until then, and the point of
  // the cap is that one node cannot grow without bound.
  if (dispatch.stepKeyDigest !== undefined && dispatches.digests.size < maximumDispatchDigests) {
    dispatches.digests.add(dispatch.stepKeyDigest)
  }
  if (dispatch.attempt !== undefined && dispatch.attempt > dispatches.attempts) {
    dispatches.attempts = dispatch.attempt
  }
}

/** Whether a node rebuilt anything: one whose dispatches all replayed is `clean`. @private */
const rebuilt = (dispatches: Dispatches): NodeRecord.NodeOutcome =>
  dispatches.executed === 0 && dispatches.replayed > 0 ? "clean" : "built"

/** Persists a settlement before publishing it to other demands. @private */
const file = (
  walk: Walk,
  into: Map<string, unknown>,
  id: string,
  settlement: unknown,
  make: () => NodeRecord.NodeRecord
) =>
  walk.record(make).pipe(Effect.andThen(Effect.sync(() => {
    into.set(id, settlement)
    walk.reported.add(id)
  })))

/** The record a node settles with. @private */
const settledRecord = (
  walk: Walk,
  id: string,
  action: string | undefined,
  dispatches: Dispatches,
  outcome: NodeRecord.NodeOutcome,
  value: unknown
) =>
(): NodeRecord.NodeRecord => {
  const childExecutionId = walk.childExecutions.get(id)
  return {
    _tag: "NodeSettled",
    sourceId: `node/${id}/1/settled`,
    nodeId: id,
    outcome,
    attempts: dispatches.attempts,
    stepKeyDigests: [...dispatches.digests],
    value,
    ...(action === undefined ? {} : { action }),
    ...(childExecutionId === undefined ? {} : { childExecutionId })
  }
}

/**
 * Runs one node's computation, recording it scheduled and then settled, and
 * completes its deferred with the exit. An interrupted execution is evicted,
 * not memoized: current joiners observe the interruption, but a LATER demand
 * — a recovery arm, a re-driven walk — re-executes the node instead of
 * replaying an interrupt that says nothing about it.
 *
 * @private
 */
const execute = (walk: Walk, node: Graph.GraphNode, deferred: Deferred.Deferred<unknown, unknown>) => {
  const id = node.id
  const action = actionTag(node.ast)
  const dispatches: Dispatches = { executed: 0, replayed: 0, attempts: 1, digests: new Set<string>() }
  const report = DispatchReport.of({
    dispatched: (dispatch) => Effect.sync(() => countDispatch(dispatches, dispatch))
  })
  return walk.record(() => ({
    _tag: "NodeScheduled",
    sourceId: `node/${id}/1`,
    nodeId: id,
    kind: node.kind,
    attempt: 1,
    ...(action === undefined ? {} : { action })
  })).pipe(
    Effect.andThen(compute(walk, node).pipe(Effect.provideService(DispatchReport, report))),
    Effect.tap((value) =>
      file(walk, walk.settled, id, value, settledRecord(walk, id, action, dispatches, rebuilt(dispatches), value))
    ),
    Effect.tapError((error) =>
      file(walk, walk.failed, id, error, settledRecord(walk, id, action, dispatches, "failed", error))
    ),
    Effect.onExit((exit) => {
      if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) walk.inFlight.delete(id)
      walk.executions.delete(id)
      return Deferred.done(deferred, exit)
    })
  )
}

/**
 * What a node computes. A sequence, a branch, a catch, and a join settle
 * their own children in their own order; every other node first settles the
 * dependencies its key material names.
 *
 * @private
 */
const compute: (walk: Walk, node: Graph.GraphNode) => Effect.Effect<unknown, unknown, Services> = Effect.fnUntraced(
  function*(walk: Walk, node: Graph.GraphNode) {
    const children = walk.sources.get(node.id) ?? []
    const ast = node.ast
    if (ast._tag === "AndThen" && ast.next !== undefined) return yield* settleSequence(walk, children)
    if (ast._tag === "Branch") return yield* settleBranch(walk, ast, children)
    if (ast._tag === "Catch") return yield* settleCatch(walk, ast, children)
    if (ast._tag === "Race") return yield* settleRace(walk, node, ast, children)
    // Dependency order, from the key material: the same `Ref` and `Pending`
    // inputs the plan turns into edges, settled before the node that reads
    // them — and settled CONCURRENTLY, because independent dependencies are
    // exactly what the scheduler admits under separate permits. Two
    // execution surfaces disagreeing about concurrency is a correctness
    // hazard, not just a latency one.
    yield* Effect.forEach(
      KeyMaterial.dependencies(node.draft.material).filter((dependency) => !walk.failed.has(dependency)),
      (dependency) => settleNode(walk, dependency),
      { concurrency: "unbounded", discard: true }
    )
    switch (ast._tag) {
      case "ActionCall":
        return yield* runAction(walk, node, ast)
      case "Succeed":
        return resolve(walk, node.payload)
      case "Fail":
        // The typed error channel, from a constant the plan already holds.
        // An enclosing catch observes it exactly as it observes an action's
        // failure, and an uncaught one is the body's typed failure.
        return yield* Effect.fail(resolve(walk, node.payload))
      case "Map": {
        const transform = Node.mapper(ast)!
        return transform(yield* settleNode(walk, children[0]!))
      }
      case "All":
        return yield* combine(walk, ast, children)
      case "AndThen":
        return yield* settleNode(walk, children[1]!)
      case "FlowCall":
        return yield* settleCall(walk, node, ast, children)
    }
  }
)

/**
 * An explicit sequence: a success boundary for the WHOLE next subtree.
 * Joining first and then concurrently lets a nested All, Map, or inline call
 * start effects before its prerequisite settles. bindPlanned is distinct: it
 * declares data dependencies and can expose independent work while the
 * producer is still running.
 *
 * @private
 */
const settleSequence = (walk: Walk, children: ReadonlyArray<string>) =>
  Effect.andThen(settleNode(walk, children[0]!), settleNode(walk, children[1]!))

/**
 * A branch: the predicate decides on the REAL value, and only the arm it
 * chose is settled. Both arms are still in the plan; the untaken one is
 * reported as skipped.
 *
 * @private
 */
const settleBranch = Effect.fnUntraced(function*(
  walk: Walk,
  ast: Extract<Node.Ast, { readonly _tag: "Branch" }>,
  children: ReadonlyArray<string>
) {
  const decide = Node.predicate(ast)!
  const subject = yield* settleNode(walk, children[0]!)
  return yield* settleNode(walk, decide(subject) ? children[1]! : children[2]!)
})

/**
 * A catch: the recovery arm runs on a typed failure of the protected node
 * that its filter admits.
 *
 * DECIDED: catch observes only typed failures from ordinary protected
 * execution. Interpreter refusals propagate unchanged. Effect defects and
 * compensation failures remain outside this interpreter's error channel, so
 * recovery cannot conceal a broken invariant or weaken withRollback's
 * compensation guarantees.
 *
 * @private
 */
const settleCatch = (
  walk: Walk,
  ast: Extract<Node.Ast, { readonly _tag: "Catch" }>,
  children: ReadonlyArray<string>
) => {
  const protectedId = children[0]!
  return Effect.matchEffect(settleNode(walk, protectedId), {
    onFailure: (error) => {
      if (Schema.is(InterpreterError)(error)) return Effect.fail(error)
      const filter = Node.catchFilter(ast)
      if (filter !== undefined && !Schema.is(filter)(error)) return Effect.fail(error)
      // The failure arm's planned subject resolves through the protected
      // node id. Filing the typed failure as that settlement also prevents
      // its static failure edge from re-running the protected graph while
      // the recovery arm is driven.
      walk.failed.set(protectedId, error)
      return settleNode(walk, children[1]!)
    },
    onSuccess: Effect.succeed
  })
}

/**
 * A join: its members are left out of the dependency barrier, because a join
 * must not wait for every member; its other dependencies — the references
 * and barriers it reads — still settle first.
 *
 * @private
 */
const settleRace = Effect.fnUntraced(function*(
  walk: Walk,
  node: Graph.GraphNode,
  ast: Extract<Node.Ast, { readonly _tag: "Race" }>,
  children: ReadonlyArray<string>
) {
  const members = new Set(children)
  yield* Effect.forEach(
    KeyMaterial.dependencies(node.draft.material).filter((dependency) =>
      !members.has(dependency) && !walk.failed.has(dependency)
    ),
    (dependency) => settleNode(walk, dependency),
    { concurrency: "unbounded", discard: true }
  )
  return yield* join(walk, node, ast, children)
})

/**
 * Runs an action with the implementation the pre-pass resolved, which
 * refuses the whole graph when an action it names has none. The structural
 * node address is durable dispatch identity, scoped to this one
 * implementation call; it never comes from fiber arrival order.
 *
 * @private
 */
const runAction = (walk: Walk, node: Graph.GraphNode, ast: Extract<Node.Ast, { readonly _tag: "ActionCall" }>) =>
  walk.declarations.implementations.get(ast.action)!.action(resolve(walk, node.payload)).pipe(
    Effect.provideService(DispatchSite, node.id),
    attenuateCapabilities(node.capabilityCeilings)
  )

/**
 * An `All`: a combination, so its members settle concurrently — the same
 * semantics `PlanScheduler` gives the same graph. Fail-fast matches
 * `Effect.forEach`'s default and the scheduler's halt rule — with the
 * ownership caveat: what a failure interrupts is each sibling's JOIN, not the
 * node execution itself, which the interpretation owns and interrupts when
 * the walk ends. A node whose execution was interrupted is evicted from the
 * memo and records nothing, so it reports as skipped rather than as a
 * phantom success.
 *
 * @private
 */
const combine = Effect.fnUntraced(function*(
  walk: Walk,
  ast: Extract<Node.Ast, { readonly _tag: "All" }>,
  children: ReadonlyArray<string>
) {
  const members = Object.keys(ast.nodes)
  const values = yield* Effect.forEach(members, (_, index) => settleNode(walk, children[index]!), {
    concurrency: "unbounded"
  })
  return dataRecord(members.map((member, index) => [member, values[index]]))
})

/**
 * A flow call: a handoff settles as the next round's outcome, a `.child()`
 * boundary as its own execution, and an inline call as the body graph
 * building spliced beneath it.
 *
 * @private
 */
const settleCall = (
  walk: Walk,
  node: Graph.GraphNode,
  ast: Extract<Node.Ast, { readonly _tag: "FlowCall" }>,
  children: ReadonlyArray<string>
): Effect.Effect<unknown, unknown, Services> => {
  if (ast.mode === "handoff") return handOff(walk, node, ast)
  if (ast.mode === "boundary") return runChild(walk, node)
  const spliced = children[0]
  if (spliced !== undefined) return settleNode(walk, spliced)
  return Effect.fail(refusal(
    walk.name,
    "unsupported_call",
    node.id,
    `Flow "${ast.flow}" is called at "${node.id}" as a leaf, which this interpreter does not drive. ` +
      "An inline .call() is spliced into the graph with the callee's body and driven with it, and " +
      "only a call that lost its declaration has no body to splice. Build and interpret the authored " +
      `node in the same process, or call it as ${ast.flow}.child(payload) to run it as its own execution.`
  ))
}

/**
 * A handoff: the outcome that names the next round, its payload encoded by
 * the target's own schema.
 *
 * DECIDED: a handoff target's schema services come from the context
 * registration captured. A body's type cannot enumerate declarations hidden
 * in its topology, so erase only that dynamic service parameter after
 * resolving the concrete declaration here.
 *
 * @private
 */
const handOff = Effect.fnUntraced(function*(
  walk: Walk,
  node: Graph.GraphNode,
  ast: Extract<Node.Ast, { readonly _tag: "FlowCall" }>
) {
  const declaration = walk.declarations.handoffs.get(node.id)!
  const payload = yield* Effect.flatMap(
    Effect.orDie(declaration.payloadSchema.makeEffect(resolve(walk, node.payload) as never)),
    (decoded) => Effect.orDie(Schema.encodeEffect(Schema.toCodecJson(declaration.payloadSchema))(decoded))
  ) as unknown as Effect.Effect<unknown, never, Services>
  const ceiling = (yield* attenuateCapabilities(node.capabilityCeilings)(CapabilitySet.current)).groups
  const outcome = {
    _tag: "To",
    flow: ast.flow,
    payload,
    ...(ceiling.length === 0 ? {} : { capabilityCeilings: ceiling })
  } satisfies Outcome.To<unknown>
  markOutcome(outcome, "To")
  return outcome
})

/**
 * The real boundary of `docs/guides/run-a-child-flow.md`: an ordinary child
 * execution, opened through the same `execute` a handler would call. The
 * parent's `FlowInstance` is in scope, so the engine records the lineage
 * edge, interrupts the child with the parent, and turns a suspended child
 * into a suspended parent — genuine nesting, not a spliced imitation of it.
 * It is deliberately NOT `Effect.scoped`: the interrupt link the engine
 * installs is a finalizer of the PARENT's scope, and closing a scope of our
 * own here would run it the moment the child settled. The same dynamic
 * schema-service erasure a handoff records applies to the cast: a body's
 * type cannot enumerate the declarations hidden in its topology.
 *
 * @private
 */
const runChild = Effect.fnUntraced(function*(walk: Walk, node: Graph.GraphNode) {
  const declaration = walk.declarations.children.get(node.id)!
  const instance = yield* FlowInstance
  const childPayload = resolve(walk, node.payload)
  const executionId = yield* (childExecutionId(
    instance.executionId,
    node.id,
    declaration._tag,
    childPayload
  ) as unknown as Effect.Effect<string, never, Services>)
  walk.childExecutions.set(node.id, executionId)
  return yield* (declaration.execute(childPayload, { executionId }) as Effect.Effect<unknown, unknown, Services>).pipe(
    attenuateCapabilities(node.capabilityCeilings)
  )
})

/**
 * Everything the walk never reached, recorded once the walk is over.
 *
 * Only a walk that ENDED reports this. An interrupted one is a run that
 * parked or was cancelled, and its nodes are not skipped — the resumed walk
 * settles them, and recording them as skipped first would leave the journal
 * claiming a node never ran that later did. A typed failure is terminal for
 * the round, so its stranded nodes are skipped exactly as a completed walk's
 * untaken branch arm is.
 *
 * @private
 */
const recordSkipped = (walk: Walk, exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? Effect.void : Effect.forEach(
    walk.nodes.filter((node) => !walk.reported.has(node.id)),
    (node) => {
      const action = actionTag(node.ast)
      return walk.record(() => ({
        _tag: "NodeSettled",
        sourceId: `node/${node.id}/1/settled`,
        nodeId: node.id,
        outcome: "skipped",
        attempts: 0,
        // A node the walk never reached dispatched nothing, so it claims
        // no step key and there is no value it settled with.
        stepKeyDigests: [],
        ...(action === undefined ? {} : { action })
      }))
    },
    { discard: true }
  )

/** A child execution a losing join member opened. @private */
const JoinChild = Schema.Struct({ node: Schema.String, executionId: Schema.String })
type JoinChild = typeof JoinChild.Type

/**
 * The members a join decided on, in the order they decided, and the child
 * executions its losers had opened. A bare member list is the record written
 * before losing children were journaled; it names none, and still replays.
 *
 * @private
 */
const JoinDecision = Schema.Union([
  Schema.Struct({ members: Schema.Array(Schema.String), children: Schema.Array(JoinChild) }),
  Schema.Array(Schema.String)
])
type JoinDecision = typeof JoinDecision.Type

/** One member's decisive settlement. @private */
interface Decision {
  readonly member: string
  readonly exit: Exit.Exit<unknown, unknown>
}

/**
 * How a member's settlement counts toward a join: a value or a typed failure
 * decides, an interruption is still undecided, and a defect or interpreter
 * refusal is fatal to the join.
 *
 * @private
 */
const classify = (exit: Exit.Exit<unknown, unknown>): "decisive" | "pending" | "fatal" => {
  if (Exit.isSuccess(exit)) return "decisive"
  if (Cause.hasInterruptsOnly(exit.cause)) return "pending"
  const reasons = exit.cause.reasons
  const typed = reasons.every((reason) => reason._tag !== "Die") &&
    reasons.some((reason) => reason._tag === "Fail") &&
    !reasons.some((reason) => reason._tag === "Fail" && Schema.is(InterpreterError)(reason.error))
  return typed ? "decisive" : "fatal"
}

/**
 * A join's verdict over the members that decided, in the order they decided,
 * or `undefined` while it is still open.
 *
 * `race` takes the first settlement. `any` and `quorum` succeed once `count`
 * members succeed, and fail with the failure that leaves too few members able
 * to: for `any`, that is the last one.
 *
 * @private
 */
const decide = (
  ast: Extract<Node.Ast, { readonly _tag: "Race" }>,
  width: number,
  outcomes: ReadonlyArray<Decision>
): Exit.Exit<unknown, unknown> | undefined => {
  if (ast.mode === "race") return outcomes[0]?.exit
  const successes = outcomes.filter((outcome) => Exit.isSuccess(outcome.exit))
  if (successes.length >= ast.count) {
    if (ast.mode === "any") return successes[0]!.exit
    return Exit.succeed(
      dataRecord(successes.map((success) => [success.member, (success.exit as Exit.Success<unknown>).value]))
    )
  }
  if (outcomes.length - successes.length > width - ast.count) return outcomes[outcomes.length - 1]!.exit
  return undefined
}

/**
 * Settles a `Race` node: `race`, `any`, or `quorum`.
 *
 * The members that decided are journaled, in the order they decided, under a
 * durable deferred named for the node. Losing node fibers receive an
 * interruption request before that write can yield, and their child executions
 * are cancelled after it persists. A resumed walk that finds the record settles exactly those members — whose
 * own dispatches replay from their durable records — and never demands the
 * others, so it reaches the same verdict without running a loser again. A
 * defect or an interpreter refusal in a member is not a decision: it
 * propagates unjournaled, as it would from an `All`.
 *
 * The same record names the child executions the losers had opened, so a
 * process that dies between the journal write and their cancellation does
 * not orphan them: the resumed walk never demands a loser, and it cancels
 * those children from the record instead (#2892). Cancellation is a
 * first-writer-wins request, so repeating it on every replay is harmless.
 *
 * @private
 */
const join = Effect.fnUntraced(function*(
  walk: Walk,
  node: Graph.GraphNode,
  ast: Extract<Node.Ast, { readonly _tag: "Race" }>,
  children: ReadonlyArray<string>
) {
  const journal = DurableDeferred.make(`join/${node.id}`, { success: JoinDecision })
  const instance = yield* FlowInstance
  // A join is not a wait: reading its record must not consume the waiting
  // classification a parked sibling declared.
  const recorded = yield* walk.runtime.deferredResult(journal).pipe(
    Effect.provideService(FlowInstance, { ...instance })
  )
  if (Option.isSome(recorded) && Exit.isSuccess(recorded.value)) {
    return yield* replayJoin(walk, node, ast, children, recorded.value.value)
  }
  const journalDecision = (decision: JoinDecision) =>
    walk.runtime.deferredDone(journal, {
      flowName: instance.flow._tag,
      executionId: instance.executionId,
      deferredName: journal.name,
      exit: Exit.succeed(decision)
    })
  return yield* raceJoin(walk, node, ast, children, journalDecision)
})

/** Settles a join from its journal: the members it decided on, and nothing of its losers. @private */
const replayJoin = Effect.fnUntraced(function*(
  walk: Walk,
  node: Graph.GraphNode,
  ast: Extract<Node.Ast, { readonly _tag: "Race" }>,
  children: ReadonlyArray<string>,
  record: JoinDecision
) {
  const members = Object.keys(ast.nodes)
  const decided = "members" in record ? record.members : record
  const opened = "members" in record ? record.children : []
  const indices = decided.map((member) => members.indexOf(member))
  const mismatch = journalMismatch(walk, node, decided, indices, opened)
  if (mismatch !== undefined) return yield* mismatch
  yield* cancelChildren(walk, opened)
  // The losers are never demanded, so nothing of theirs starts again.
  const exits = yield* Effect.forEach(indices, (index) => Effect.exit(settleNode(walk, children[index]!)), {
    concurrency: "unbounded"
  })
  const verdict = replayedVerdict(ast, members, indices, exits)
  if (verdict !== undefined) return yield* verdict
  return yield* refusal(
    walk.name,
    "join_mismatch",
    node.id,
    `Join at "${node.id}" replayed members ${JSON.stringify(decided)} without reaching its verdict.`
  )
})

/** The refusal of a journal that names members or losing children this join no longer holds. @private */
const journalMismatch = (
  walk: Walk,
  node: Graph.GraphNode,
  decided: ReadonlyArray<string>,
  indices: ReadonlyArray<number>,
  opened: ReadonlyArray<JoinChild>
): InterpreterError | undefined => {
  if (indices.some((index) => index < 0) || new Set(indices).size !== indices.length) {
    return refusal(
      walk.name,
      "join_mismatch",
      node.id,
      `Join at "${node.id}" journaled members ${JSON.stringify(decided)}, which it no longer holds.`
    )
  }
  const lost = opened.find((child) => !walk.declarations.children.has(child.node))
  if (lost === undefined) return undefined
  return refusal(
    walk.name,
    "join_mismatch",
    node.id,
    `Join at "${node.id}" journaled a losing child at "${lost.node}", which the plan no longer holds.`
  )
}

/**
 * What a replayed join settles with: the first member that no longer decides,
 * or the verdict, which must close on the LAST journaled member exactly as it
 * did live. One that closes earlier, or never, is a different join, and has
 * no verdict here.
 *
 * @private
 */
const replayedVerdict = (
  ast: Extract<Node.Ast, { readonly _tag: "Race" }>,
  members: ReadonlyArray<string>,
  indices: ReadonlyArray<number>,
  exits: ReadonlyArray<Exit.Exit<unknown, unknown>>
): Exit.Exit<unknown, unknown> | undefined => {
  const outcomes: Array<Decision> = []
  for (let position = 0; position < exits.length; position++) {
    const exit = exits[position]!
    if (classify(exit) !== "decisive") return exit
    outcomes.push({ member: members[indices[position]!]!, exit })
    const verdict = decide(ast, members.length, outcomes)
    if (verdict !== undefined) return position === exits.length - 1 ? verdict : undefined
  }
  return undefined
}

/** A join being decided live. @private */
interface JoinRace {
  /** The members that decided, in the order they decided. */
  readonly outcomes: Array<Decision>
  verdict: Exit.Exit<unknown, unknown> | undefined
  /** Whether the verdict is a decision, which is journaled, rather than a fatal member. */
  journaled: boolean
  /** Completes once the join has a verdict. */
  readonly over: Deferred.Deferred<void>
}

/**
 * Settles a join live: every member runs until the join has a verdict, then
 * the decision is journaled and the losers' work is stopped.
 *
 * @private
 */
const raceJoin = Effect.fnUntraced(function*(
  walk: Walk,
  node: Graph.GraphNode,
  ast: Extract<Node.Ast, { readonly _tag: "Race" }>,
  children: ReadonlyArray<string>,
  journalDecision: (decision: JoinDecision) => Effect.Effect<void>
) {
  const members = Object.keys(ast.nodes)
  const race: JoinRace = { outcomes: [], verdict: undefined, journaled: false, over: Deferred.makeUnsafe<void>() }
  const watch = (index: number) =>
    Effect.exit(settleNode(walk, children[index]!)).pipe(
      Effect.flatMap((exit) => Effect.sync(() => observe(race, ast, members, index, exit)))
    )
  yield* Effect.raceFirst(
    Effect.forEach(children, (_, index) => watch(index), { concurrency: "unbounded", discard: true }),
    Deferred.await(race.over)
  )
  const verdict = race.verdict
  // Every member ended interrupted: the join cannot decide in this round, and
  // the walk parks or ends with it.
  if (verdict === undefined) return yield* Effect.interrupt
  const decided = race.outcomes.map((outcome) => outcome.member)
  const losers = children.filter((_, index) => !decided.includes(members[index]!))
  yield* Effect.uninterruptible(
    stopLosers(walk, node.id, losers, decided, race.journaled ? journalDecision : undefined)
  )
  return yield* verdict
})

/**
 * Stops the work of a decided join's losers: requests interruption of their
 * running node fibers; journals the decision, when it is one, together with
 * the child executions the losers opened; and cancels those children.
 *
 * @private
 */
const stopLosers = Effect.fnUntraced(function*(
  walk: Walk,
  joinId: string,
  losers: ReadonlyArray<string>,
  decided: ReadonlyArray<string>,
  journalDecision: ((decision: JoinDecision) => Effect.Effect<void>) | undefined
) {
  const { childRuns, fibers } = losingWork(walk, joinId, losers)
  // Request interruption before the journal write can yield: otherwise a
  // loser can open work absent from the cancellation snapshot.
  // The interruption is requested, not awaited: a loser's finalizers may wait
  // on work that only settles after the join returns, and the node scope
  // awaits every fiber when the walk ends anyway.
  yield* Effect.withFiber((current) =>
    Effect.sync(() => {
      for (const fiber of fibers) fiber.interruptUnsafe(current.id)
    })
  )
  if (journalDecision !== undefined) yield* journalDecision({ members: decided, children: childRuns })
  yield* cancelChildren(walk, childRuns)
})

/**
 * The work of the members a join no longer waits for: their running node
 * fibers and the child executions those nodes opened.
 *
 * A member's structural subtree is its own, so its running executions are
 * interrupted; nothing else demands them again. A node something outside that
 * subtree also reads is shared work the interpretation owns — the same
 * ownership an `All` failure respects — and keeps running, together with
 * everything inside the subtree it depends on.
 *
 * @private
 */
const losingWork = (walk: Walk, joinId: string, roots: ReadonlyArray<string>) => {
  const subtree = structuralSubtree(walk, roots)
  const kept = sharedWork(walk, joinId, subtree)
  const fibers: Array<Fiber.Fiber<unknown, unknown>> = []
  const childRuns: Array<JoinChild> = []
  for (const id of subtree) {
    if (kept.has(id)) continue
    const fiber = walk.executions.get(id)
    if (fiber === undefined) continue
    fibers.push(fiber)
    const executionId = walk.childExecutions.get(id)
    if (executionId !== undefined) childRuns.push({ node: id, executionId })
  }
  return { fibers, childRuns }
}

/**
 * Every node beneath `roots` along structural edges. Graph building gives
 * every node exactly one structural parent and reads each child through that
 * parent's key material, so the walk never reaches a node twice and every
 * node in a subtree has a reader.
 *
 * @private
 */
const structuralSubtree = (walk: Walk, roots: ReadonlyArray<string>): Set<string> => {
  const subtree = new Set<string>()
  const pending = [...roots]
  while (pending.length > 0) {
    const id = pending.pop()!
    subtree.add(id)
    pending.push(...walk.sources.get(id) ?? [])
  }
  return subtree
}

/** The nodes of `subtree` that work outside it also reads, and everything inside it they depend on. @private */
const sharedWork = (walk: Walk, joinId: string, subtree: ReadonlySet<string>): Set<string> => {
  const kept = new Set<string>()
  const shared = [...subtree].filter((id) =>
    walk.readers.get(id)!.some((reader) => reader !== joinId && !subtree.has(reader))
  )
  while (shared.length > 0) {
    const id = shared.pop()!
    if (kept.has(id) || !subtree.has(id)) continue
    kept.add(id)
    shared.push(...walk.sources.get(id) ?? [], ...KeyMaterial.dependencies(walk.byId.get(id)!.draft.material))
  }
  return kept
}

/**
 * Cancels the child executions a join's losers opened, through the runtime:
 * interrupting a node's fiber only stops its join, so a losing child is
 * cancelled with the same request a caller's cancellation makes.
 *
 * @private
 */
const cancelChildren = (walk: Walk, childRuns: ReadonlyArray<JoinChild>): Effect.Effect<void, never, Services> =>
  Effect.forEach(
    childRuns,
    ({ executionId, node }) =>
      Effect.orDie(walk.runtime.interrupt(walk.declarations.children.get(node)! as AnyFlow, executionId)),
    { discard: true }
  )

/** Counts one member's settlement toward a live join, closing the join once it has a verdict. @private */
const observe = (
  race: JoinRace,
  ast: Extract<Node.Ast, { readonly _tag: "Race" }>,
  members: ReadonlyArray<string>,
  index: number,
  exit: Exit.Exit<unknown, unknown>
): void => {
  if (race.verdict !== undefined) return
  const kind = classify(exit)
  // An interrupted member is still undecided: it parked, or a join elsewhere
  // cancelled shared work. The others may still decide without it.
  if (kind === "pending") return
  if (kind === "fatal") {
    race.verdict = exit
  } else {
    race.outcomes.push({ member: members[index]!, exit })
    race.verdict = decide(ast, members.length, race.outcomes)
    race.journaled = race.verdict !== undefined
  }
  if (race.verdict !== undefined) Deferred.doneUnsafe(race.over, Exit.void)
}

/**
 * Turns a body's root value into the settlement the engine acts on.
 *
 * Three of them exist, and only three
 * (`docs/concepts/trampoline-rounds.md`): `done(value)` is the answer, so the
 * value passes straight through; `Next.to(payload)` is the next round, recorded in the instance's
 * handoff slot so `Flow.intoResult` answers `Flow.Handoff`; and `park(reason)`
 * is a durable suspension, declared through the ordinary waiting vocabulary so
 * a durable driver parks the run under the flow's own reason and wake token
 * rather than the derived `timer`/`event` default. Anything else is an ordinary
 * value and is the answer as it stands, which is what keeps a body that never
 * heard of the trampoline working unchanged.
 *
 * @private
 */
const settleOutcome = (value: unknown): Effect.Effect<unknown, never, FlowInstance> => {
  if (!Outcome.isOutcome(value)) return Effect.succeed(value)
  switch (value._tag) {
    case "Done":
      return Effect.succeed(value.value)
    case "To":
      return Effect.gen(function*() {
        const instance = yield* FlowInstance
        const current = yield* CapabilitySet.current
        instance.handoff = new Handoff({
          flow: value.flow,
          payload: value.payload,
          capabilityCeilings: [...current.groups, ...(value.capabilityCeilings ?? [])]
        })
      })
    case "Park":
      return Effect.andThen(
        annotateWaiting(value.reason),
        Effect.flatMap(FlowInstance, suspend)
      )
  }
}

/**
 * Registers a flow with the runtime, driven by its body.
 *
 * This is the only way a flow's behavior reaches the runtime, and the reason a
 * flow has no `toLayer`: a flow has one behavior and it is the body, so there
 * is no second, opaque one to attach. An Action is what carries an
 * implementation, and it attaches that implementation with its own `toLayer`.
 * Compose this beside the action implementation layers the body calls, over the
 * {@link module:Implementations.layerImplementations} table they file
 * themselves in — the table goes UNDER them, because filing happens while an
 * implementation layer is built:
 *
 * ```ts
 * Layer.mergeAll(Read.toLayer(read), Write.toLayer(write), Interpreter.layer(Pipeline)).pipe(
 *   Layer.provideMerge(Action.layerImplementations)
 * )
 * ```
 *
 * It accepts a flow whatever its requirement channel says, and requires only
 * the table. Registering a body is not running one: the handler installed here
 * resolves each call by tag when the run reaches it, which is the same thing a
 * driver does for a plan read back out of a journal. `Flow.execute` is where
 * the requirements are asked for.
 *
 * This low-level registration keeps the `process-local` callback policy for
 * compatibility. Select `callbackIdentity: "stable"`, or use
 * {@link layerWithImplementations}, to refuse unstable callbacks before
 * dispatch. Without that selection it makes no reproducible-plan guarantee.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = <
  Tag extends string,
  Payload extends AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top
>(
  flow: Flow<Tag, Payload, Success, Error, any>,
  options: ExecutionOptions = {}
) => makeLayer(flow, options).pipe(Layer.provide(systemActions))

// These layers only register handlers at construction. Crypto is supplied by
// the executing interpreter (Services), not required to register a flow.
const systemHandlers = Layer.mergeAll(HumanTask.layer, Sleep.layer, WaitFor.layer) as Layer.Layer<
  never,
  never,
  FlowRuntime
>

// Independent module/refresh layer builds can share one implementation table.
// Memoize the built-ins by that owner, with Layer retaining each live scope's
// reference, rather than registering a second handler or overriding the first.
const systemMemoMaps = new WeakMap<Implementations["Service"], Layer.MemoMap>()
const systemActions = Layer.fromBuild((currentMemoMap, scope) =>
  Effect.flatMap(Implementations, (table) => {
    let memoMap = systemMemoMaps.get(table)
    if (memoMap === undefined) {
      memoMap = currentMemoMap
      systemMemoMaps.set(table, memoMap)
    }
    return Layer.buildWithMemoMap(systemHandlers, memoMap, scope)
  })
)

/** Host hooks around an interpreter registration. Heartbeat receipts are ephemeral,
 * reinstalled on every resume, and never sealed or copied to reachable child flows.
 * The durable driver invokes the hook with this run's FlowInstance after renewing
 * ownership, independently of model output. A receipt must be idempotent; it can
 * be interrupted or time out when the run ends. No receipt runs while parked.
 * @category models
 * @since 1.0.0
 */
export interface ExecutionOptions extends Graph.BuildOptions {
  readonly onHeartbeat?: ((executionId: string) => Effect.Effect<void>) | undefined
}

/** Registers the interpreter and reachable child flows under one policy. @private */
const makeLayer = <
  Tag extends string,
  Payload extends AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top
>(
  flow: Flow<Tag, Payload, Success, Error, any>,
  options: ExecutionOptions,
  reachable?: Set<AnyWithProps>,
  ifAbsent = false
): Layer.Layer<
  never,
  never,
  | FlowRuntime
  | Implementations
  | Payload["DecodingServices"]
  | Payload["EncodingServices"]
  | Success["DecodingServices"]
  | Success["EncodingServices"]
  | Error["DecodingServices"]
  | Error["EncodingServices"]
> =>
  Layer.effectDiscard(Effect.gen(function*() {
    const runtime = yield* FlowRuntime
    const registered = reachable ?? new Set<AnyWithProps>()
    if (registered.has(flow)) return
    // Lazy registration can be skipped by an independent live owner. Recheck
    // on later executions so releasing that owner permits fresh admission.
    if (!ifAbsent) registered.add(flow)
    const scope = yield* Effect.scope
    const context = yield* Effect.context<Services | Scope.Scope>()
    const implementations = Context.get(context, Implementations)
    // Keep discovered declarations in the host registration scope, rather
    // than the executing parent's scope: handoffs outlive that parent.
    // Dynamic declarations erase their codec services, just like execute;
    // those services still come from the registering host's context.
    const registerReachable = (declaration: AnyWithProps): Effect.Effect<void> =>
      Layer.buildWithScope(
        makeLayer(
          declaration as Flow<string, AnyStructSchema, Schema.Top, Schema.Top, any>,
          { ...options, onHeartbeat: undefined },
          registered,
          true
        ),
        scope
      ).pipe(
        Effect.provide(context),
        Effect.asVoid
      ) as Effect.Effect<void>
    const middleware = Context.get(flow.annotations, ExecutionMiddleware)
    yield* runtime.register(
      flow,
      ((payload: Payload["Type"]) => {
        const body = Effect.flatMap(
          interpretWithPolicy(flow, payload, options, registerReachable),
          (interpretation) => settleOutcome(interpretation.value)
        )
        // Registration owns action resolution. A caller may supply a different
        // table when entering this flow as a child; retain dynamic execution
        // services while restoring this flow's registered implementations.
        const interpreted = middleware === undefined ? body : middleware.wrap(payload, body)
        const hosted = options.onHeartbeat === undefined ? interpreted : Effect.gen(function*() {
          const instance = yield* FlowInstance
          instance.heartbeat = options.onHeartbeat!(instance.executionId)
          return yield* interpreted.pipe(Effect.ensuring(Effect.sync(() => {
            instance.heartbeat = undefined
          })))
        })
        return hosted.pipe(Effect.provideService(Implementations, implementations))
      }) as (payload: Payload["Type"], executionId: string) => Effect.Effect<
        Success["Type"],
        Error["Type"],
        Crypto.Crypto | Implementations
      >,
      { ifAbsent }
    )
  }))

/**
 * Composes one flow and its implementation layers around one isolated registry.
 *
 * The implementation layer must provide every action requirement carried by the
 * flow. Callback identity defaults to `stable`: raw callbacks are refused before
 * dispatch, with a diagnostic naming the callback and `Node.capture`. Captures
 * must cover semantic configuration and implementation versions, including
 * behavior reached through imports. Explicit `callbackIdentity: "process-local"`
 * is available for local experimentation, without a reproducible-plan claim.
 * Sealed actions with an idempotency key must declare `implementationVersion`
 * and register that exact version. This rule is independent of callback policy:
 * those declarations can reuse recorded content even if their code changes.
 * Keyless sealed actions use invocation identity; compensable and irreversible
 * actions do not use content-key caching. Their versions remain optional.
 * Versions must cover semantic handler and service changes; callback stability
 * cannot establish that declaration's completeness.
 *
 * The interpreter validates all named graph actions before dispatching any
 * of them. Conflicting registrations fail while the layer builds; use an explicit
 * `toLayer(handler, { override: true })` only for intentional scoped substitution.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerWithImplementations = <
  Tag extends string,
  Payload extends AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires,
  Provided,
  E,
  R
>(
  flow: Flow<Tag, Payload, Success, Error, Requires>,
  implementations:
    & Layer.Layer<Provided, E, R>
    & (
      [NoInfer<Requires>] extends [Provided] ? unknown
        : { readonly missingActionImplementations: Exclude<Requires, Provided> }
    ),
  options: ExecutionOptions = {}
) =>
  Layer.merge(
    implementations,
    makeLayer(flow, { ...options, callbackIdentity: options.callbackIdentity ?? "stable" }).pipe(
      Layer.provide(systemActions)
    )
  )
    .pipe(
      Layer.provide(layerImplementations),
      Layer.fresh
    )
