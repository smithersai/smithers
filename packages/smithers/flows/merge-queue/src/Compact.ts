/**
 * What the queue keeps of its state between rounds.
 *
 * The kernel's state never forgets: every change ever enqueued and every
 * landing stay in it, which is what the invariants are proved about. A queue
 * that runs for months cannot carry all of that from round to round. What it
 * carries is `pruned(state)`: the changes that have not ended and no landings.
 * How each change ended goes to the record of endings instead (`Endings`).
 *
 * Nothing the queue decides reads an ended change or a landing, so the queue
 * that keeps the pruned state decides exactly what the queue that keeps
 * everything decides. One rule makes that true: **a change id is never used
 * again.** The kernel refuses an `enqueue` or a `foreign` commit for an id it
 * holds, and it no longer holds the id of a change that ended, so whoever hands
 * changes in must not hand in an ended id (`fresh`). `FileInbox` enforces the
 * rule for letters, and `JjRepository` numbers foreign commits from a counter.
 *
 * The target's tree only grows, so the state would still grow by one part per
 * landed change. The parts every run was built on (`settled`) are behind the
 * queue for good, and `cut` drops them from the target's tree and from every
 * run's base. A driver that cuts tells the target to move its starting commit
 * forward by the same parts, so the trees both speak of stay the same trees.
 *
 * Mirrors `lean/MergeQueue/Compact.lean` and `lean/MergeQueue/Settle.lean`,
 * which prove the claims (`pruned_plan`, `pruned_step`, `pruned_round`;
 * `cut_plan`, `cut_step`, `kept_round`, `settled_onPrefix`).
 *
 * @since 0.1.0
 */

import type { Config, Event, State } from "./Basic.ts"
import { isTerminal } from "./Basic.ts"
import { plan } from "./Policy.ts"
import { step } from "./Step.ts"

/**
 * The state without the changes that have ended and without the landings.
 *
 * @category transitions
 * @since 0.1.0
 */
export const pruned = (state: State): State => ({
  ...state,
  changes: state.changes.filter((change) => !isTerminal(change.status)),
  landed: []
})

/**
 * Whether an event keeps the rule that a change id is never used again: it
 * does not hand in, as a new change or as a foreign commit, the id of a change
 * that has ended.
 *
 * @category predicates
 * @since 0.1.0
 */
export const fresh = (state: State, event: Event): boolean =>
  (event._tag !== "enqueue" && event._tag !== "foreign")
  || !state.changes.some((change) => change.id === event.id && isTerminal(change.status))

/**
 * Sees one event applied to a pruned state, before the result is pruned:
 * `after` still holds the changes the event ended and the landing it made.
 *
 * @category models
 * @since 0.1.0
 */
export type Dropped = (before: State, after: State) => void

/**
 * The queue that keeps only the pruned state: applies each event, then
 * prunes. `dropped` sees every step before its pruning, which is how a driver
 * learns what ended; it does not change the result.
 *
 * @category transitions
 * @since 0.1.0
 */
export const runPruned = (
  config: Config,
  state: State,
  events: ReadonlyArray<Event>,
  dropped?: Dropped
): State =>
  events.reduce((current, event) => {
    const next = step(config, current, event)
    dropped?.(current, next)
    return pruned(next)
  }, state)

/**
 * The policy settling on the queue that keeps only the pruned state: applies
 * what `plan` decides, pruning after each decision, until `plan` has nothing
 * to decide or `fuel` decisions were applied.
 *
 * @category transitions
 * @since 0.1.0
 */
export const settlePruned = (config: Config, fuel: number, state: State, dropped?: Dropped): State => {
  let current = state
  for (let left = fuel; left > 0; left--) {
    const event = plan(config, current)
    if (event === undefined) return current
    const next = step(config, current, event)
    dropped?.(current, next)
    current = pruned(next)
  }
  return current
}

/**
 * How many parts of the target's tree every run was built on: the length of
 * the shortest base, and the whole tree when the queue holds no run. These
 * parts can be cut.
 *
 * @category accessors
 * @since 0.1.0
 */
export const settled = (state: State): number =>
  state.runs.reduce((count, held) => Math.min(count, held.base.length), state.main.length)

/**
 * The state with the first `count` parts cut from the target's tree and from
 * every run's base. `count` must not exceed `settled(state)`.
 *
 * @category transitions
 * @since 0.1.0
 */
export const cut = (state: State, count: number): State => ({
  ...state,
  main: state.main.slice(count),
  runs: state.runs.map((held) => ({ ...held, base: held.base.slice(count) }))
})
