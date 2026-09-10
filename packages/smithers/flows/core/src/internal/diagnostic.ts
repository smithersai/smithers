/**
 * The diagnostic a graph build records or throws.
 *
 * One code union, one tagged error, and one fatality predicate, shared by the
 * modules that refuse a plan: the graph builder, the effect-path bounds, and
 * the plan-value reflection that projects identity. `Graph` re-exports all
 * three as its public surface.
 *
 * Governing contract: `packages/smithers/flows/core/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/core.
 *
 * @since 0.0.0
 */
import { Schema } from "effect"

/**
 * Stable code emitted by graph-build diagnostics.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export const GraphBuildErrorCode = Schema.Literals([
  "effect_outside_envelope",
  "effect_mode_widening",
  "effect_tier_widening",
  "missing_key_material",
  "write_conflict",
  "capability_outside_grant",
  "duplicate_node_id",
  "dependency_cycle",
  "plan_too_deep",
  "plan_too_large",
  "payload_too_deep",
  "payload_too_large",
  "invalid_node"
])

/**
 * Stable code emitted by graph-build diagnostics.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export type GraphBuildErrorCode = typeof GraphBuildErrorCode.Type

/**
 * A graph-build diagnostic. Declaration diagnostics are recorded so the graph
 * remains inspectable; malformed nodes and limit failures throw during
 * construction. Fatal diagnostics block {@link keyMaterial}, while
 * `capability_outside_grant` is advisory.
 *
 * `nodeId` is populated for the three effect-envelope codes,
 * `missing_key_material`, `duplicate_node_id`, `dependency_cycle`, `plan_too_deep`,
 * `plan_too_large`, `payload_too_deep`, `payload_too_large`,
 * `capability_outside_grant`, and `invalid_node`. For `plan_too_large` it
 * names the node whose admission crossed the limit: the node itself, the
 * target of the edge, the second writer of the conflict, or the node whose
 * effect declaration listed too many paths, too many patterns, or an
 * over-long path. `nodes` is populated for `write_conflict`. `paths` carries
 * the offending value path for `payload_too_large`.
 *
 * @category errors
 * @since 0.0.0
 * @slop
 */
export class GraphBuildError extends Schema.TaggedError<GraphBuildError>()("flows/core/GraphBuildError", {
  code: GraphBuildErrorCode,
  paths: Schema.Array(Schema.String),
  nodeId: Schema.optional(Schema.String),
  nodes: Schema.optional(Schema.Tuple([Schema.String, Schema.String]))
}) {}

const fatalGraphBuildErrorCodes: ReadonlySet<GraphBuildErrorCode> = Object.freeze(
  new Set<GraphBuildErrorCode>([
    "effect_outside_envelope",
    "effect_mode_widening",
    "effect_tier_widening",
    "write_conflict",
    "missing_key_material",
    "duplicate_node_id",
    "dependency_cycle",
    "plan_too_deep",
    "plan_too_large",
    "payload_too_deep",
    "payload_too_large",
    "invalid_node"
  ])
)

/**
 * Reports whether a diagnostic blocks {@link keyMaterial}.
 *
 * A fatal diagnostic means the graph describes something the package cannot
 * turn into a step key. Every other code is advisory: it reports a narrowing a
 * reader should know about, and the graph still compiles. `invalid_node`,
 * `plan_too_deep`, `plan_too_large`, `payload_too_deep`, and
 * `payload_too_large` are thrown by {@link build} rather than recorded, so
 * they never reach this predicate in practice; they are listed as fatal so a
 * future caller that records one cannot compile it.
 *
 * @category predicates
 * @since 0.1.0
 * @slop
 */
export const isFatalDiagnostic = (diagnostic: GraphBuildError): boolean =>
  fatalGraphBuildErrorCodes.has(diagnostic.code)
