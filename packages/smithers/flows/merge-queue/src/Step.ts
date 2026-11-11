/**
 * The transition function.
 *
 * `step(config, state, event)` is the whole queue: every state change is one
 * event applied by this function. Each event has a guard; an event whose guard
 * fails returns the state it was given, so a late, duplicate or stale event is
 * harmless.
 *
 * Mirrors `lean/MergeQueue/Step.lean` definition for definition.
 *
 * @since 0.1.0
 */

import type { Change, Config, Event, Part, Result, Run, Sample, State, Tree, Verdict } from "./Basic.ts"
import { part, samePart, sameTree, tree } from "./Basic.ts"

/**
 * Whether a check has a result.
 *
 * @category results
 * @since 0.1.0
 */
export const answered = (results: ReadonlyArray<Result>, check: number): boolean =>
  results.some((result) => result.check === check)

/**
 * Whether a check passed.
 *
 * @category results
 * @since 0.1.0
 */
export const passed = (results: ReadonlyArray<Result>, check: number): boolean =>
  results.some((result) => result.check === check && result.verdict === "pass")

/**
 * Whether some check failed. One failure is enough: the rest of the run is not
 * needed to know the tree is not green.
 *
 * @category results
 * @since 0.1.0
 */
export const failed = (results: ReadonlyArray<Result>): boolean => results.some((result) => result.verdict === "fail")

/**
 * Whether every required check has a result.
 *
 * @category results
 * @since 0.1.0
 */
export const complete = (config: Config, results: ReadonlyArray<Result>): boolean =>
  config.required.every((check) => answered(results, check))

/**
 * A complete green result: there is at least one required check, every
 * required check passed, and nothing failed. Only this lets a tree land.
 *
 * @category results
 * @since 0.1.0
 */
export const green = (config: Config, results: ReadonlyArray<Result>): boolean =>
  config.required.length > 0 && config.required.every((check) => passed(results, check)) && !failed(results)

/**
 * The failed checks, in arrival order.
 *
 * @category results
 * @since 0.1.0
 */
export const failures = (results: ReadonlyArray<Result>): ReadonlyArray<number> =>
  results.filter((result) => result.verdict === "fail").map((result) => result.check)

/**
 * A run is pending while it has neither failed nor completed. Pending runs are
 * the ones that count against `maxRuns`.
 *
 * @category results
 * @since 0.1.0
 */
export const pending = (config: Config, run: Run): boolean => !failed(run.results) && !complete(config, run.results)

/**
 * Whether `left` lands no later than `right`: higher priority first, then
 * earlier arrival.
 *
 * @category order
 * @since 0.1.0
 */
export const before = (left: Change, right: Change): boolean =>
  left.priority > right.priority || (left.priority === right.priority && left.seq <= right.seq)

/**
 * Sorts changes into landing order. The sort is stable, as the reference's is.
 *
 * @category order
 * @since 0.1.0
 */
export const inOrder = (changes: ReadonlyArray<Change>): ReadonlyArray<Change> =>
  [...changes].sort((left, right) => before(left, right) ? (before(right, left) ? 0 : -1) : 1)

/**
 * The changes waiting to land, in landing order.
 *
 * @category order
 * @since 0.1.0
 */
export const ready = (state: State): ReadonlyArray<Change> =>
  inOrder(state.changes.filter((change) => change.status._tag === "queued"))

/**
 * What `candidate` adds to `main`, when `candidate` extends it.
 *
 * @category liveness
 * @since 0.1.0
 */
export const strip = (main: Tree, candidate: Tree): ReadonlyArray<Part> | undefined =>
  candidate.length >= main.length && main.every((entry, index) => samePart(entry, candidate[index]!))
    ? candidate.slice(main.length)
    : undefined

/**
 * Whether the part is the current revision of a queued change.
 *
 * @category liveness
 * @since 0.1.0
 */
export const partReady = (state: State, entry: Part): boolean =>
  state.changes.some((change) => samePart(part(change), entry) && change.status._tag === "queued")

/**
 * A run is live when its tree is the target's tree plus at least one part, and
 * every added part is still the current revision of a queued change. `live`
 * returns those added parts. Only a live run can land or blame. A run that is
 * not live can never become live again.
 *
 * @category liveness
 * @since 0.1.0
 */
export const live = (state: State, run: Run): ReadonlyArray<Part> | undefined => {
  const added = strip(state.main, tree(run))
  return added !== undefined && added.length > 0 && added.every((entry) => partReady(state, entry)) ? added : undefined
}

/**
 * How many runs are pending.
 *
 * @category liveness
 * @since 0.1.0
 */
export const pendingCount = (config: Config, state: State): number =>
  state.runs.filter((run) => pending(config, run)).length

/**
 * The run with this id, if the queue holds it.
 *
 * @category liveness
 * @since 0.1.0
 */
export const findRun = (state: State, run: number): Run | undefined => state.runs.find((entry) => entry.id === run)

/**
 * The failed checks a fix agent is working from: those of the run that blamed
 * the change, including the ones that arrive after the blame.
 *
 * @category liveness
 * @since 0.1.0
 */
export const failuresOf = (state: State, change: Change): ReadonlyArray<number> => {
  if (change.status._tag !== "fixing") return []
  const run = findRun(state, change.status.run)
  return run === undefined ? [] : failures(run.results)
}

/**
 * Records one finished check, keeping at most `window` samples per check.
 *
 * @category durations
 * @since 0.1.0
 */
export const record = (
  window: number,
  history: ReadonlyArray<Sample>,
  check: number,
  duration: number
): ReadonlyArray<Sample> => {
  const next = [...history, { check, duration }]
  if (next.filter((sample) => sample.check === check).length <= window) return next
  const oldest = next.findIndex((sample) => sample.check === check)
  return [...next.slice(0, oldest), ...next.slice(oldest + 1)]
}

const rewrite = (state: State, change: (entry: Change) => Change): State => ({
  ...state,
  changes: state.changes.map(change)
})

/**
 * A new change joins the queue. An id the queue has seen is refused.
 *
 * @category events
 * @since 0.1.0
 */
export const enqueue = (state: State, id: number, priority: number): State =>
  state.changes.some((change) => change.id === id)
    ? state
    : {
      ...state,
      changes: [...state.changes, {
        id,
        priority,
        seq: state.nextSeq,
        rev: 0,
        attempts: 0,
        status: { _tag: "queued" }
      }],
      nextSeq: state.nextSeq + 1
    }

/**
 * The author takes a change back. Only a change that has not ended can be
 * withdrawn.
 *
 * @category events
 * @since 0.1.0
 */
export const withdraw = (state: State, id: number): State =>
  rewrite(state, (change) =>
    change.id === id && (change.status._tag === "queued" || change.status._tag === "fixing")
      ? { ...change, status: { _tag: "withdrawn" } }
      : change)

/**
 * One check result streams in. It is recorded when the check is required, the
 * run exists and the check has no result yet.
 *
 * @category events
 * @since 0.1.0
 */
export const result = (
  config: Config,
  state: State,
  run: number,
  check: number,
  verdict: Verdict,
  duration: number
): State =>
  config.required.includes(check) && state.runs.some((entry) => entry.id === run && !answered(entry.results, check))
    ? {
      ...state,
      runs: state.runs.map((entry) =>
        entry.id === run && !answered(entry.results, check)
          ? { ...entry, results: [...entry.results, { check, verdict }] }
          : entry
      ),
      history: record(config.window, state.history, check, duration)
    }
    : state

/**
 * A fix agent delivers a new revision. `attempt` names the fix attempt the
 * agent was started for, so an answer from an earlier attempt is refused.
 *
 * @category events
 * @since 0.1.0
 */
export const fixed = (state: State, id: number, attempt: number): State =>
  rewrite(state, (change) =>
    change.id === id && change.status._tag === "fixing" && change.attempts === attempt
      ? { ...change, rev: change.rev + 1, status: { _tag: "queued" } }
      : change)

/**
 * A fix agent judges the change unmergeable. The verdict stands only with
 * written words for the author.
 *
 * @category events
 * @since 0.1.0
 */
export const gaveUp = (state: State, id: number, attempt: number, detail: string): State =>
  rewrite(
    state,
    (change) =>
      change.id === id && change.status._tag === "fixing" && change.attempts === attempt && detail !== ""
        ? {
          ...change,
          status: {
            _tag: "unmergeable",
            reason: { kind: "agentVerdict", detail, failures: failuresOf(state, change), attempts: change.attempts }
          }
        }
        : change
  )

/**
 * Starts a run on the target's tree plus the first `count` ready changes.
 *
 * @category decisions
 * @since 0.1.0
 */
export const start = (config: Config, state: State, count: number): State => {
  const waiting = ready(state)
  const batch = waiting.slice(0, count).map(part)
  const candidate = [...state.main, ...batch]
  return count === 0 || waiting.length < count || config.maxRuns <= pendingCount(config, state)
      || state.runs.some((run) => sameTree(tree(run), candidate))
    ? state
    : {
      ...state,
      runs: [...state.runs, { id: state.nextRun, base: state.main, batch, results: [] }],
      nextRun: state.nextRun + 1
    }
}

/**
 * Moves the target onto a run's tree. The run must be live and its result
 * complete and green. The target becomes exactly the tree that was tested.
 *
 * @category decisions
 * @since 0.1.0
 */
export const land = (config: Config, state: State, run: number): State => {
  const found = findRun(state, run)
  if (found === undefined) return state
  const batch = live(state, found)
  if (batch === undefined || !green(config, found.results)) return state
  return {
    ...state,
    main: tree(found),
    changes: state.changes.map((change) =>
      batch.some((entry) => samePart(entry, part(change))) && change.status._tag === "queued"
        ? { ...change, status: { _tag: "merged" } }
        : change
    ),
    runs: state.runs.filter((entry) => entry.id !== run),
    landed: [...state.landed, { run, base: state.main, batch, results: found.results }]
  }
}

/**
 * The words recorded when a change runs out of fix attempts.
 *
 * @category constants
 * @since 0.1.0
 */
export const exhaustedDetail = "still failing after every allowed fix attempt"

/**
 * Blames the only suspect of a failed run. The run must be live with exactly
 * one part beyond the target, and one failed check is enough: blame does not
 * wait for the run to finish. The change goes to a fix agent, or, with no
 * attempts left, out of the queue with a reason.
 *
 * @category decisions
 * @since 0.1.0
 */
export const blame = (config: Config, state: State, run: number): State => {
  const found = findRun(state, run)
  if (found === undefined) return state
  const batch = live(state, found)
  if (batch === undefined || batch.length !== 1 || !failed(found.results)) return state
  const suspect = batch[0]!
  return rewrite(state, (change) =>
    samePart(part(change), suspect) && change.status._tag === "queued"
      ? change.attempts < config.maxAttempts
        ? { ...change, attempts: change.attempts + 1, status: { _tag: "fixing", run } }
        : {
          ...change,
          status: {
            _tag: "unmergeable",
            reason: {
              kind: "attemptsExhausted",
              detail: exhaustedDetail,
              failures: failures(found.results),
              attempts: change.attempts
            }
          }
        }
      : change)
}

/**
 * Forgets a run. Always allowed: losing a run can only delay a landing.
 *
 * @category decisions
 * @since 0.1.0
 */
export const cancel = (state: State, run: number): State => ({
  ...state,
  runs: state.runs.filter((entry) => entry.id !== run)
})

/**
 * The queue: applies one event.
 *
 * @category transitions
 * @since 0.1.0
 */
export const step = (config: Config, state: State, event: Event): State => {
  switch (event._tag) {
    case "enqueue":
      return enqueue(state, event.id, event.priority)
    case "withdraw":
      return withdraw(state, event.id)
    case "result":
      return result(config, state, event.run, event.check, event.verdict, event.duration)
    case "fixed":
      return fixed(state, event.id, event.attempt)
    case "gaveUp":
      return gaveUp(state, event.id, event.attempt, event.detail)
    case "start":
      return start(config, state, event.count)
    case "land":
      return land(config, state, event.run)
    case "blame":
      return blame(config, state, event.run)
    case "cancel":
      return cancel(state, event.run)
  }
}

/**
 * Applies a list of events in order.
 *
 * @category transitions
 * @since 0.1.0
 */
export const run = (config: Config, state: State, events: ReadonlyArray<Event>): State =>
  events.reduce((current, event) => step(config, current, event), state)
