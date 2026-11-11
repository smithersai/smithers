/**
 * The policy.
 *
 * `step` says what may happen; `plan` says what the queue does next. `plan` is
 * a function of the durable state alone, so a queue that restarts picks up
 * exactly where it stopped.
 *
 * Safety never depends on the policy: `step` checks every guard itself, so no
 * policy, however wrong, can land a tree that was not tested green.
 *
 * Mirrors `lean/MergeQueue/Policy.lean` definition for definition.
 *
 * @since 0.1.0
 */

import type { Change, Config, Event, Run, State } from "./Basic.ts"
import { isTerminal, part, samePart, tree } from "./Basic.ts"
import {
  before,
  complete,
  failed,
  failuresOf,
  green,
  inOrder,
  live,
  pending,
  pendingCount,
  ready,
  step
} from "./Step.ts"

/**
 * Whether the run can land now.
 *
 * @category decisions
 * @since 0.1.0
 */
export const landable = (config: Config, state: State, run: Run): boolean =>
  live(state, run) !== undefined && green(config, run.results)

/**
 * Whether the run has failed and exactly one change is left to blame.
 *
 * @category decisions
 * @since 0.1.0
 */
export const blameable = (state: State, run: Run): boolean => {
  const batch = live(state, run)
  return batch !== undefined && batch.length === 1 && failed(run.results)
}

/**
 * Whether the run blamed a change that a fix agent is still working on. Its
 * later failures stream to that agent, so the queue keeps it.
 *
 * @category decisions
 * @since 0.1.0
 */
export const evidence = (state: State, run: Run): boolean =>
  state.changes.some((change) => change.status._tag === "fixing" && change.status.run === run.id)

/**
 * For a live run whose parts are still the first ready changes in order: how
 * many of them.
 *
 * @category decisions
 * @since 0.1.0
 */
export const prefixLength = (state: State, run: Run): number | undefined => {
  const batch = live(state, run)
  if (batch === undefined) return undefined
  const first = ready(state).slice(0, batch.length).map(part)
  return first.length === batch.length && batch.every((entry, index) => samePart(entry, first[index]!))
    ? batch.length
    : undefined
}

/**
 * The smallest of a list of numbers.
 *
 * @category decisions
 * @since 0.1.0
 */
export const minOf = (numbers: ReadonlyArray<number>): number | undefined =>
  numbers.length === 0 ? undefined : Math.min(...numbers)

/**
 * The largest of a list of numbers; 0 for none.
 *
 * @category decisions
 * @since 0.1.0
 */
export const maxOf = (numbers: ReadonlyArray<number>): number => Math.max(0, ...numbers)

/**
 * The lengths of the prefixes that a failed run has shown to fail.
 *
 * @category decisions
 * @since 0.1.0
 */
export const failedPrefixes = (state: State): ReadonlyArray<number> =>
  state.runs.flatMap((run) => {
    const length = prefixLength(state, run)
    return length !== undefined && failed(run.results) ? [length] : []
  })

/**
 * The lengths below `bound` of the prefixes that a run is testing and has not
 * failed.
 *
 * @category decisions
 * @since 0.1.0
 */
export const unfailedPrefixes = (state: State, bound: number): ReadonlyArray<number> =>
  state.runs.flatMap((run) => {
    const length = prefixLength(state, run)
    return length !== undefined && !failed(run.results) && length < bound ? [length] : []
  })

/**
 * The shortest failed prefix: the first `m` ready changes are known to fail
 * together.
 *
 * @category decisions
 * @since 0.1.0
 */
export const shortestFailed = (state: State): number | undefined => minOf(failedPrefixes(state))

/**
 * The longest prefix below `bound` that a run is testing and has not failed.
 *
 * @category decisions
 * @since 0.1.0
 */
export const longestUnfailed = (state: State, bound: number): number => maxOf(unfailedPrefixes(state, bound))

/**
 * A live run the queue has no more use for: it failed without being a prefix
 * of the ready order, or it contains a prefix already known to fail.
 *
 * @category decisions
 * @since 0.1.0
 */
export const doomed = (state: State, run: Run): boolean => {
  if (live(state, run) === undefined) return false
  const length = prefixLength(state, run)
  if (length === undefined) return failed(run.results)
  const shortest = shortestFailed(state)
  return shortest !== undefined && shortest < length
}

/**
 * Whether a pending live run started under an older ready order. It keeps its
 * slot: the queue starts nothing new until it lands or fails.
 *
 * @category decisions
 * @since 0.1.0
 */
export const outOfOrder = (config: Config, state: State): boolean =>
  state.runs.some((run) =>
    live(state, run) !== undefined && prefixLength(state, run) === undefined && pending(config, run)
  )

/**
 * How many ready changes the next run should take, if the queue should start
 * one. With no known failure it extends the longest prefix under test by up to
 * `maxBatch` (speculation). With the first `m` known to fail it tests a prefix
 * halfway between the longest unfailed prefix and `m` (bisection).
 *
 * @category decisions
 * @since 0.1.0
 */
export const nextStart = (config: Config, state: State): number | undefined => {
  if (config.maxRuns <= pendingCount(config, state)) return undefined
  if (outOfOrder(config, state)) return undefined
  const waiting = ready(state).length
  const shortest = shortestFailed(state)
  if (shortest === undefined) {
    const tested = longestUnfailed(state, waiting + 1)
    return tested < waiting ? tested + Math.min(Math.max(config.maxBatch, 1), waiting - tested) : undefined
  }
  const tested = longestUnfailed(state, shortest)
  return tested + 1 < shortest ? tested + Math.floor((shortest - tested + 1) / 2) : undefined
}

/**
 * The landable run with the longest tree; the earliest such run on a tie.
 *
 * @category decisions
 * @since 0.1.0
 */
export const bestLandable = (config: Config, state: State): Run | undefined =>
  state.runs.reduce<Run | undefined>((best, run) => {
    if (!landable(config, state, run)) return best
    return best === undefined || tree(best).length < tree(run).length ? run : best
  }, undefined)

/**
 * The queue's next decision, or `undefined` when it has to wait for the world.
 * In order: land what can land, blame what can be blamed, cancel what is no
 * longer useful, then start the next run.
 *
 * @category decisions
 * @since 0.1.0
 */
export const plan = (config: Config, state: State): Event | undefined => {
  const landing = bestLandable(config, state)
  if (landing !== undefined) return { _tag: "land", run: landing.id }
  const blamed = state.runs.find((run) => blameable(state, run))
  if (blamed !== undefined) return { _tag: "blame", run: blamed.id }
  const useless = state.runs.find((run) =>
    (live(state, run) === undefined && !evidence(state, run)) || doomed(state, run)
  )
  if (useless !== undefined) return { _tag: "cancel", run: useless.id }
  const count = nextStart(config, state)
  return count === undefined ? undefined : { _tag: "start", count }
}

/**
 * Applies the policy's decisions until it has none left, at most `fuel` times.
 *
 * @category decisions
 * @since 0.1.0
 */
export const settle = (config: Config, fuel: number, state: State): State => {
  let current = state
  for (let left = fuel; left > 0; left--) {
    const event = plan(config, current)
    if (event === undefined) return current
    current = step(config, current, event)
  }
  return current
}

/**
 * Whether CI should be running this run: it is unfinished, and either
 * undecided or still feeding failures to a fix agent.
 *
 * @category commands
 * @since 0.1.0
 */
export const wantsCi = (config: Config, state: State, run: Run): boolean =>
  !complete(config, run.results) && (pending(config, run) || evidence(state, run))

/**
 * A change that is ahead of another in the queue and has not ended. `fixing`
 * says a fix agent is on it.
 *
 * @category commands
 * @since 0.1.0
 */
export interface Ahead {
  readonly id: number
  readonly fixing: boolean
}

/**
 * What a fix agent is given.
 *
 * @category commands
 * @since 0.1.0
 */
export interface FixBrief {
  readonly id: number
  readonly rev: number
  readonly attempt: number
  /** The failed checks so far; more may stream in. */
  readonly failures: ReadonlyArray<number>
  /** The changes ahead in the queue, in order, and whether each is being fixed. */
  readonly ahead: ReadonlyArray<Ahead>
}

/**
 * The unfinished changes ahead of `change`, in landing order.
 *
 * @category commands
 * @since 0.1.0
 */
export const ahead = (state: State, change: Change): ReadonlyArray<Ahead> =>
  inOrder(
    state.changes.filter((other) => !isTerminal(other.status) && other.id !== change.id && before(other, change))
  ).map((other) => ({ id: other.id, fixing: other.status._tag === "fixing" }))

/**
 * One brief per change being fixed.
 *
 * @category commands
 * @since 0.1.0
 */
export const fixBriefs = (state: State): ReadonlyArray<FixBrief> =>
  state.changes.filter((change) => change.status._tag === "fixing").map((change) => ({
    id: change.id,
    rev: change.rev,
    attempt: change.attempts,
    failures: failuresOf(state, change),
    ahead: ahead(state, change)
  }))
