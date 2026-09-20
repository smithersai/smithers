/**
 * Pure effect declarations used to describe flow read and write envelopes.
 *
 * The model itself lives in `@smthrs/plan` (`@smthrs/plan/Effects`), the lowest
 * package both this one and the library that executes a flow depend on. This
 * module is the re-export `@smthrs/core` consumers reach it through and carries
 * no logic of its own: one declaration shape, one narrowing rule, one overlap
 * rule, whichever package asks.
 *
 * Governing contract: `packages/smithers/flows/core/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/core.
 *
 * @since 0.0.0
 */

/**
 * The declaration model and the result of checking one against an envelope.
 *
 * @category models
 * @since 0.0.0
 */
export type { Declaration, MakeOptions, NarrowResult } from "@smthrs/plan/Effects"

/**
 * The declaration API: construct, test coverage, narrow, overlap, seal.
 *
 * @category constructors
 * @since 0.0.0
 */
export { covers, make, narrow, overlaps, sealed } from "@smthrs/plan/Effects"
