/**
 * Plan tree: commands, events, `decidePlan`, `evolvePlan`.
 *
 * Mirrors `lean/smithers-state/SmithersState/PlanTree.lean` definition for
 * definition. Lean proves that every admitted event keeps the tree well formed:
 * each parent pointer names an existing node and no node is its own ancestor
 * (`plan_tree_acyclic`, `decide_preserves_wf`).
 *
 * @since 1.0.0
 */

import * as Schema from "effect/Schema"
import { accepted, type Decision, refused } from "./Decision.ts"

/**
 * Schema or value export `PlanNodeStatus` (plan node status).
 *
 * @since 1.0.0
 * @category schemas
 */
export const PlanNodeStatus = Schema.Literals(["pending", "in_progress", "blocked_on_will", "done", "failed"])
/**
 * Type definition for `PlanNodeStatus` (plan node status).
 *
 * @since 1.0.0
 * @category models
 */
export type PlanNodeStatus = typeof PlanNodeStatus.Type

/**
 * Schema or value export `Milestone` (milestone).
 *
 * @since 1.0.0
 * @category schemas
 */
export const Milestone = Schema.Literals(["M0", "M1", "M2", "M3"])
/**
 * Type definition for `Milestone` (milestone).
 *
 * @since 1.0.0
 * @category models
 */
export type Milestone = typeof Milestone.Type

/**
 * Sibling order. Lean models it as `Nat`, so the wire refuses negatives and
 * fractions instead of admitting a value the proofs never covered.
 *
 * @since 1.0.0
 * @category schemas
 */
export const PlanOrder = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * Schema or value export `Assumption` (assumption).
 *
 * @since 1.0.0
 * @category schemas
 */
export const Assumption = Schema.Struct({ text: Schema.String, verified: Schema.Boolean })
/**
 * Type definition for `Assumption` (assumption).
 *
 * @since 1.0.0
 * @category models
 */
export type Assumption = typeof Assumption.Type

/**
 * One stored node. `children` is derived (see `childrenOf`), never stored.
 *
 * @since 1.0.0
 * @category schemas
 */
export const PlanNodeState = Schema.Struct({
  id: Schema.String,
  parent: Schema.NullOr(Schema.String),
  title: Schema.String,
  milestone: Milestone,
  status: PlanNodeStatus,
  sources: Schema.Array(Schema.String),
  assumptions: Schema.Array(Assumption),
  dodFast: Schema.String,
  artifactIds: Schema.Array(Schema.String),
  order: PlanOrder
})
/**
 * Type definition for `PlanNodeState` (plan node state).
 *
 * @since 1.0.0
 * @category models
 */
export type PlanNodeState = typeof PlanNodeState.Type

/**
 * Schema or value export `PlanTree` (plan tree).
 *
 * @since 1.0.0
 * @category schemas
 */
export const PlanTree = Schema.Struct({
  revision: Schema.Int,
  nodes: Schema.Record(Schema.String, PlanNodeState)
})
/**
 * Type definition for `PlanTree` (plan tree).
 *
 * @since 1.0.0
 * @category models
 */
export type PlanTree = typeof PlanTree.Type

/**
 * Initial state value `emptyPlanTree` (empty plan tree).
 *
 * @since 1.0.0
 * @category constants
 */
export const emptyPlanTree: PlanTree = { revision: 0, nodes: {} }

const ExpectedRevision = Schema.NullOr(Schema.Int)

/**
 * Schema or value export `UpsertPlanNode` (upsert plan node).
 *
 * @since 1.0.0
 * @category schemas
 */
export const UpsertPlanNode = Schema.TaggedStruct("UpsertPlanNode", {
  id: Schema.String,
  parent: Schema.NullOr(Schema.String),
  title: Schema.String,
  milestone: Milestone,
  sources: Schema.Array(Schema.String),
  assumptions: Schema.Array(Schema.String),
  dodFast: Schema.String,
  order: PlanOrder,
  expectedRevision: ExpectedRevision
})
/**
 * Schema or value export `MovePlanNode` (move plan node).
 *
 * @since 1.0.0
 * @category schemas
 */
export const MovePlanNode = Schema.TaggedStruct("MovePlanNode", {
  id: Schema.String,
  newParent: Schema.NullOr(Schema.String),
  order: PlanOrder,
  expectedRevision: ExpectedRevision
})
/**
 * Schema or value export `ToggleAssumption` (toggle assumption).
 *
 * @since 1.0.0
 * @category schemas
 */
export const ToggleAssumption = Schema.TaggedStruct("ToggleAssumption", {
  nodeId: Schema.String,
  index: Schema.Int,
  expectedRevision: ExpectedRevision
})
/**
 * Schema or value export `SetNodeStatus` (set node status).
 *
 * @since 1.0.0
 * @category schemas
 */
export const SetNodeStatus = Schema.TaggedStruct("SetNodeStatus", {
  nodeId: Schema.String,
  status: PlanNodeStatus,
  expectedRevision: ExpectedRevision
})
/**
 * Schema or value export `AttachArtifact` (attach artifact).
 *
 * @since 1.0.0
 * @category schemas
 */
export const AttachArtifact = Schema.TaggedStruct("AttachArtifact", {
  nodeId: Schema.String,
  artifactId: Schema.String,
  expectedRevision: ExpectedRevision
})
/**
 * Schema or value export `PlanCommand` (plan command).
 *
 * @since 1.0.0
 * @category schemas
 */
export const PlanCommand = Schema.Union([
  UpsertPlanNode,
  MovePlanNode,
  ToggleAssumption,
  SetNodeStatus,
  AttachArtifact
])
/**
 * Type definition for `PlanCommand` (plan command).
 *
 * @since 1.0.0
 * @category models
 */
export type PlanCommand = typeof PlanCommand.Type

/**
 * Schema or value export `PlanNodeCreated` (plan node created).
 *
 * @since 1.0.0
 * @category schemas
 */
export const PlanNodeCreated = Schema.TaggedStruct("PlanNodeCreated", {
  id: Schema.String,
  parent: Schema.NullOr(Schema.String),
  title: Schema.String,
  milestone: Milestone,
  sources: Schema.Array(Schema.String),
  assumptions: Schema.Array(Schema.String),
  dodFast: Schema.String,
  order: PlanOrder
})
/**
 * Schema or value export `PlanNodeUpdated` (plan node updated).
 *
 * @since 1.0.0
 * @category schemas
 */
export const PlanNodeUpdated = Schema.TaggedStruct("PlanNodeUpdated", {
  id: Schema.String,
  title: Schema.String,
  milestone: Milestone,
  sources: Schema.Array(Schema.String),
  assumptions: Schema.Array(Schema.String),
  dodFast: Schema.String
})
/**
 * Schema or value export `PlanNodeMoved` (plan node moved).
 *
 * @since 1.0.0
 * @category schemas
 */
export const PlanNodeMoved = Schema.TaggedStruct("PlanNodeMoved", {
  id: Schema.String,
  parent: Schema.NullOr(Schema.String),
  order: PlanOrder
})
/**
 * Schema or value export `AssumptionToggled` (assumption toggled).
 *
 * @since 1.0.0
 * @category schemas
 */
export const AssumptionToggled = Schema.TaggedStruct("AssumptionToggled", {
  id: Schema.String,
  index: Schema.Int
})
/**
 * Schema or value export `NodeStatusSet` (node status set).
 *
 * @since 1.0.0
 * @category schemas
 */
export const NodeStatusSet = Schema.TaggedStruct("NodeStatusSet", {
  id: Schema.String,
  status: PlanNodeStatus
})
/**
 * Schema or value export `ArtifactAttached` (artifact attached).
 *
 * @since 1.0.0
 * @category schemas
 */
export const ArtifactAttached = Schema.TaggedStruct("ArtifactAttached", {
  id: Schema.String,
  artifactId: Schema.String
})
/**
 * Schema or value export `PlanEvent` (plan event).
 *
 * @since 1.0.0
 * @category schemas
 */
export const PlanEvent = Schema.Union([
  PlanNodeCreated,
  PlanNodeUpdated,
  PlanNodeMoved,
  AssumptionToggled,
  NodeStatusSet,
  ArtifactAttached
])
/**
 * Type definition for `PlanEvent` (plan event).
 *
 * @since 1.0.0
 * @category models
 */
export type PlanEvent = typeof PlanEvent.Type

/**
 * Type definition for `PlanRefusal` (plan refusal).
 *
 * @since 1.0.0
 * @category models
 */
export type PlanRefusal =
  | "revision_mismatch"
  | "parent_mismatch"
  | "parent_missing"
  | "node_missing"
  | "cycle"
  | "unrooted"
  | "assumption_missing"

/**
 * Pure state-machine helper `findNode` (find node).
 *
 * @since 1.0.0
 * @category utilities
 */
export const findNode = (tree: PlanTree, id: string): PlanNodeState | undefined =>
  Object.hasOwn(tree.nodes, id) ? tree.nodes[id] : undefined

/**
 * Walk parent pointers from `start` for at most `fuel` steps.
 * `true`: met `target`. `false`: reached a root without meeting it.
 * `null`: out of fuel or a dangling pointer.
 *
 * @since 1.0.0
 * @category utilities
 */
export const walk = (tree: PlanTree, target: string, fuel: number, start: string): boolean | null => {
  let current = start
  let remaining = fuel
  while (remaining > 0) {
    if (current === target) return true
    const node = findNode(tree, current)
    if (node === undefined) return null
    if (node.parent === null) return false
    current = node.parent
    remaining--
  }
  return null
}

const revisionOk = (tree: PlanTree, expected: number | null): boolean => expected === null || expected === tree.revision

/**
 * Pure state-machine helper `decidePlan` (decide plan).
 *
 * @since 1.0.0
 * @category utilities
 */
export const decidePlan = (tree: PlanTree, command: PlanCommand): Decision<PlanEvent, PlanRefusal> => {
  if (!revisionOk(tree, command.expectedRevision)) return refused("revision_mismatch")
  switch (command._tag) {
    case "UpsertPlanNode": {
      const existing = findNode(tree, command.id)
      if (existing !== undefined) {
        if (existing.parent !== command.parent) return refused("parent_mismatch")
        return accepted([{
          _tag: "PlanNodeUpdated",
          id: command.id,
          title: command.title,
          milestone: command.milestone,
          sources: [...command.sources],
          assumptions: [...command.assumptions],
          dodFast: command.dodFast
        }])
      }
      if (command.parent !== null && findNode(tree, command.parent) === undefined) {
        return refused("parent_missing")
      }
      return accepted([{
        _tag: "PlanNodeCreated",
        id: command.id,
        parent: command.parent,
        title: command.title,
        milestone: command.milestone,
        sources: [...command.sources],
        assumptions: [...command.assumptions],
        dodFast: command.dodFast,
        order: command.order
      }])
    }
    case "MovePlanNode": {
      if (findNode(tree, command.id) === undefined) return refused("node_missing")
      if (command.newParent !== null) {
        if (findNode(tree, command.newParent) === undefined) return refused("parent_missing")
        const met = walk(tree, command.id, Object.keys(tree.nodes).length + 1, command.newParent)
        if (met === true) return refused("cycle")
        if (met === null) return refused("unrooted")
      }
      return accepted([{ _tag: "PlanNodeMoved", id: command.id, parent: command.newParent, order: command.order }])
    }
    case "ToggleAssumption": {
      const node = findNode(tree, command.nodeId)
      if (node === undefined) return refused("node_missing")
      if (!(command.index >= 0 && command.index < node.assumptions.length)) return refused("assumption_missing")
      return accepted([{ _tag: "AssumptionToggled", id: command.nodeId, index: command.index }])
    }
    case "SetNodeStatus": {
      if (findNode(tree, command.nodeId) === undefined) return refused("node_missing")
      return accepted([{ _tag: "NodeStatusSet", id: command.nodeId, status: command.status }])
    }
    case "AttachArtifact": {
      const node = findNode(tree, command.nodeId)
      if (node === undefined) return refused("node_missing")
      if (node.artifactIds.includes(command.artifactId)) return accepted([])
      return accepted([{ _tag: "ArtifactAttached", id: command.nodeId, artifactId: command.artifactId }])
    }
  }
}

const updateNode = (tree: PlanTree, id: string, f: (node: PlanNodeState) => PlanNodeState): PlanTree => {
  const node = findNode(tree, id)
  return {
    revision: tree.revision + 1,
    nodes: node === undefined ? tree.nodes : { ...tree.nodes, [id]: f(node) }
  }
}

/** Keep a verified flag only while the assumption text at that index is unchanged. */
const mergeAssumptions = (
  old: ReadonlyArray<Assumption>,
  texts: ReadonlyArray<string>
): ReadonlyArray<Assumption> =>
  texts.map((text, index) => {
    const previous = old[index]
    return { text, verified: previous !== undefined && previous.verified && previous.text === text }
  })

/**
 * Every plan event bumps `revision` by one.
 *
 * @since 1.0.0
 * @category utilities
 */
export const evolvePlan = (tree: PlanTree, event: PlanEvent): PlanTree => {
  switch (event._tag) {
    case "PlanNodeCreated":
      return {
        revision: tree.revision + 1,
        nodes: {
          ...tree.nodes,
          [event.id]: {
            id: event.id,
            parent: event.parent,
            title: event.title,
            milestone: event.milestone,
            status: "pending",
            sources: event.sources,
            assumptions: event.assumptions.map((text) => ({ text, verified: false })),
            dodFast: event.dodFast,
            artifactIds: [],
            order: event.order
          }
        }
      }
    case "PlanNodeUpdated":
      return updateNode(tree, event.id, (node) => ({
        ...node,
        title: event.title,
        milestone: event.milestone,
        sources: event.sources,
        assumptions: mergeAssumptions(node.assumptions, event.assumptions),
        dodFast: event.dodFast
      }))
    case "PlanNodeMoved":
      return updateNode(tree, event.id, (node) => ({ ...node, parent: event.parent, order: event.order }))
    case "AssumptionToggled":
      return updateNode(tree, event.id, (node) => ({
        ...node,
        assumptions: node.assumptions.map((assumption, index) =>
          index === event.index ? { text: assumption.text, verified: !assumption.verified } : assumption
        )
      }))
    case "NodeStatusSet":
      return updateNode(tree, event.id, (node) => ({ ...node, status: event.status }))
    case "ArtifactAttached":
      return updateNode(tree, event.id, (node) => ({
        ...node,
        artifactIds: [...node.artifactIds, event.artifactId]
      }))
  }
}

/**
 * Deterministic sibling order: ascending `order`, ties broken by `id` in UTF-16
 * code unit order. Independent of insertion order and of object key order.
 *
 * @since 1.0.0
 * @category utilities
 */
export const childrenOf = (tree: PlanTree, parent: string | null): ReadonlyArray<string> =>
  Object.keys(tree.nodes)
    .map((id) => tree.nodes[id]!)
    .filter((node) => node.parent === parent)
    .sort((a, b) => (a.order !== b.order ? a.order - b.order : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((node) => node.id)

/**
 * The node shape of the shared Wave 1 contract (`PlanNode` in `core-contracts.ts`).
 *
 * @since 1.0.0
 * @category models
 */
export interface PlanNodeView {
  readonly id: string
  readonly title: string
  readonly parent: string | null
  readonly children: ReadonlyArray<string>
  readonly milestone: Milestone
  readonly status: PlanNodeStatus
  readonly sources: ReadonlyArray<string>
  readonly assumptions: ReadonlyArray<Assumption>
  readonly dodCommands: { readonly fast: string }
  readonly artifactIds: ReadonlyArray<string>
}

/**
 * Project the tree to contract-shaped nodes, sorted by id, with derived `children`.
 *
 * @since 1.0.0
 * @category utilities
 */
export const toPlanNodes = (tree: PlanTree): ReadonlyArray<PlanNodeView> =>
  Object.keys(tree.nodes).sort().map((id) => {
    const node = tree.nodes[id]!
    return {
      id: node.id,
      title: node.title,
      parent: node.parent,
      children: childrenOf(tree, node.id),
      milestone: node.milestone,
      status: node.status,
      sources: node.sources,
      assumptions: node.assumptions,
      dodCommands: { fast: node.dodFast },
      artifactIds: node.artifactIds
    }
  })
