/**
 * Writes to another service at most once per dispatch, found again by an
 * identity the engine derives, never by what the written object looks like.
 *
 * An action implementation that creates something outside the journal (a
 * commit, a pull request, a comment, an email) can lose the answer: the
 * provider made the object, then the process died, the connection dropped or
 * another incarnation took the run before the step's outcome was recorded.
 * The engine runs the step again, and the step has to tell its own object
 * from everyone else's. Matching on a title, a message, a name, a time window
 * or "the latest" adopts objects that only look alike and misses its own.
 *
 * {@link once} closes that gap. The key of a write is derived from the
 * execution and the dispatch ({@link effectKey}), so every run of one step
 * derives the same key and no other step derives it. The {@link Keyed}
 * adapter puts the key on the object in the request that creates it, and
 * finds the object by that key alone. `once` looks first, writes only when
 * the lookup proves nothing was made, and looks again when the write fails,
 * so a lost answer is adopted instead of repeated.
 *
 * @since 1.0.0
 */

import { digestSync } from "@smthrs/crypto"
import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import { FlowInstance } from "../FlowRuntime/FlowInstance.ts"
import * as SpanFailure from "../internal/SpanFailure.ts"
import { CurrentInvocationKey } from "./Context.ts"

/**
 * A write that carries its key and can be found by it.
 *
 * - `perform(key)` makes the object and puts `key` on it in the same request:
 *   a commit trailer, a hidden body marker, a name suffix, or the provider's
 *   own idempotency key.
 * - `find(key)` answers the object `key` made. It matches the key (and the
 *   acting account, where the provider shows one), never a title, a message,
 *   a time window or a name alone. It answers `None` only after a complete
 *   search, and fails when it cannot tell: a search cut short by a page
 *   budget, or an object it cannot read.
 *
 * Both make one request each; the step's retry policy is the only retry.
 * Concurrent calls for one key are serialized within this module instance.
 * Across processes, `perform` must enforce the key atomically at the provider,
 * or the host must fence writers. A marker alone cannot prevent two remote
 * writers from both observing an absent object and creating it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Keyed<A, E = never, R = never> {
  readonly find: (key: string) => Effect.Effect<Option.Option<A>, E, R>
  readonly perform: (key: string) => Effect.Effect<A, E, R>
}

/**
 * Builds a {@link Keyed}, inferring its types from both functions.
 *
 * @category constructors
 * @since 1.0.0
 */
export const keyed = <A, E = never, R = never>(effect: Keyed<A, E, R>): Keyed<A, E, R> => effect

/**
 * {@link once} or {@link effectKey} ran where the runtime names no dispatch:
 * outside a flow execution, or under a runtime that supplies no
 * `Action.CurrentInvocationKey`. A defect, because a write without a durable
 * identity cannot be found again, and writing it anyway is the bug this
 * module exists to prevent.
 *
 * @category errors
 * @since 1.0.0
 */
export class EffectKeyUnavailable extends Schema.TaggedError<EffectKeyUnavailable>()(
  "@smthrs/flow/EffectKeyUnavailable",
  {
    name: Schema.String,
    message: Schema.String
  }
) {}

/**
 * How {@link once} settled a write: made now, found from an earlier run of the
 * step, found after this run's own write failed (its answer was lost), or
 * failed with nothing found.
 *
 * @category models
 * @since 1.0.0
 */
export type EffectOutcome = "performed" | "adopted" | "adopted_after_failure" | "failed"

/**
 * Writes {@link once} settled, by outcome. The write's name and key stay out
 * of the labels: a name can carry an item id, and a key is an identity.
 *
 * @category metrics
 * @since 1.0.0
 */
export const effects = Metric.counter("flows_effects", {
  description: "External writes made through Action.once, by outcome",
  incremental: true
})

const PREIMAGE = "smithers/effect/v1"

// Retain an entry until both its holder and every waiter have released it.
// Results stay at the provider: a later call always verifies the marker again.
const writes = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>()

const withWrite = <A, E, R>(key: string, body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      let entry = writes.get(key)
      if (entry === undefined) {
        entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 }
        writes.set(key, entry)
      }
      entry.users++
      return entry
    }),
    (entry) => entry.semaphore.withPermit(body),
    (entry) =>
      Effect.sync(() => {
        entry.users--
        if (entry.users === 0) writes.delete(key)
      })
  )

/**
 * The key of write `name` in the dispatch running now: 64 lowercase hex of
 * SHA-256 over the version, the execution id, the dispatch's
 * `Action.CurrentInvocationKey` and `name`, one per line.
 *
 * Every run of one dispatch derives the same key: its attempts, a takeover
 * by another incarnation, and a resume after a crash. Another dispatch,
 * another execution, or another name in the same dispatch derives a
 * different one. Nothing from the payload or the clock enters it.
 *
 * The execution id is in it because a keyed sealed action's invocation key
 * is a cross-run cache key: without it, two executions could share a write.
 *
 * Dies with {@link EffectKeyUnavailable} outside a dispatch.
 *
 * @category idempotency
 * @since 1.0.0
 */
export const effectKey = (name: string): Effect.Effect<string> =>
  Effect.gen(function*() {
    const instance = yield* Effect.serviceOption(FlowInstance)
    const invocation = yield* CurrentInvocationKey
    if (Option.isNone(instance) || invocation === undefined) {
      return yield* Effect.die(
        new EffectKeyUnavailable({
          name,
          message: `Action.once "${name}" ran outside a flow dispatch. A write is keyed by the execution and the ` +
            "dispatch that make it, so it runs only inside an action implementation under a runtime that supplies " +
            "FlowInstance and Action.CurrentInvocationKey."
        })
      )
    }
    return digestSync(`${PREIMAGE}\n${instance.value.executionId}\n${invocation}\n${name}`)
  })

/**
 * How {@link once} keys a write.
 *
 * @category models
 * @since 1.0.0
 */
export interface OnceOptions {
  /**
   * The write's key, when its identity was chosen and recorded before the step ran: a write id a device picked and
   * stored with the request that started this execution, or a domain id one execution owns, such as a decision's.
   * Never derive it from what is written. Without it, `once` derives the key from the dispatch
   * ({@link effectKey}), and runs only inside one.
   */
  readonly key?: string | undefined
}

const record = (outcome: EffectOutcome) =>
  Effect.andThen(
    Metric.update(Metric.withAttributes(effects, { outcome }), 1),
    Effect.annotateCurrentSpan({ "smithers.effect.outcome": outcome })
  ).pipe(
    Effect.andThen(
      Effect.logDebug("Action.once").pipe(Effect.annotateLogs({ outcome }))
    )
  )

/**
 * Finds write `name`'s object, or makes it once.
 *
 * 1. `find(key)`. An object: that is the result, and nothing is written.
 * 2. None: `perform(key)`, and its object is the result.
 * 3. `perform` failed: `find(key)` again, because a write whose answer was
 *    lost (a dropped connection, a timeout, a takeover) may have landed. An
 *    object: that is the result. None, or a failing lookup: `perform`'s
 *    failure.
 *
 * A failing first `find` fails without writing: a lookup that cannot tell is
 * never read as "not made".
 *
 * Name each write of one step differently. A step that writes in a loop names
 * each write by a stable id from its payload, such as `comment/${path}`.
 *
 * Pass `options.key` when the write's identity was chosen and recorded before
 * the step ran, such as a write id stored with the request; `once` then uses
 * it as is and needs no dispatch.
 *
 * Declare a step whose writes all go through `once` `tier: "irreversible"`
 * with an `idempotencyKey`: repeating it is safe, so a durable engine re-runs
 * an attempt that died mid-write, and `once` finds what it made.
 *
 * @example
 * ```ts
 * import { Action } from "@smthrs/flow"
 * import * as Effect from "effect/Effect"
 * import * as Option from "effect/Option"
 *
 * declare const sent: Map<string, string>
 * const send = (text: string) =>
 *   Action.once("send", Action.keyed({
 *     find: (key) => Effect.sync(() => Option.fromUndefinedOr(sent.get(key))),
 *     perform: (key) => Effect.sync(() => {
 *       sent.set(key, text)
 *       return text
 *     })
 *   }))
 * ```
 *
 * @category idempotency
 * @since 1.0.0
 */
export const once = <A, E, R>(
  name: string,
  effect: Keyed<A, E, R>,
  options?: OnceOptions
): Effect.Effect<A, E, R> =>
  Effect.gen(function*() {
    const key = options?.key ?? (yield* effectKey(name))
    // Adoption is read-only and must not wait for a dead incarnation's writer.
    // A miss still enters the gate and checks again before creating anything.
    if (writes.has(key)) {
      const earlier = yield* effect.find(key)
      if (Option.isSome(earlier)) {
        yield* record("adopted")
        return earlier.value
      }
    }
    return yield* withWrite(
      key,
      Effect.gen(function*() {
        const earlier = yield* effect.find(key)
        if (Option.isSome(earlier)) {
          yield* record("adopted")
          return earlier.value
        }
        const made = yield* Effect.result(effect.perform(key))
        if (made._tag === "Success") {
          yield* record("performed")
          return made.success
        }
        const landed = yield* Effect.result(effect.find(key))
        if (landed._tag === "Success" && Option.isSome(landed.success)) {
          yield* record("adopted_after_failure")
          return landed.success.value
        }
        yield* record("failed")
        return yield* Effect.fail(made.failure)
      })
    )
  }).pipe(SpanFailure.withSpan("Action.once"))
