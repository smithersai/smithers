/**
 * The merge queue's vocabulary.
 *
 * A merge queue owns one target branch. People and agents hand it changes; it
 * tests candidate trees and moves the target only onto a tree whose every
 * required check passed.
 *
 * Every name here is the name the Lean reference uses
 * (`lean/MergeQueue/Basic.lean`). One Lean definition maps to one definition
 * in this package, and `test/Reference.test.ts` holds the two to the same
 * answers.
 *
 * @since 0.1.0
 */

/**
 * One revision of one change. A tree is made of parts, so two trees are the
 * same tree exactly when they apply the same revisions in the same order.
 *
 * @category models
 * @since 0.1.0
 */
export interface Part {
  readonly id: number
  readonly rev: number
}

/**
 * The parts applied on top of the target's first commit, in order. The target
 * branch is a tree; a candidate is the target's tree with more parts appended.
 *
 * @category models
 * @since 0.1.0
 */
export type Tree = ReadonlyArray<Part>

/**
 * One check's outcome.
 *
 * @category models
 * @since 0.1.0
 */
export type Verdict = "pass" | "fail"

/**
 * One streamed check result: the check and its verdict.
 *
 * @category models
 * @since 0.1.0
 */
export interface Result {
  readonly check: number
  readonly verdict: Verdict
}

/**
 * Why a change was put out of the queue as unmergeable: it ran out of fix
 * attempts, or a fix agent judged that it must be redone from scratch.
 *
 * @category models
 * @since 0.1.0
 */
export type ReasonKind = "attemptsExhausted" | "agentVerdict"

/**
 * The written record handed to a change's author when it is unmergeable.
 *
 * @category models
 * @since 0.1.0
 */
export interface Reason {
  readonly kind: ReasonKind
  /** The words for the author. Never empty. */
  readonly detail: string
  /** The checks that had failed for the last revision tested. */
  readonly failures: ReadonlyArray<number>
  /** The fix attempts the change had used. */
  readonly attempts: number
}

/**
 * Where a change is. `fixing.run` is the run whose failure blamed the change;
 * that run's later failures keep streaming to the fix agent. `merged`,
 * `unmergeable` and `withdrawn` never change again.
 *
 * @category models
 * @since 0.1.0
 */
export type Status =
  | { readonly _tag: "queued" }
  | { readonly _tag: "fixing"; readonly run: number }
  | { readonly _tag: "merged" }
  | { readonly _tag: "unmergeable"; readonly reason: Reason }
  | { readonly _tag: "withdrawn" }

/**
 * One change handed to the queue.
 *
 * @category models
 * @since 0.1.0
 */
export interface Change {
  readonly id: number
  /** Higher lands first. */
  readonly priority: number
  /** Arrival order; breaks priority ties. A fix takes a new one. */
  readonly seq: number
  /** Bumped by every fix. */
  readonly rev: number
  /** Fix attempts used. */
  readonly attempts: number
  readonly status: Status
}

/**
 * One CI run on one exact tree: `base` followed by `batch`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Run {
  readonly id: number
  /** The target's tree when the run started. */
  readonly base: Tree
  /** The parts under test, in landing order. */
  readonly batch: ReadonlyArray<Part>
  /** Check results in arrival order. The first result for a check stands. */
  readonly results: ReadonlyArray<Result>
}

/**
 * The audit record of one landing.
 *
 * @category models
 * @since 0.1.0
 */
export interface Landing {
  readonly run: number
  /** The target's tree before. */
  readonly base: Tree
  /** The parts that landed. */
  readonly batch: ReadonlyArray<Part>
  /** The results that justified it. */
  readonly results: ReadonlyArray<Result>
  /**
   * Someone other than the queue put these commits on the target. The queue
   * did not test them; it adopted the new tip and retests everything on it.
   */
  readonly foreign: boolean
}

/**
 * One remembered check duration.
 *
 * @category models
 * @since 0.1.0
 */
export interface Sample {
  readonly check: number
  readonly duration: number
}

/**
 * The queue's settings.
 *
 * @category models
 * @since 0.1.0
 */
export interface Config {
  /** Every check a tree must pass before the target moves onto it. */
  readonly required: ReadonlyArray<number>
  /** Fix attempts a change may use before it is unmergeable. */
  readonly maxAttempts: number
  /** Most changes tested together in one new batch. */
  readonly maxBatch: number
  /** Most undecided runs at once. */
  readonly maxRuns: number
  /** Duration samples kept per check. */
  readonly window: number
  /** The estimate for a check with no samples. */
  readonly defaultDuration: number
}

/**
 * Everything the queue remembers. All of it is durable: a restart continues
 * from this value alone. Between rounds the driver keeps `pruned(state)`
 * (`Compact.ts`): the same value without ended changes and landings.
 *
 * @category models
 * @since 0.1.0
 */
export interface State {
  /** The target branch's tree. */
  readonly main: Tree
  /** Every change ever enqueued, in arrival order. No event removes one. */
  readonly changes: ReadonlyArray<Change>
  readonly runs: ReadonlyArray<Run>
  readonly nextRun: number
  readonly nextSeq: number
  /** Every landing, oldest first. */
  readonly landed: ReadonlyArray<Landing>
  /** Durations of finished checks, oldest first, at most `window` per check. */
  readonly history: ReadonlyArray<Sample>
  /**
   * The run whose tree the queue is fast-forwarding the target onto, or
   * `null`. The landing is recorded when the target is seen there.
   */
  readonly pushing: number | null
}

/**
 * What happens to the queue. `enqueue`, `withdraw`, `result`, `fixed`,
 * `gaveUp`, `foreign` (someone else put a commit on the target) and `land`
 * (the target was seen on the pushed tree) arrive from outside; `start`,
 * `probe`, `push`, `blame` and `cancel` are what the queue decides, and `plan` chooses
 * among them. Every event is safe at any time: `step` refuses one whose guard
 * does not hold.
 *
 * @category models
 * @since 0.1.0
 */
export type Event =
  | { readonly _tag: "enqueue"; readonly id: number; readonly priority: number }
  | { readonly _tag: "withdraw"; readonly id: number }
  | {
    readonly _tag: "result"
    readonly run: number
    readonly check: number
    readonly verdict: Verdict
    readonly duration: number
  }
  | { readonly _tag: "fixed"; readonly id: number; readonly attempt: number }
  | { readonly _tag: "gaveUp"; readonly id: number; readonly attempt: number; readonly detail: string }
  | { readonly _tag: "foreign"; readonly id: number }
  | { readonly _tag: "start"; readonly count: number }
  | { readonly _tag: "push"; readonly run: number }
  | { readonly _tag: "probe"; readonly id: number }
  | { readonly _tag: "land"; readonly run: number }
  | { readonly _tag: "blame"; readonly run: number }
  | { readonly _tag: "cancel"; readonly run: number }

/**
 * The queue before anything has happened.
 *
 * @category constructors
 * @since 0.1.0
 */
export const empty: State = {
  main: [],
  changes: [],
  runs: [],
  nextRun: 0,
  nextSeq: 0,
  landed: [],
  history: [],
  pushing: null
}

/**
 * The part a change contributes at its current revision.
 *
 * @category accessors
 * @since 0.1.0
 */
export const part = (change: Change): Part => ({ id: change.id, rev: change.rev })

/**
 * The exact tree a run tests.
 *
 * @category accessors
 * @since 0.1.0
 */
export const tree = (run: Run): Tree => [...run.base, ...run.batch]

/**
 * Whether two parts are the same revision of the same change.
 *
 * @category predicates
 * @since 0.1.0
 */
export const samePart = (left: Part, right: Part): boolean => left.id === right.id && left.rev === right.rev

/**
 * Whether two trees apply the same revisions in the same order.
 *
 * @category predicates
 * @since 0.1.0
 */
export const sameTree = (left: Tree, right: Tree): boolean =>
  left.length === right.length && left.every((entry, index) => samePart(entry, right[index]!))

/**
 * Whether a status never changes again.
 *
 * @category predicates
 * @since 0.1.0
 */
export const isTerminal = (status: Status): boolean =>
  status._tag === "merged" || status._tag === "unmergeable" || status._tag === "withdrawn"
