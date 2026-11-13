/**
 * Resume compatibility is weaker than result reuse. A callback is the same
 * callback to a resume when its source differs only in its binding names,
 * which is all a minifier changes when unrelated code in its bundle moves, and
 * its captures are equal. It still cannot earn a cache hit that way. Only the
 * interpreter's PlanRecorded guard uses this projection. Approval digests and
 * dispatch keys keep the original entropy-bearing material.
 *
 * @since 1.0.0
 * @internal
 */

import { isRecord } from "@smthrs/canonical"
import type { Plan } from "@smthrs/plan"
import * as Graph from "../Graph.ts"

/**
 * An identity a resume can compare is projected to its resume digest. One
 * without, such as a bound function's, keeps its whole identity, entropy
 * included, and fails closed.
 */
const callback = (value: unknown): unknown =>
  isRecord(value) && value._tag === "FunctionIdentity" && typeof value.resumeDigest === "string"
    ? { _tag: value._tag, algorithm: value.algorithm, digest: value.resumeDigest }
    : value

/**
 * Project only callback slots, never identity-shaped application data. `Graph`
 * records every node's body as an object tagged with its node kind.
 */
const body = (value: Readonly<Record<string, unknown>>): unknown => {
  switch (value._tag) {
    case "FlowCall":
      return isRecord(value.declaration)
        ? { ...value, declaration: { ...value.declaration, body: callback(value.declaration.body) } }
        : value
    case "Map":
      return { ...value, mapper: callback(value.mapper) }
    case "AndThen":
      return { ...value, continuation: callback(value.continuation) }
    case "Branch":
      return { ...value, predicate: callback(value.predicate) }
    case "Catch":
      return { ...value, filterIdentity: callback(value.filterIdentity) }
    default:
      return value
  }
}

/**
 * The same drafts, with only callback identities made restart-comparable.
 *
 * @since 1.0.0
 * @private
 */
export const recordedPlanDrafts = (graph: Graph.Graph): ReadonlyArray<Plan.NodeDraft> =>
  Graph.drafts(graph).map((draft) => ({
    ...draft,
    material: { ...draft.material, body: body(draft.material.body as Readonly<Record<string, unknown>>) }
  }))
