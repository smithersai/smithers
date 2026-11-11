/**
 * The world the queue acts on.
 *
 * The kernel decides; these four services are how a decision reaches CI, fix
 * agents and the target branch, and how their answers come back. Every
 * command is a reconciliation ("make it so"), derived from the queue's durable
 * state alone, so the driver repeats it after a crash and asking twice is
 * asking once.
 *
 * A host provides the real implementations (CI on `smthrs ci`, fix agents on
 * `@smthrs/agent`, the target on a repository). Tests provide in-memory ones,
 * and inject faulty ones to test failures.
 *
 * @since 0.1.0
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { Event, Tree, Verdict } from "./Basic.ts"
import type { FixBrief } from "./Policy.ts"
import { Part } from "./Schema.ts"

/**
 * A service could not answer. The driver's flow retries; nothing is decided
 * on an answer that did not arrive.
 *
 * @category errors
 * @since 0.1.0
 */
export class Unavailable extends Schema.TaggedError<Unavailable>()("@smthrs/merge-queue/Unavailable", {
  service: Schema.Literals(["inbox", "ci", "fixer", "target"]),
  detail: Schema.String
}) {}

/**
 * The target branch no longer extends the tree the queue knows: its history
 * was rewritten, or a change the queue holds was put there by someone else.
 * The queue cannot rebase onto a tip it cannot explain, so the round fails
 * loudly. A commit added on top of the tip is not this: the queue adopts it.
 *
 * @category errors
 * @since 0.1.0
 */
export class TargetDiverged extends Schema.TaggedError<TargetDiverged>()("@smthrs/merge-queue/TargetDiverged", {
  known: Schema.Array(Part),
  found: Schema.Array(Part)
}) {}

/**
 * One entry of the inbox: a change handed in, a change taken back, the
 * request to finish once every change has ended, or an entry the inbox could
 * not read, which the queue passes over.
 *
 * @category models
 * @since 0.1.0
 */
export type Letter =
  | { readonly _tag: "event"; readonly event: Extract<Event, { readonly _tag: "enqueue" | "withdraw" }> }
  | { readonly _tag: "close" }
  | { readonly _tag: "skip" }

/**
 * Where people and agents hand changes to the queue. The inbox is an ordered
 * log; `cursor` is how many letters the queue has taken.
 *
 * @category services
 * @since 0.1.0
 */
export class Inbox extends Context.Service<
  Inbox,
  {
    /** The letters after the first `cursor` ones. Never blocks. */
    readonly since: (cursor: number) => Effect.Effect<ReadonlyArray<Letter>, Unavailable>
    /** Returns once a letter after the first `cursor` ones may exist. */
    readonly wait: (cursor: number) => Effect.Effect<void>
  }
>()("@smthrs/merge-queue/Inbox") {}

/**
 * One CI run to keep running: the exact tree, the checks in the order to start
 * them (slowest first) and the predicted time until the last one finishes.
 *
 * @category models
 * @since 0.1.0
 */
export interface Job {
  readonly run: number
  readonly tree: Tree
  readonly checks: ReadonlyArray<number>
  readonly eta: number
}

/**
 * One finished check, with how long it took.
 *
 * @category models
 * @since 0.1.0
 */
export interface Finished {
  readonly check: number
  readonly verdict: Verdict
  readonly duration: number
}

/**
 * What CI knows about a run: every check finished so far, or that it lost the
 * run and the tree must be tested again.
 *
 * @category models
 * @since 0.1.0
 */
export type Progress =
  | { readonly _tag: "running"; readonly finished: ReadonlyArray<Finished> }
  | { readonly _tag: "lost" }

/**
 * CI. A run tests one tree; its checks finish one at a time, and the queue
 * reads them as they finish.
 *
 * @category services
 * @since 0.1.0
 */
export class Ci extends Context.Service<
  Ci,
  {
    /** Makes CI run exactly these jobs: starts the ones it lacks, stops every other run. */
    readonly reconcile: (jobs: ReadonlyArray<Job>) => Effect.Effect<void, Unavailable>
    /** Every check of the run that has finished so far. Never blocks. */
    readonly progress: (run: number) => Effect.Effect<Progress, Unavailable>
    /** Returns once some listed run may have more than `finished` finished checks, or be lost. */
    readonly wait: (
      seen: ReadonlyArray<{ readonly run: number; readonly finished: number }>
    ) => Effect.Effect<void>
  }
>()("@smthrs/merge-queue/Ci") {}

/**
 * A fix agent's answer: a new revision, or its written verdict that the
 * change must be redone.
 *
 * @category models
 * @since 0.1.0
 */
export type Answer = { readonly _tag: "fixed" } | { readonly _tag: "gaveUp"; readonly detail: string }

/**
 * Fix agents. One agent works on one change for one fix attempt.
 *
 * @category services
 * @since 0.1.0
 */
export class Fixer extends Context.Service<
  Fixer,
  {
    /**
     * Makes exactly these agents work: starts the ones missing, passes new
     * failures to the ones running, stops every other agent.
     */
    readonly reconcile: (briefs: ReadonlyArray<FixBrief>) => Effect.Effect<void, Unavailable>
    /** The agent's answer for a change's fix attempt, when it has one. Never blocks. */
    readonly answer: (id: number, attempt: number) => Effect.Effect<Answer | undefined, Unavailable>
    /** Returns once some listed fix attempt may have an answer. */
    readonly wait: (
      pending: ReadonlyArray<{ readonly id: number; readonly attempt: number }>
    ) => Effect.Effect<void>
  }
>()("@smthrs/merge-queue/Fixer") {}

/**
 * The target branch. The queue rebases everything on its tip and only ever
 * fast-forwards it.
 *
 * @category services
 * @since 0.1.0
 */
export class Target extends Context.Service<
  Target,
  {
    /** The tree the target branch is on now. */
    readonly tip: Effect.Effect<Tree, Unavailable>
    /**
     * Fast-forwards the target from `from` to `to`, only if it is on `from`
     * (compare-and-swap). Does nothing when the target is elsewhere; the queue
     * reads the tip again and decides.
     */
    readonly advance: (from: Tree, to: Tree) => Effect.Effect<void, Unavailable>
    /** Returns once the target may no longer be on `tree`. */
    readonly wait: (tree: Tree) => Effect.Effect<void>
  }
>()("@smthrs/merge-queue/Target") {}
