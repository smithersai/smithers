/**
 * The two markers that let `Flow.isOutcome` tell an authored `done`/`to`/`park`
 * from ordinary data. `Flow/Outcome.ts` stamps the node marker, `Graph.build`
 * and the interpreter stamp the value marker, and `isOutcome` reads it.
 *
 * @since 0.1.0
 */

/** Stamped on the AST of a node built by `done`/`to`/`park`.
 * @private
 * @since 0.1.0
 */
export const OutcomeNodeTypeId: unique symbol = Symbol.for("@smthrs/flow/Flow/OutcomeNode")

/** Stamped on a resolved outcome value.
 * @private
 * @since 0.1.0
 */
export const OutcomeValueTypeId: unique symbol = Symbol.for("@smthrs/flow/Flow/OutcomeValue")
