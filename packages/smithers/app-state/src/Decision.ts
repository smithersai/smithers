/**
 * The result of `decide`: the events a command produces, or the reason it is refused.
 * Mirrors `SmithersState.Decision` in `lean/smithers-state/SmithersState/Basic.lean`.
 */
export type Decision<E, R> =
  | { readonly _tag: "Accepted"; readonly events: ReadonlyArray<E> }
  | { readonly _tag: "Refused"; readonly reason: R }

export const accepted = <E>(events: ReadonlyArray<E>): Decision<E, never> => ({ _tag: "Accepted", events })

export const refused = <R>(reason: R): Decision<never, R> => ({ _tag: "Refused", reason })
