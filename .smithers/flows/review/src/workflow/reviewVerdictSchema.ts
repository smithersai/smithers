import * as Schema from "effect/Schema"

/**
 * What a finished review answers about the change. `pass`: the review ran
 * whole and no blocking finding stands. `fail`: a blocking finding stands.
 * `incomplete`: the review could not answer, so an outage never reads as a
 * pass or as a fault in the code.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ReviewVerdict = Schema.Literals(["pass", "fail", "incomplete"])

/**
 * A decoded verdict.
 *
 * @since 1.0.0
 * @category models
 */
export type ReviewVerdict = typeof ReviewVerdict.Type
