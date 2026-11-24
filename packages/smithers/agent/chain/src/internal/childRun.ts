/**
 * Internal run role, independent of the journal scope's spelling.
 *
 * @since 0.1.0
 */

import type * as Authorize from "../Authorize.ts"

/**
 * What a root run shares with every chain it spawns: the authorization seam
 * the root runs under, and the one call budget the whole tree spends from.
 * `spent` counts the live calls the tree has admitted; it starts at the
 * count of settled calls the journal already holds for the tree, so a
 * resumed tree cannot spend its budget twice.
 *
 * @private
 * @since 0.1.0
 */
export interface Tree {
  readonly authorize: Authorize.Service
  readonly fuel: { spent: number; readonly max: number }
}

/**
 * Marks a derived child invocation without exposing a host-facing option.
 * A chain sets it on every call slot it issues, and `SubChains` hands the
 * same value to the child run, so a child is gated by its root's seam and
 * spends its root's budget.
 *
 * @private
 * @since 0.1.0
 */
export const childRun: unique symbol = Symbol("/chain/childRun")
