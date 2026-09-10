/**
 * Pure graph introspection for flow declarations.
 *
 * Governing contract: `packages/smithers/flows/core/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/core.
 *
 * @since 0.0.0
 */
import { Context, Option, Result, Schema } from "effect"
import * as Annotations from "./Annotations.ts"
import * as Effects from "./Effects.ts"
import * as Flow from "./Flow.ts"
import { GraphBuildError, isFatalDiagnostic } from "./internal/diagnostic.ts"
import * as EffectIndex from "./internal/effects.ts"
import * as internal from "./internal/node.ts"
import type { NodeAst } from "./internal/node.ts"
import type { FlowDetails } from "./internal/reflection.ts"
import {
  maximumDepth,
  maximumMembers,
  plannedInputRefs,
  plannedValue,
  reflection,
  schemaIdentity
} from "./internal/reflection.ts"
import type * as KeyMaterial from "./KeyMaterial.ts"
import * as Node from "./Node.ts"
import type * as Placement from "./Placement.ts"

/**
 * The diagnostic a graph build records or throws, its code union, and the
 * predicate that reports whether one blocks key material.
 *
 * @since 0.0.0
 */
export { GraphBuildError, GraphBuildErrorCode, isFatalDiagnostic } from "./internal/diagnostic.ts"

/**
 * Why one node depends on another.
 *
 * `value` is a structural dependency, `continuation` is a statically planned
 * `andThen` or `catch` arm, `conflict` is an ordering edge the write-conflict
 * pass added, and `lane-merge` orders laned writers, their merges, and consumers.
 *
 * @category models
 * @since 0.1.0
 */
export type EdgeReason = "value" | "continuation" | "conflict" | "lane-merge"

interface InternalEdge {
  readonly from: string
  readonly to: string
  readonly reason: EdgeReason
}

interface InternalNode {
  id: string
  kind: NodeAst["_tag"] | "LaneMerge"
  dependencies: Array<string>
  declaredEffects: Effects.Declaration | undefined
  effectiveEffects: Effects.Declaration | undefined
  placement: Placement.Placement | undefined
  lane: Annotations.LaneOptions | undefined
  priority: number | undefined
  capabilities: ReadonlyArray<string>
  annotations: AnnotationsProjection
  keyMaterial: KeyMaterial.KeyMaterial | undefined
}

const noInput = Symbol("flows/core/Graph/noInput")

interface VisitResult {
  readonly id: string
}

/**
 * A serializable projection of resolved annotations.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface AnnotationsProjection {
  readonly placement: Placement.Placement | undefined
  readonly effects: Effects.Declaration | undefined
  readonly lane: Annotations.LaneOptions | undefined
  readonly priority: number | undefined
}

/**
 * A node observed in a built graph.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface GraphNode {
  readonly id: string
  readonly kind: NodeAst["_tag"] | "LaneMerge"
  readonly dependencies: ReadonlyArray<string>
  readonly declaredEffects: Effects.Declaration | undefined
  readonly effectiveEffects: Effects.Declaration | undefined
  readonly placement: Placement.Placement | undefined
  readonly lane: Annotations.LaneOptions | undefined
  readonly priority: number | undefined
  readonly capabilities: ReadonlyArray<string>
  readonly annotations: AnnotationsProjection
  readonly keyMaterial: KeyMaterial.KeyMaterial
}

/**
 * A dependency edge in a built graph.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface Edge {
  readonly from: string
  readonly to: string
  readonly reason: EdgeReason
}

/**
 * A pair of nodes whose declared writes overlap.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface Conflict {
  readonly nodes: readonly [string, string]
  readonly paths: ReadonlyArray<string>
  readonly strategy: "serialize" | "lane" | "fail"
  readonly mergeNodeId?: string | undefined
}

/**
 * Declared and inherited effects for one graph node.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface EffectEntry {
  readonly nodeId: string
  readonly declared: Effects.Declaration | undefined
  readonly effective: Effects.Declaration | undefined
}

/**
 * Resolved placement for one graph node.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface PlacementEntry {
  readonly nodeId: string
  readonly placement: Placement.Placement
}

/**
 * Information supplied to the planner's pure per-node layer resolver.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface LayerRequest {
  readonly nodeId: string
  readonly kind: NodeAst["_tag"] | "LaneMerge"
  readonly model: string | undefined
  readonly capabilities: ReadonlyArray<string>
  readonly effects: Effects.Declaration | undefined
  readonly placement: Placement.Placement | undefined
}

/**
 * Planner inputs used while constructing key material.
 *
 * `resolveLayers` is invoked independently for each node and must be trusted
 * and pure under the same caller obligation as `build`. It returns resolved
 * host, model, and permission implementation identities, not Effect Layers or
 * runtime handles.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface BuildOptions {
  readonly resolveLayers?: ((request: LayerRequest) => Iterable<string>) | undefined
}

/**
 * Maximum structural nesting accepted by {@link build}.
 *
 * @category limits
 * @since 0.1.0
 * @slop
 */
export const maximumGraphDepth = 512

/**
 * Maximum nesting accepted while projecting a plan value into identity.
 *
 * @category limits
 * @since 0.1.0
 * @slop
 */
export const maximumPayloadDepth = maximumDepth

/**
 * Maximum number of nodes, including synthesized lane merges, accepted by
 * {@link build}.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumGraphNodes = 4096

/**
 * Maximum number of dependency edges, including the conflict and lane-merge
 * edges the write-conflict pass adds, accepted by {@link build}.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumGraphEdges = 65_536

/**
 * Maximum number of write conflicts {@link build} records before it refuses
 * the plan.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumGraphConflicts = 65_536

/**
 * Maximum number of members one plan value may expand to while it is
 * projected into identity: object keys, array items and holes, map entries,
 * set and chunk values, and bytes, summed across every level of that value.
 * A flow call's input and a declaration body are budgeted separately.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumPayloadMembers = maximumMembers

/**
 * Maximum number of read and write paths, summed, one effect declaration may
 * list before {@link build} refuses the plan with `plan_too_large`. Every
 * declaration the graph carries obeys it: an annotation, a dynamic node's own
 * envelope, a called flow's envelope, and a synthesized lane merge, whose
 * reads and writes both name the overlap it merges.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumEffectPaths = 1024

/**
 * Maximum number of effect paths {@link build} admits across one plan before
 * it refuses with `plan_too_large`. A declaration is counted where it is
 * declared and again at every work node that inherits it as its effective
 * envelope, because each such node is a writer the conflict pass compares.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumPlanEffectPaths = 65_536

/**
 * Maximum length, in UTF-16 code units, of one effect path {@link build}
 * admits before it refuses the plan with `plan_too_large`.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumEffectPathLength = EffectIndex.maximumPathLength

/**
 * Maximum number of patterns, entries ending in `*`, one read list or one
 * write list of an effect declaration may carry before {@link build} refuses
 * the plan with `plan_too_large`.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumEffectGlobs = EffectIndex.maximumGlobs

declare const GraphTypeId: unique symbol

/**
 * An immutable, observation-only flow graph.
 *
 * {@link build} deep-freezes everything it constructs, so the getters below
 * hand back the graph's own values rather than copies and an observer cannot
 * edit the plan it is reading. Read a graph through {@link nodes},
 * {@link edges}, {@link effects}, {@link placements}, {@link conflicts},
 * {@link diagnostics}, and {@link keyMaterial}; the storage fields behind those
 * getters are not part of the published shape, so this type names none of
 * them. Publishing them would type a write to a frozen node as legal and turn
 * it into a runtime `TypeError`.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface Graph {
  readonly [GraphTypeId]: typeof GraphTypeId
}

/**
 * The storage `build` allocates behind a {@link Graph} handle. A graph is its
 * storage at runtime; the extra declaration exists so only this module can
 * name the fields.
 */
interface GraphImpl extends Graph {
  readonly nodes: ReadonlyArray<InternalNode>
  readonly edges: ReadonlyArray<InternalEdge>
  readonly diagnostics: ReadonlyArray<GraphBuildError>
  readonly conflicts: ReadonlyArray<Conflict>
}

const impl = (graph: Graph): GraphImpl => graph as GraphImpl

const option = <I, S>(context: Context.Context<never>, key: Context.Key<I, S>): S | undefined =>
  Option.getOrUndefined(Annotations.getOption(context, key))

const snapshotPlacement = (placement: Placement.Placement | undefined): Placement.Placement | undefined =>
  placement === undefined ? undefined : { ...placement }

const snapshotLane = (lane: Annotations.LaneOptions | undefined): Annotations.LaneOptions | undefined =>
  lane === undefined ? undefined : { ...lane }

const annotationProjection = (
  context: Context.Context<never>,
  effects: Effects.Declaration | undefined
): AnnotationsProjection => ({
  placement: snapshotPlacement(option(context, Annotations.Placement)),
  effects,
  lane: snapshotLane(option(context, Annotations.Lane)),
  priority: option(context, Annotations.Priority)
})

const withoutEffects = (context: Context.Context<never>): Context.Context<never> =>
  Context.omit(Annotations.Effects)(context)

const tier = (effects: Effects.Declaration | undefined): KeyMaterial.KeyMaterial["kind"] => effects?.tier ?? "sealed"

const declarationBody = (
  ast: NodeAst,
  flow: FlowDetails | undefined,
  nodeId: string,
  ownEffects: Effects.Declaration | undefined
): unknown => {
  switch (ast._tag) {
    case "Succeed":
      return { _tag: ast._tag, value: reflection(ast.value, nodeId) }
    case "Fail":
      return { _tag: ast._tag, error: reflection(ast.error, nodeId) }
    case "All":
      return { _tag: ast._tag, keys: Object.keys(ast.nodes).sort() }
    case "Dynamic":
      return {
        _tag: ast._tag,
        model: ast.model,
        flows: reflection(ast.flows, nodeId, new Set(), 0, "$.flows"),
        output: reflection(ast.output, nodeId, new Set(), 0, "$.output"),
        prompt: ast.prompt,
        effects: ownEffects
      }
    case "FlowCall":
      return {
        _tag: ast._tag,
        input: flow === undefined ? undefined : schemaIdentity(flow.input, nodeId, 0, "$.input"),
        output: flow === undefined ? undefined : schemaIdentity(flow.output, nodeId, 0, "$.output"),
        capabilities: flow?.capabilities === undefined ? undefined : [...new Set(flow.capabilities)].sort(),
        effects: ownEffects,
        implementation: reflection(flow?.implementation, nodeId, new Set(), 0, "$.implementation")
      }
    case "Map":
      return { _tag: ast._tag, mapper: ast.mapper }
    case "AndThen":
      return { _tag: ast._tag, continuation: ast.continuation, static: ast.next !== undefined }
    case "Catch":
      return {
        _tag: ast._tag,
        handler: ast.handler,
        error: ast.error === undefined ? undefined : schemaIdentity(ast.error as Schema.Top, nodeId, 0, "$.error")
      }
  }
}

const strategy = (left: Effects.Declaration, right: Effects.Declaration): Conflict["strategy"] => {
  if (left.onConflict === "fail" || right.onConflict === "fail") return "fail"
  if (left.onConflict === "lane" || right.onConflict === "lane") return "lane"
  return "serialize"
}

const supportedNodeTags: ReadonlySet<NodeAst["_tag"]> = Object.freeze(
  new Set<NodeAst["_tag"]>([
    "Succeed",
    "Fail",
    "All",
    "Dynamic",
    "AndThen",
    "Map",
    "FlowCall",
    "Catch"
  ])
)

const invalidNode = (nodeId: string, cause?: unknown): GraphBuildError => {
  const error = new GraphBuildError({ code: "invalid_node", paths: [], nodeId })
  Object.defineProperty(error, "message", {
    configurable: true,
    enumerable: false,
    value: `Graph.build expected a supported Node AST at "${nodeId}"`,
    writable: true
  })
  if (cause !== undefined) {
    Object.defineProperty(error, "cause", {
      configurable: true,
      enumerable: false,
      value: cause,
      writable: false
    })
  }
  return error
}

const validateNodeAst = (value: unknown, nodeId: string): NodeAst => {
  try {
    if (typeof value !== "object" || value === null) throw invalidNode(nodeId)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const tag = descriptors._tag
    const annotations = descriptors.annotations
    if (
      tag === undefined ||
      !("value" in tag) ||
      !supportedNodeTags.has(tag.value as NodeAst["_tag"]) ||
      annotations === undefined ||
      !("value" in annotations) ||
      !Context.isContext(annotations.value)
    ) {
      throw invalidNode(nodeId)
    }
    const field = (key: string): unknown => {
      const descriptor = descriptors[key]
      if (descriptor === undefined || !("value" in descriptor)) throw invalidNode(nodeId)
      return descriptor.value
    }
    switch (tag.value as NodeAst["_tag"]) {
      case "Succeed":
        field("value")
        break
      case "Fail":
        field("error")
        break
      case "All": {
        const nodes = field("nodes")
        if (nodes === null || typeof nodes !== "object") throw invalidNode(nodeId)
        break
      }
      case "Dynamic":
        if (!Array.isArray(field("flows"))) throw invalidNode(nodeId)
        break
      case "AndThen":
      case "Map":
      case "Catch": {
        const first = field("first")
        if (first === null || typeof first !== "object") throw invalidNode(nodeId)
        if (tag.value === "Catch") {
          const error = field("error")
          if (error !== undefined && !Schema.isSchema(error)) throw invalidNode(nodeId)
        }
        break
      }
      case "FlowCall":
        field("input")
        break
    }
    return value as NodeAst
  } catch (cause) {
    if (cause instanceof GraphBuildError) throw cause
    throw invalidNode(nodeId, cause)
  }
}

const nodeAst = (value: unknown, nodeId: string): NodeAst => {
  try {
    return validateNodeAst((value as { readonly ast?: unknown } | null)?.ast, nodeId)
  } catch (cause) {
    if (cause instanceof GraphBuildError) throw cause
    throw invalidNode(nodeId, cause)
  }
}

const freezeDeep = (value: unknown, seen: WeakSet<object> = new WeakSet()): void => {
  if (typeof value !== "object" || value === null || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    // A graph-owned array holds only indexed data members, so they are read
    // in place: describing each would allocate one record per path of every
    // conflict's list and every diagnostic's list only to discard it.
    for (const member of value) freezeDeep(member, seen)
  } else {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if ("value" in descriptor) freezeDeep(descriptor.value, seen)
    }
  }
  Object.freeze(value)
}

const freezeKeyMaterial = (material: KeyMaterial.KeyMaterial): void => {
  freezeDeep(material.body)
  for (const input of material.inputs) {
    if (input._tag === "Ref") freezeDeep(input.path)
    // A Literal payload is this module's own projection of the plan value, not
    // the caller's object, so freezing it closes the last writable path into
    // recorded key material.
    if (input._tag === "Literal") freezeDeep(input.value)
    Object.freeze(input)
  }
  freezeDeep(material.inputs)
  freezeDeep(material.layers)
  freezeDeep(material.capabilities)
  freezeDeep(material.effects)
  freezeDeep(material.placement)
  Object.freeze(material)
}

const freezeGraph = (
  graph: {
    readonly nodes: Array<InternalNode>
    readonly edges: Array<InternalEdge>
    readonly diagnostics: Array<GraphBuildError>
    readonly conflicts: Array<Conflict>
  }
): Graph => {
  for (const node of graph.nodes) {
    freezeDeep(node.dependencies)
    freezeDeep(node.declaredEffects)
    freezeDeep(node.effectiveEffects)
    freezeDeep(node.placement)
    freezeDeep(node.lane)
    freezeDeep(node.capabilities)
    freezeDeep(node.annotations)
    /* v8 ignore else -- `build` gives every node key material before freezing; the guard keeps the field optional for readers that construct a graph by hand */
    if (node.keyMaterial !== undefined) freezeKeyMaterial(node.keyMaterial)
    Object.freeze(node)
  }
  for (const edge of graph.edges) freezeDeep(edge)
  for (const conflict of graph.conflicts) freezeDeep(conflict)
  for (const diagnostic of graph.diagnostics) freezeDeep(diagnostic)
  freezeDeep(graph.nodes)
  freezeDeep(graph.edges)
  freezeDeep(graph.conflicts)
  freezeDeep(graph.diagnostics)
  return Object.freeze(graph) as unknown as Graph
}

const dependencyOrder = (
  nodes: ReadonlyArray<InternalNode>
): Result.Result<ReadonlyArray<InternalNode>, GraphBuildError> => {
  const ordered: Array<InternalNode> = []
  const complete = new Set<string>()
  const active = new Set<string>()
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const stack: Array<{ readonly node: InternalNode; next: number }> = []
  for (const node of nodes) {
    if (complete.has(node.id)) continue
    active.add(node.id)
    stack.push({ node, next: 0 })
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      if (frame.next < frame.node.dependencies.length) {
        const dependency = frame.node.dependencies[frame.next++]!
        if (active.has(dependency)) {
          return Result.fail(new GraphBuildError({ code: "dependency_cycle", paths: [], nodeId: dependency }))
        }
        const child = byId.get(dependency)
        if (child !== undefined && !complete.has(dependency)) {
          active.add(dependency)
          stack.push({ node: child, next: 0 })
        }
      } else {
        stack.pop()
        active.delete(frame.node.id)
        complete.add(frame.node.id)
        ordered.push(frame.node)
      }
    }
  }
  return Result.succeed(ordered)
}

/**
 * Builds a graph by evaluating flow bodies against their inputs and
 * `Node.andThen` builders and `Node.catch` recovery callbacks against symbolic
 * predecessor values, without executing planned steps, `Node.map` value
 * transformations, or dynamic elaborations.
 *
 * Declarations and all planning callbacks must be trusted and pure. They run
 * in the caller process with ambient authority; purity is a caller obligation,
 * not an enforced boundary. Placement, capability, and effect metadata does
 * not sandbox planning. Use a constrained data-only ingestion boundary or an
 * externally isolated planner for untrusted declarations. See
 * https://core.smithers.sh/concepts/plan-time/#planning-requires-trusted-declarations
 *
 * Values supplied to `Node.succeed`, `Node.fail`, and flow calls are retained
 * by reference and read here. Mutating one before this function runs changes
 * its recorded identity.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const build = (
  flowOrNode: Flow.Any | Node.Any,
  input?: unknown,
  options: BuildOptions = {}
): Graph => {
  const observed: Array<InternalNode> = []
  const observedEdges: Array<InternalEdge> = []
  const observedDiagnostics: Array<GraphBuildError> = []
  const workNodes = new Set<InternalNode>()
  // Outgoing edges by source, each with its position in `observedEdges`, so a
  // reachability query and a lane-merge consumer lookup cost the node's degree
  // rather than a scan of every edge recorded so far.
  const outgoing = new Map<string, Array<{ readonly to: string; readonly index: number }>>()
  const edgesFrom = (id: string): ReadonlyArray<{ readonly to: string; readonly index: number }> =>
    outgoing.get(id) ?? []

  const planTooLarge = (nodeId: string): GraphBuildError =>
    new GraphBuildError({ code: "plan_too_large", paths: [], nodeId })

  // Effect paths admitted so far, across every declaration this build copies.
  let planEffectPaths = 0
  /**
   * Snapshots a declaration into graph-owned data, charging its paths to the
   * per-declaration and plan-wide limits. Both are checked before a path is
   * copied, so the copy never grows past the smaller remaining allowance.
   */
  const admitEffects = (
    declaration: Effects.Declaration | undefined,
    nodeId: string
  ): Effects.Declaration | undefined => {
    if (declaration === undefined) return undefined
    const effects = EffectIndex.boundedEffects(
      declaration,
      Math.min(maximumEffectPaths, maximumPlanEffectPaths - planEffectPaths),
      () => planTooLarge(nodeId)
    )
    planEffectPaths += effects.reads.length + effects.writes.length
    return effects
  }

  // An envelope is graph-owned and reaches every node it encloses as the same
  // object, so it is prepared once and each enclosed declaration is checked
  // against the prepared form: a wide envelope costs its size once per build
  // rather than once per node that narrows it.
  const preparedEnvelopes = new Map<Effects.Declaration, EffectIndex.PreparedEnvelope>()
  const narrowAgainst = (envelope: Effects.Declaration, step: Effects.Declaration): Effects.NarrowResult => {
    let prepared = preparedEnvelopes.get(envelope)
    if (prepared === undefined) {
      prepared = EffectIndex.prepareEnvelope(envelope)
      preparedEnvelopes.set(envelope, prepared)
    }
    return EffectIndex.narrowPrepared(prepared, step)
  }

  const recordNode = (node: InternalNode): void => {
    if (observed.length >= maximumGraphNodes) throw planTooLarge(node.id)
    observed.push(node)
  }

  const recordEdge = (edge: InternalEdge): void => {
    if (observedEdges.length >= maximumGraphEdges) throw planTooLarge(edge.to)
    const index = observedEdges.push(edge) - 1
    const targets = outgoing.get(edge.from)
    if (targets === undefined) {
      outgoing.set(edge.from, [{ to: edge.to, index }])
    } else {
      targets.push({ to: edge.to, index })
    }
  }

  const resolveLayers = (request: LayerRequest): ReadonlyArray<string> =>
    [...new Set(options.resolveLayers?.(request) ?? [])].sort()

  const visit = (
    ast: NodeAst,
    id: string,
    parentAnnotations: Context.Context<never>,
    capabilities: ReadonlyArray<string> | undefined,
    envelope: Effects.Declaration | undefined,
    depth = 0,
    callInput: unknown | typeof noInput = noInput,
    prerequisites: ReadonlyArray<{ readonly from: string; readonly reason: EdgeReason }> = []
  ): VisitResult => {
    if (depth > maximumGraphDepth) {
      throw new GraphBuildError({ code: "plan_too_deep", paths: [], nodeId: id })
    }
    ast = validateNodeAst(ast, id)
    const annotations = Annotations.merge(parentAnnotations, ast.annotations)
    const projection = annotationProjection(annotations, admitEffects(option(annotations, Annotations.Effects), id))
    const targetFlow = ast._tag === "FlowCall" ? internal.flow(ast) : undefined
    const flow = Flow.isFlow(targetFlow)
      ? targetFlow as FlowDetails
      : undefined
    // The declaration the AST itself carries: a dynamic node's own envelope or
    // the called flow's. It is admitted even when an annotation overrides it,
    // because it still reaches key material and, for a flow call, must narrow
    // the body's envelope.
    const ownEffects = ast._tag === "Dynamic"
      ? admitEffects(ast.effects, id)
      : ast._tag === "FlowCall"
      ? admitEffects(flow?.effects, id)
      : undefined
    const declaredEffects = projection.effects ?? ownEffects
    const work = ast._tag === "Dynamic"
    const effectiveEffects = work ? declaredEffects ?? admitEffects(envelope, id) : undefined
    const identityEffects = work ? effectiveEffects : projection.effects
    const dependencies: Array<string> = []
    const continuationDependencies = new Set<string>()
    const effectiveCallInput = ast._tag === "FlowCall" ? ast.input : callInput
    const normalizedGrant = capabilities === undefined ? undefined : [...new Set(capabilities)].sort()
    const recordedCapabilities = normalizedGrant ?? []
    const current: InternalNode = {
      id,
      kind: ast._tag,
      dependencies,
      declaredEffects,
      effectiveEffects,
      placement: projection.placement,
      lane: projection.lane,
      priority: projection.priority,
      capabilities: recordedCapabilities,
      annotations: projection,
      keyMaterial: undefined
    }
    recordNode(current)
    if (work) workNodes.add(current)

    const depend = (from: string, reason: EdgeReason): void => {
      dependencies.push(from)
      if (reason === "continuation") continuationDependencies.add(from)
      recordEdge({ from, to: id, reason })
    }
    for (const prerequisite of prerequisites) {
      depend(prerequisite.from, prerequisite.reason)
    }

    const narrowedEnvelope = declaredEffects ?? envelope
    const childAnnotations = withoutEffects(annotations)
    switch (ast._tag) {
      case "Succeed":
      case "Fail":
        break
      case "All": {
        for (const key of Object.keys(ast.nodes).sort()) {
          const child = visit(
            ast.nodes[key]!,
            `${id}.all.${key}`,
            childAnnotations,
            normalizedGrant,
            narrowedEnvelope,
            depth + 1,
            noInput,
            prerequisites
          )
          depend(child.id, "value")
        }
        break
      }
      case "Map": {
        const first = visit(
          ast.first,
          `${id}.map`,
          childAnnotations,
          normalizedGrant,
          narrowedEnvelope,
          depth + 1,
          noInput,
          prerequisites
        )
        depend(first.id, "value")
        break
      }
      case "AndThen": {
        const first = visit(
          ast.first,
          `${id}.andThen`,
          childAnnotations,
          normalizedGrant,
          narrowedEnvelope,
          depth + 1,
          noInput,
          prerequisites
        )
        const next = ast.next ?? (() => {
          const continuation = internal.operation(ast)
          if (continuation === undefined) {
            throw new Node.NodeBuildError({
              code: "invalid_continuation",
              member: id,
              message: `Node.andThen at "${id}" has no continuation builder`
            })
          }
          const result = continuation(plannedValue(first.id))
          if (!Node.isNode(result)) {
            throw new Node.NodeBuildError({
              code: "invalid_continuation",
              member: id,
              message: `Node.andThen at "${id}" must return a Node`
            })
          }
          return nodeAst(result, `${id}.then`)
        })()
        {
          const continuation = visit(
            next,
            `${id}.then`,
            childAnnotations,
            normalizedGrant,
            narrowedEnvelope,
            depth + 1,
            noInput,
            [{ from: first.id, reason: "continuation" }]
          )
          depend(continuation.id, "value")
        }
        break
      }
      case "Catch": {
        const first = visit(
          ast.first,
          `${id}.catch`,
          childAnnotations,
          normalizedGrant,
          narrowedEnvelope,
          depth + 1,
          noInput,
          prerequisites
        )
        depend(first.id, "value")
        const handler = internal.operation(ast)
        if (handler === undefined) {
          throw new Node.NodeBuildError({
            code: "invalid_continuation",
            member: id,
            message: `Node.catch at "${id}" has no recovery builder`
          })
        }
        const arm = handler(plannedValue(first.id))
        if (!Node.isNode(arm)) {
          throw new Node.NodeBuildError({
            code: "invalid_continuation",
            member: id,
            message: `Node.catch at "${id}" must return a Node`
          })
        }
        const recovery = visit(
          nodeAst(arm, `${id}.recover`),
          `${id}.recover`,
          childAnnotations,
          normalizedGrant,
          narrowedEnvelope,
          depth + 1,
          noInput,
          [{ from: first.id, reason: "continuation" }]
        )
        depend(recovery.id, "value")
        break
      }
      case "FlowCall": {
        // Each accepted declaration narrows the preceding envelope, so the
        // body inherits their intersection. A rejected declaration must not
        // replace the last validated envelope while diagnostics are collected.
        let calleeEnvelope = envelope
        for (const declaration of [projection.effects, ownEffects]) {
          if (declaration === undefined) continue
          if (calleeEnvelope !== undefined) {
            const narrowed = narrowAgainst(calleeEnvelope, declaration)
            if (!narrowed.ok) {
              observedDiagnostics.push(
                new GraphBuildError({ code: narrowed.code, paths: [...narrowed.paths], nodeId: id })
              )
              continue
            }
          }
          calleeEnvelope = declaration
        }
        const flowCapabilities = flow === undefined ? [] : [...new Set(flow.capabilities)].sort()
        const dropped = normalizedGrant === undefined
          ? []
          : flowCapabilities.filter((capability) => !normalizedGrant.includes(capability))
        if (dropped.length > 0) {
          observedDiagnostics.push(
            new GraphBuildError({
              code: "capability_outside_grant",
              paths: dropped,
              nodeId: id
            })
          )
        }
        if (flow?.body !== undefined) {
          const body = flow.body(ast.input)
          const flowAnnotations = withoutEffects(Annotations.merge(childAnnotations, flow.annotations))
          const child = visit(
            nodeAst(body, `${id}.flow`),
            `${id}.flow`,
            flowAnnotations,
            normalizedGrant === undefined
              ? flowCapabilities
              : normalizedGrant.filter((capability) => flowCapabilities.includes(capability)),
            calleeEnvelope,
            depth + 1,
            ast.input,
            prerequisites
          )
          depend(child.id, "value")
        }
        break
      }
    }

    if (ast._tag !== "FlowCall" && envelope !== undefined && declaredEffects !== undefined) {
      const narrowed = narrowAgainst(envelope, declaredEffects)
      if (!narrowed.ok) {
        observedDiagnostics.push(new GraphBuildError({ code: narrowed.code, paths: [...narrowed.paths], nodeId: id }))
      }
    }

    const inputs: Array<KeyMaterial.InputRef> = []
    if (effectiveCallInput !== noInput) {
      inputs.push({ _tag: "Literal", value: reflection(effectiveCallInput, id) })
      const seenRefs = new Set<string>()
      for (const ref of plannedInputRefs(effectiveCallInput, id)) {
        const identity = `${ref.from}\u0000${ref.path.join("\u0000")}`
        if (seenRefs.has(identity)) continue
        seenRefs.add(identity)
        inputs.push(ref)
      }
    }
    for (const dependency of dependencies) {
      inputs.push(
        continuationDependencies.has(dependency)
          ? { _tag: "Pending", from: dependency }
          : { _tag: "Ref", from: dependency, path: [] }
      )
    }
    current.keyMaterial = {
      version: "flows/key-material/v2",
      kind: tier(identityEffects),
      body: declarationBody(ast, flow, id, ownEffects),
      inputs,
      layers: resolveLayers({
        nodeId: id,
        kind: ast._tag,
        model: ast._tag === "Dynamic" ? ast.model : undefined,
        capabilities: recordedCapabilities,
        effects: identityEffects,
        placement: projection.placement
      }),
      capabilities: recordedCapabilities,
      effects: identityEffects,
      placement: projection.placement
    }
    return { id }
  }

  if (Flow.isFlow(flowOrNode)) {
    const flow = flowOrNode as FlowDetails
    if (flow.body === undefined) {
      throw new Flow.FlowError({
        code: "missing_body",
        message: flow.name === undefined
          ? "Cannot build a flow without a body"
          : `Cannot build flow "${flow.name}" without a body`
      })
    }
    visit(
      nodeAst(flow.body(input), "root"),
      "root",
      flow.annotations,
      flow.capabilities,
      admitEffects(flow.effects, "root"),
      0,
      input
    )
  } else {
    visit(nodeAst(flowOrNode, "root"), "root", Annotations.empty, undefined, undefined)
  }

  const visitedNodeIds = new Set<string>()
  const duplicateNodeIds = new Set<string>()
  for (const node of observed) {
    if (visitedNodeIds.has(node.id) && !duplicateNodeIds.has(node.id)) {
      duplicateNodeIds.add(node.id)
      observedDiagnostics.push(new GraphBuildError({ code: "duplicate_node_id", paths: [], nodeId: node.id }))
    }
    visitedNodeIds.add(node.id)
  }

  const nodeById = new Map(observed.map((node) => [node.id, node]))
  const addDependency = (to: InternalNode, from: string, reason: EdgeReason): void => {
    /* v8 ignore next -- the conflict pass skips a pair once an edge makes one reachable from the other, so a repeat arrives only from a caller added later */
    if (to.dependencies.includes(from)) return
    to.dependencies.push(from)
    recordEdge({ from, to: to.id, reason })
    /* v8 ignore next 6 -- every visited node and every lane merge is given key material before this pass runs; the guard records the invariant instead of silently dropping the edge from identity if that ever changes */
    if (to.keyMaterial === undefined) {
      observedDiagnostics.push(
        new GraphBuildError({ code: "missing_key_material", paths: [], nodeId: to.id })
      )
      return
    }
    to.keyMaterial = {
      ...to.keyMaterial,
      inputs: [
        ...to.keyMaterial.inputs,
        { _tag: "Ref", from, path: [] }
      ]
    }
  }
  // Reachability is answered from a transitive closure over node ids, one bit
  // per id, initially computed from the structural edges. Ids are structural, so
  // every edge points at an ancestor or at a continuation visited later and
  // the id graph is acyclic: a node's closure is the union of its targets'
  // closures, taken in depth-first postorder. A conflict edge added below
  // joins its target's closure into its source's in place. That keeps every
  // later writer-pair query exact: sources are processed in preorder, so
  // ancestors affected by a new edge have already been compared. Consumers
  // need those earlier closures too, so they are recomputed before merging.
  // Two nodes that share an id share that entry.
  const idIndex = new Map<string, number>()
  for (const node of observed) {
    if (!idIndex.has(node.id)) idIndex.set(node.id, idIndex.size)
  }
  const ids = [...idIndex.keys()]
  const reachWords = Math.ceil(ids.length / 32)
  const reach = new Uint32Array(ids.length * reachWords)
  const joinClosure = (from: number, to: number): void => {
    const source = from * reachWords
    const target = to * reachWords
    for (let word = 0; word < reachWords; word++) {
      reach[source + word] = reach[source + word]! | reach[target + word]!
    }
    reach[source + (to >>> 5)] = reach[source + (to >>> 5)]! | (1 << (to & 31))
  }
  const reachable = (from: number, to: number): boolean =>
    (reach[from * reachWords + (to >>> 5)]! & (1 << (to & 31))) !== 0
  const computeClosure = (): void => {
    reach.fill(0)
    const targets = ids.map((id) => edgesFrom(id).map((edge) => idIndex.get(edge.to)!))
    const state = new Uint8Array(ids.length)
    const stack: Array<number> = []
    const cursor: Array<number> = []
    for (let start = 0; start < ids.length; start++) {
      if (state[start] !== 0) continue
      state[start] = 1
      stack.push(start)
      cursor.push(0)
      while (stack.length > 0) {
        const top = stack.length - 1
        const current = stack[top]!
        const next = cursor[top]!
        if (next < targets[current]!.length) {
          cursor[top] = next + 1
          const target = targets[current]![next]!
          if (state[target] === 0) {
            state[target] = 1
            stack.push(target)
            cursor.push(0)
          }
          continue
        }
        state[current] = 2
        for (const target of targets[current]!) joinClosure(current, target)
        stack.pop()
        cursor.pop()
      }
    }
  }

  computeClosure()

  const conflicts: Array<Conflict> = []
  const laneConflicts: Array<{
    readonly conflictIndex: number
    readonly left: InternalNode
    readonly right: InternalNode
    readonly paths: ReadonlyArray<string>
  }> = []
  const work = observed.filter(
    (node): node is InternalNode & { effectiveEffects: Effects.Declaration } =>
      workNodes.has(node) && node.effectiveEffects !== undefined
  )
  // Every pair that can overlap is found from one index of every writer's
  // write paths. Two writers naming the same string share that path's bucket,
  // and a writer's covering pattern enumerates the ranks under its prefix and
  // the writers holding them, so the work is the index plus one step per
  // (pattern, covered path, holder) triple rather than one comparison per
  // pair of writers. A pair is marked once, in a bitset row per earlier
  // writer, so the pairs are visited in the order of the plain nested loop
  // and conflict indices and edges do not move. Only a marked pair overlaps,
  // and a marked pair that is not already ordered always does, so the overlap
  // itself is computed at most once per recorded conflict.
  const writers = work.length
  const indexed = EffectIndex.indexPaths(work.map((node) => node.effectiveEffects.writes))
  const ranked = work.map((node) => EffectIndex.rankPaths(indexed, node.effectiveEffects.writes))
  const rankCount = indexed.paths.length
  // The writers holding each rank, ascending, in compressed-row form.
  const bucketStart = new Int32Array(rankCount + 1)
  for (const { ranks } of ranked) {
    for (const rank of ranks) bucketStart[rank + 1] = bucketStart[rank + 1]! + 1
  }
  for (let rank = 0; rank < rankCount; rank++) {
    bucketStart[rank + 1] = bucketStart[rank + 1]! + bucketStart[rank]!
  }
  const bucket = new Int32Array(bucketStart[rankCount]!)
  const fill = bucketStart.slice(0, rankCount)
  ranked.forEach(({ ranks }, writer) => {
    for (const rank of ranks) {
      const at = fill[rank]!
      bucket[at] = writer
      fill[rank] = at + 1
    }
  })
  const pairWords = Math.ceil(writers / 32)
  const pairs = new Uint32Array(writers * pairWords)
  const mark = (left: number, right: number): void => {
    const position = left * pairWords + (right >>> 5)
    pairs[position] = pairs[position]! | (1 << (right & 31))
  }
  for (let rank = 0; rank < rankCount; rank++) {
    const end = bucketStart[rank + 1]!
    for (let first = bucketStart[rank]!; first < end; first++) {
      for (let second = first + 1; second < end; second++) mark(bucket[first]!, bucket[second]!)
    }
  }
  ranked.forEach(({ globs }, writer) => {
    for (const glob of globs) {
      const high = indexed.high[glob]!
      for (let rank = indexed.low[glob]!; rank < high; rank++) {
        if (indexed.dotted[rank] === 1) continue
        const end = bucketStart[rank + 1]!
        for (let position = bucketStart[rank]!; position < end; position++) {
          const holder = bucket[position]!
          if (holder < writer) {
            mark(holder, writer)
          } else if (holder > writer) {
            mark(writer, holder)
          }
        }
      }
    }
  })
  for (let left = 0; left < writers; left++) {
    const a = work[left]!
    const aId = idIndex.get(a.id)!
    const row = left * pairWords
    for (let word = 0; word < pairWords; word++) {
      let bits = pairs[row + word]!
      while (bits !== 0) {
        const lowest = bits & -bits
        bits ^= lowest
        const right = word * 32 + 31 - Math.clz32(lowest)
        const b = work[right]!
        const bId = idIndex.get(b.id)!
        if (aId === bId || reachable(aId, bId) || reachable(bId, aId)) continue
        if (conflicts.length >= maximumGraphConflicts) throw planTooLarge(b.id)
        const paths = EffectIndex.overlapRanks(indexed, ranked[left]!, ranked[right]!)
          .map((rank) => indexed.paths[rank]!)
        const aEffects = a.effectiveEffects
        const bEffects = b.effectiveEffects
        const selected = strategy(aEffects, bEffects)
        conflicts.push({ nodes: [a.id, b.id], paths, strategy: selected })
        if (selected === "fail") {
          observedDiagnostics.push(
            new GraphBuildError({ code: "write_conflict", paths: [...paths], nodes: [a.id, b.id] })
          )
        }
        if (selected === "serialize") {
          addDependency(b, a.id, "conflict")
          joinClosure(aId, bId)
        }
        if (selected === "lane") {
          for (const node of [a, b]) {
            if (node.lane !== undefined) continue
            const lane = { id: `lane:${node.id}` }
            node.lane = lane
            node.annotations = { ...node.annotations, lane }
          }
          laneConflicts.push({
            conflictIndex: conflicts.length - 1,
            left: a,
            right: b,
            paths
          })
        }
      }
    }
  }

  // Plan consumers before introducing merges. Conflict edges order writers;
  // they do not mean that a writer consumes the merged output. A structural
  // consumer that still leads to either writer must also remain before the
  // merge. Recompute closure to include all serialization edges.
  if (laneConflicts.length > 0) computeClosure()
  const mergePlans = laneConflicts.map((conflict) => ({
    ...conflict,
    consumers: [
      ...new Set(
        [...edgesFrom(conflict.left.id), ...edgesFrom(conflict.right.id)]
          .sort((first, second) => first.index - second.index)
          .filter((edge) => observedEdges[edge.index]!.reason !== "conflict")
          .map((edge) => edge.to)
      )
    ].filter((id) => {
      const consumer = idIndex.get(id)!
      return [conflict.left, conflict.right].every((writer) => {
        const target = idIndex.get(writer.id)!
        return consumer !== target && !reachable(consumer, target)
      })
    })
  }))
  // Merges that share a lane apply in conflict order, before any consumer
  // dependencies are attached. This avoids treating an earlier merge as a
  // consumer of a later merge that needs the same writer.
  const lastMerge = new Map<string, string>()
  for (let index = 0; index < mergePlans.length; index++) {
    const laneConflict = mergePlans[index]!
    const mergeId = `lane.merge.${index}`
    const capabilities = [
      ...new Set([
        ...laneConflict.left.capabilities,
        ...laneConflict.right.capabilities
      ])
    ].sort()
    const mergeEffects = admitEffects(
      Effects.make({
        reads: laneConflict.paths,
        writes: laneConflict.paths,
        mode: "hermetic",
        onConflict: "serialize",
        tier: "compensable"
      }),
      mergeId
    )!
    const leftPlacement = reflection(laneConflict.left.placement, mergeId)
    const rightPlacement = reflection(laneConflict.right.placement, mergeId)
    const placement = JSON.stringify(leftPlacement) === JSON.stringify(rightPlacement)
      ? laneConflict.left.placement
      : undefined
    const mergeNode: InternalNode = {
      id: mergeId,
      kind: "LaneMerge",
      dependencies: [laneConflict.left.id, laneConflict.right.id],
      declaredEffects: mergeEffects,
      effectiveEffects: mergeEffects,
      placement,
      lane: undefined,
      priority: undefined,
      capabilities,
      annotations: {
        placement,
        effects: mergeEffects,
        lane: undefined,
        priority: undefined
      },
      keyMaterial: {
        version: "flows/key-material/v2",
        kind: "compensable",
        body: { _tag: "LaneMerge", paths: laneConflict.paths },
        inputs: [
          { _tag: "Ref", from: laneConflict.left.id, path: [] },
          { _tag: "Ref", from: laneConflict.right.id, path: [] }
        ],
        layers: resolveLayers({
          nodeId: mergeId,
          kind: "LaneMerge",
          model: undefined,
          capabilities,
          effects: mergeEffects,
          placement
        }),
        capabilities,
        effects: mergeEffects,
        placement
      }
    }
    recordNode(mergeNode)
    nodeById.set(mergeId, mergeNode)
    recordEdge({ from: laneConflict.left.id, to: mergeId, reason: "lane-merge" })
    recordEdge({ from: laneConflict.right.id, to: mergeId, reason: "lane-merge" })
    for (const writer of [laneConflict.left, laneConflict.right]) {
      const previous = lastMerge.get(writer.id)
      if (previous !== undefined) addDependency(mergeNode, previous, "lane-merge")
      lastMerge.set(writer.id, mergeId)
    }
    conflicts[laneConflict.conflictIndex] = {
      ...conflicts[laneConflict.conflictIndex]!,
      mergeNodeId: mergeId
    }
  }

  for (let index = 0; index < mergePlans.length; index++) {
    for (const consumerId of mergePlans[index]!.consumers) {
      addDependency(nodeById.get(consumerId)!, `lane.merge.${index}`, "lane-merge")
    }
  }
  const order = dependencyOrder(observed)
  if (Result.isFailure(order)) observedDiagnostics.push(order.failure)

  return freezeGraph({ nodes: observed, edges: observedEdges, diagnostics: observedDiagnostics, conflicts })
}

/**
 * Returns graph nodes in structural preorder.
 *
 * @category getters
 * @since 0.0.0
 * @slop
 */
export const nodes = (graph: Graph): ReadonlyArray<GraphNode> => impl(graph).nodes as ReadonlyArray<GraphNode>

/**
 * Returns graph dependency edges in structural preorder.
 *
 * @category getters
 * @since 0.0.0
 * @slop
 */
export const edges = (graph: Graph): ReadonlyArray<Edge> => impl(graph).edges

/**
 * Returns declared and inherited effect data for nodes that carry either.
 *
 * @category getters
 * @since 0.0.0
 * @slop
 */
export const effects = (graph: Graph): ReadonlyArray<EffectEntry> =>
  impl(graph).nodes
    .filter((node) => node.declaredEffects !== undefined || node.effectiveEffects !== undefined)
    .map((node) => ({
      nodeId: node.id,
      declared: node.declaredEffects,
      effective: node.effectiveEffects
    }))

/**
 * Returns resolved placement data in structural preorder.
 *
 * @category getters
 * @since 0.0.0
 * @slop
 */
export const placements = (graph: Graph): ReadonlyArray<PlacementEntry> =>
  impl(graph).nodes.flatMap((node) =>
    node.placement === undefined ? [] : [{ nodeId: node.id, placement: node.placement }]
  )

/**
 * Returns overlapping-write conflict data.
 *
 * @category getters
 * @since 0.0.0
 * @slop
 */
export const conflicts = (graph: Graph): ReadonlyArray<Conflict> => impl(graph).conflicts

/**
 * Returns build diagnostics without throwing.
 *
 * @category getters
 * @since 0.0.0
 * @slop
 */
export const diagnostics = (graph: Graph): ReadonlyArray<GraphBuildError> => impl(graph).diagnostics

/**
 * Returns node-associated, digest-free key material in topological dependency
 * order. The graph-local node id is outside the material that `/keys`
 * hashes.
 *
 * @category getters
 * @since 0.0.0
 * @slop
 */
export const keyMaterial = (
  graph: Graph
): Result.Result<ReadonlyArray<KeyMaterial.Entry>, GraphBuildError> => {
  const storage = impl(graph)
  for (const diagnostic of storage.diagnostics) {
    if (isFatalDiagnostic(diagnostic)) return Result.fail(diagnostic)
  }
  const order = dependencyOrder(storage.nodes)
  if (Result.isFailure(order)) return Result.fail(order.failure)
  const ordered: Array<KeyMaterial.Entry> = []
  for (const node of order.success) {
    if (node.keyMaterial === undefined) {
      return Result.fail(new GraphBuildError({ code: "missing_key_material", paths: [], nodeId: node.id }))
    }
    ordered.push({ nodeId: node.id, material: node.keyMaterial })
  }
  return Result.succeed(ordered)
}
