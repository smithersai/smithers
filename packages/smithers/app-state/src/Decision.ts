/**
 * Pure command decision result shared by plan-tree and chat reducers.
 *
 * @since 1.0.0
 */

/**
 * The result of `decide`: the events a command produces, or the reason it is refused.
 * Mirrors `SmithersState.Decision` in `lean/smithers-state/SmithersState/Basic.lean`.
 *
 * @since 1.0.0
 * @category models
 */
export type Decision<E, R> =
  | { readonly _tag: "Accepted"; readonly events: ReadonlyArray<E> }
  | { readonly _tag: "Refused"; readonly reason: R }

/**
 * Pure state-machine helper `accepted` (accepted).
 *
 * @since 1.0.0
 * @category utilities
 */
export const accepted = <E>(events: ReadonlyArray<E>): Decision<E, never> => ({ _tag: "Accepted", events })

/**
 * Pure state-machine helper `refused` (refused).
 *
 * @since 1.0.0
 * @category utilities
 */
export const refused = <R>(reason: R): Decision<never, R> => ({ _tag: "Refused", reason })
