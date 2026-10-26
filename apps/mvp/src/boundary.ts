import { Cause, type Context, Effect, type Fiber } from "effect"
import { codeOf } from "./errorCode"

// Where the app runs an Effect outside the program: a view's action, a DOM listener that must answer at once, a
// library callback that wants a Promise (AGENTS.md, rule effect.boundary-only). Each runs with the services its layer
// captured, and records what no caller will: a defect, and for a forked Effect, which nobody awaits, its failure too.

/** How the Effect was run: its result returned, as a Promise, or forked. */
export type Boundary = "sync" | "promise" | "fork"

/**
 * Logs `app.unhandled` at Error, inside `effect`, for a defect, and for a failure when `boundary` is `fork`: with the
 * feature that ran it, the boundary, `kind` (`defect` or `failure`) and `error.type`, the failure's code, never its
 * message. An interruption is not logged. A sync or promise boundary's failure is its caller's to handle.
 */
export const recordUnhandled = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  feature: string,
  boundary: Boundary,
): Effect.Effect<A, E, R> =>
  Effect.tapCause(effect, (cause) => {
    const defect = cause.reasons.find(Cause.isDieReason)
    const failure = boundary === "fork" ? cause.reasons.find(Cause.isFailReason) : undefined
    if (defect === undefined && failure === undefined) return Effect.void
    return Effect.logError("app.unhandled").pipe(
      Effect.annotateLogs({
        feature,
        boundary,
        kind: defect === undefined ? "failure" : "defect",
        "error.type": codeOf(defect === undefined ? failure!.error : defect.defect),
      }),
    )
  })

/**
 * The runners a layer hands its views: `Effect.runSyncWith`, `runPromiseWith` and `runForkWith` with its services. A
 * promise or a fork takes Effect's run options, such as the route's `signal`, which interrupts it.
 */
export interface Runners<R> {
  readonly runSync: <A, E>(effect: Effect.Effect<A, E, R>) => A
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E, R>, options?: Effect.RunOptions) => Promise<A>
  readonly runFork: <A, E>(effect: Effect.Effect<A, E, R>, options?: Effect.RunOptions) => Fiber.Fiber<A, E>
}

/** Runners over `context` that record what goes unhandled as `feature`'s (`recordUnhandled`). */
export const runners = <R>(context: Context.Context<R>, feature: string): Runners<R> => ({
  runSync: (effect) => Effect.runSyncWith(context)(recordUnhandled(effect, feature, "sync")),
  runPromise: (effect, options) => Effect.runPromiseWith(context)(recordUnhandled(effect, feature, "promise"), options),
  runFork: (effect, options) => Effect.runForkWith(context)(recordUnhandled(effect, feature, "fork"), options),
})
