/**
 * A plan comparison, as a value.
 *
 * A plan diff answers "which steps changed key (and _which input_
 * changed them), what entered the envelope, what joined the release set —
 * 'what is different about this run' is a set comparison, not archaeology."
 * This module is the set comparison.
 *
 * The **verdict** is the key: two nodes with the same key are the same step,
 * under the same id or a moved one, and nothing else needs saying. The
 * **attribution** — `changed: ["input[1]"]` — is a report for a human, derived
 * by comparing the declarations field by field. It is deliberately not part of any digest.
 *
 * @since 0.1.0
 */

import { jsonMirror } from "./internal/JsonMirror.ts"
import type * as Plan from "./Plan.vibe"
import type * as Planned from "./Planned.vibe"

/**
 * A node whose key moved, with the fields that moved it.
 *
 * @since 0.1.0
 * @category models
 */
export interface Rekeyed {
  /** The node's id in the newer plan. */
  readonly id: string
  /** The step key the paired node carried in the older plan. */
  readonly from: string
  /** The step key the node carries in the newer plan. */
  readonly to: string
  /**
   * Field labels such as `"kind"`, `"body"`, `"layers"`, `"capabilities"`,
   * `"effects"`, and `"input[0]"` whose declaration differs. `"kind"` is the
   * effect tier (`sealed`, `compensable`, or `irreversible`). A
   * `Pending`-referenced upstream re-key is attributed to that input position
   * too. `changed` is empty only when none of the compared fields moved.
   */
  readonly changed: ReadonlyArray<string>
}

/**
 * What changed between two plans of the same flow.
 *
 * @since 0.1.0
 * @category models
 */
export interface PlanDiff {
  /** Ids, in the newer plan, of nodes with no counterpart in the older plan. */
  readonly added: ReadonlyArray<string>
  /** Ids, in the older plan, of nodes with no counterpart in the newer plan. */
  readonly removed: ReadonlyArray<string>
  /** Nodes paired by id whose step key changed, with the fields that changed it. */
  readonly rekeyed: ReadonlyArray<Rekeyed>
  /** Ids, in the newer plan, of nodes whose step key is unchanged, including nodes whose id moved. */
  readonly unchanged: ReadonlyArray<string>
}

/**
 * Order-insensitive structural comparison for the attribution report only.
 * Digests go through RFC 8785 canonical JSON; this does not have to, and
 * saying so keeps the two from being confused.
 *
 * @private
 */
const stable = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined"
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : 1)
  return `{${entries.map(([name, entry]) => `${JSON.stringify(name)}:${stable(entry)}`).join(",")}}`
}

/**
 * A planned value compares as the reference an AST stores for it, so the same
 * reference at the same place is unchanged.
 *
 * @private
 */
const plannedReference = (_value: unknown, reference: Planned.Reference) => ({
  _tag: "PlannedReference",
  node: reference.node,
  path: reference.path
})

/** @private */
type ComparisonToken = string | symbol

/**
 * Projects compared fields through the key's JSON semantics. A refused value
 * receives an identity token scoped to its node and field, so the same value
 * remains equal to itself without equating two distinct refused values.
 *
 * @private
 */
const fieldComparison = () => {
  const refused = new Map<unknown, Map<string, symbol>>()
  const token = (input: unknown, nodeId: string, field: string): ComparisonToken => {
    try {
      return stable(jsonMirror(input, plannedReference))
    } catch {
      const address = JSON.stringify([nodeId, field])
      let fields = refused.get(input)
      if (fields === undefined) {
        fields = new Map()
        refused.set(input, fields)
      }
      let sentinel = fields.get(address)
      if (sentinel === undefined) {
        sentinel = Symbol(address)
        fields.set(address, sentinel)
      }
      return sentinel
    }
  }
  return (previous: unknown, next: unknown, nodeId: string, field: string): boolean =>
    token(previous, nodeId, field) === token(next, nodeId, field)
}

/** @private */
const changedFields = (
  previous: Plan.PlanNode,
  next: Plan.PlanNode,
  rekeyedDependencies: ReadonlySet<string>,
  sameField: ReturnType<typeof fieldComparison>
): ReadonlyArray<string> => {
  const changed: Array<string> = []
  // StepKey.materialBody is the identity list this attribution must mirror.
  // Inputs, layers, and capabilities complete fromKeyMaterial's hashed value,
  // and material.kind selects the key namespace (content versus tier-bearing
  // plan declaration), so a tier-only move still re-keys and is blamed here.
  if (!sameField(previous.material.version, next.material.version, next.id, "version")) changed.push("version")
  if (previous.material.kind !== next.material.kind) changed.push("kind")
  if (!sameField(previous.material.body, next.material.body, next.id, "body")) changed.push("body")
  if (!sameField(previous.material.nondeterministic, next.material.nondeterministic, next.id, "nondeterministic")) {
    changed.push("nondeterministic")
  }
  if (!sameField(previous.material.effects, next.material.effects, next.id, "effects")) changed.push("effects")
  if (!sameField(previous.material.placement, next.material.placement, next.id, "placement")) {
    changed.push("placement")
  }
  const width = Math.max(previous.material.inputs.length, next.material.inputs.length)
  for (let index = 0; index < width; index++) {
    const before = previous.material.inputs[index]
    const after = next.material.inputs[index]
    const field = `input[${index}]`
    if (before === undefined || after === undefined || !sameField(before, after, next.id, field)) {
      changed.push(field)
      continue
    }
    if (after._tag !== "Literal" && rekeyedDependencies.has(after.from)) changed.push(field)
  }
  if (!sameField(previous.material.layers, next.material.layers, next.id, "layers")) changed.push("layers")
  if (!sameField(previous.material.capabilities, next.material.capabilities, next.id, "capabilities")) {
    changed.push("capabilities")
  }
  return changed
}

/**
 * Compares a plan against the last plan for the same flow.
 *
 * Nodes pair in three passes, each over the nodes no earlier pass paired:
 * the same id with the same key, then the same key under any id, then the
 * same id with a different key. The second pass exists because flow node ids
 * can be positional: inserting a step shifts the ids after it while their
 * keys stay equal, and that is one added step, not a re-key of every later
 * one (#3905).
 *
 * `added`, `rekeyed`, and `unchanged` name nodes by their id in `next`;
 * `removed` names nodes by their id in `previous`. A moved id can therefore
 * appear once in `removed` or `added` and once in `unchanged`.
 *
 * @param previous - The last plan recorded for the flow.
 * @param next - The plan to compare against it.
 * @returns The added, removed, re-keyed, and unchanged node ids, each in its
 * plan's node order.
 * @since 0.1.0
 * @category constructors
 */
export const diff = (previous: Plan.Plan, next: Plan.Plan): PlanDiff => {
  // pairs maps a next node to the previous node it is the same step as.
  const pairs = new Map<Plan.PlanNode, Plan.PlanNode>()
  const paired = new Set<Plan.PlanNode>()
  const pair = (node: Plan.PlanNode, original: Plan.PlanNode) => {
    pairs.set(node, original)
    paired.add(original)
  }
  const before = new Map(previous.nodes.map((node) => [node.id, node]))
  for (const node of next.nodes) {
    const original = before.get(node.id)
    if (original !== undefined && original.key === node.key) pair(node, original)
  }
  const byKey = new Map<string, Array<Plan.PlanNode>>()
  for (const node of previous.nodes) {
    if (paired.has(node)) continue
    const same = byKey.get(node.key)
    if (same === undefined) byKey.set(node.key, [node])
    else same.push(node)
  }
  for (const node of next.nodes) {
    if (pairs.has(node)) continue
    const original = byKey.get(node.key)?.shift()
    if (original !== undefined) pair(node, original)
  }
  // Attribution follows a reference's id, independently of identity pairing:
  // two upstream nodes can exchange keys and pair as unchanged moved steps.
  const rekeyedIds = new Set(next.nodes.filter((node) => before.get(node.id)?.key !== node.key).map((node) => node.id))
  for (const node of next.nodes) {
    if (pairs.has(node)) continue
    const original = before.get(node.id)
    if (original !== undefined && !paired.has(original)) {
      pair(node, original)
    }
  }
  const added: Array<string> = []
  const rekeyed: Array<Rekeyed> = []
  const unchanged: Array<string> = []
  const sameField = fieldComparison()
  for (const node of next.nodes) {
    const original = pairs.get(node)
    if (original === undefined) {
      added.push(node.id)
      continue
    }
    if (original.key === node.key) {
      unchanged.push(node.id)
      continue
    }
    rekeyed.push({
      id: node.id,
      from: original.key,
      to: node.key,
      changed: changedFields(original, node, rekeyedIds, sameField)
    })
  }
  return {
    added,
    removed: previous.nodes.filter((node) => !paired.has(node)).map((node) => node.id),
    rekeyed,
    unchanged
  }
}
