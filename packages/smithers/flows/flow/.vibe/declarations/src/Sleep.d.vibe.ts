/**
 * The system timer, as an ordinary declared action.
 *
 * `docs/concepts/flows-and-actions.md` names the timer primitive a
 * gap and says how to close it: ship it over the existing `DurableClock`, so a
 * wait is a visible, keyed plan node rather than a second execution mechanism.
 * That is this module. {@link action} is a plain `Action.make` declaration —
 * it appears in a catalog, `.call()` records a node, and `Graph.build` puts that
 * node in the plan beside every other step — and {@link layer} is the
 * implementation the hosts that can run a timer provide.
 *
 * The wait itself is `DurableClock`'s, not a new one. The implementation arms
 * the durable clock and awaits its deferred, which is what parks the execution;
 * the park is declared through the ordinary waiting vocabulary
 * ({@link module:WaitingAnnotation.annotateWaiting}) under `timer`, with the
 * deadline as `wakeAt`, so a durable driver records the same waiting row it
 * records for a hand-written `DurableClock.sleep`. Replay is the deferred's:
 * once the clock has fired, its result is persisted, so a re-driven round reads
 * it and runs straight through instead of parking a second time.
 *
 * Which clock a wait arms is the dispatch's own, read from
 * {@link module:Context.CurrentInvocationKey}: a keyed node already owns an
 * identity that survives replay and separates two identical calls, so the timer
 * inherits it rather than being addressed by the payload it was called with.
 *
 * @since 0.1.0
 */
import type { Crypto } from "@smthrs/crypto";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Action from "../../../src/Action/index.ts";
import type { FlowRuntime } from "./FlowRuntime/FlowRuntime.vibe";
declare const SleepRequestInvalid_base: Schema.Class<SleepRequestInvalid, Schema.TaggedStruct<"@smthrs/flow/SleepRequestInvalid", {
    readonly code: Schema.Literals<readonly ["missing_deadline", "ambiguous_deadline", "invalid_deadline"]>;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A sleep whose payload does not name exactly one deadline.
 *
 * A payload carries a relative `millis` or an absolute `until`, and naming
 * both, or neither, leaves no deadline to arm a clock with. It is a typed
 * failure rather than a defect because the payload of a driven node is
 * assembled from plan values, so an author's mistake is recoverable through
 * `Node.catch` like any other declared failure.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class SleepRequestInvalid extends SleepRequestInvalid_base {
}
/**
 * The tag the sleep declaration is catalogued and resolved under.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const tag = "system/sleep";
/**
 * The declared sleep action: `millis` from now, or an absolute `until`.
 *
 * **When to use**
 *
 * Use it in a body wherever a round has to wait for time to pass —
 * `Sleep.action.call({ millis: 60_000 })` — rather than reaching for
 * `DurableClock.sleep`, which is only callable from a handler and leaves
 * nothing in the plan. A sleep node is keyed, inspectable, and skippable by a
 * branch exactly like an action that does work.
 *
 * Two waits of the same length are two waits: `sleep(1h)` followed by
 * `sleep(1h)` sleeps for two hours, because each call is its own node with its
 * own identity, exactly as two calls of any other declaration are.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const action: Action.Declared<typeof tag, Schema.Struct<{
    readonly millis: Schema.optional<Schema.Number>;
    readonly until: Schema.optional<Schema.Number>;
}>, typeof Schema.Void, typeof SleepRequestInvalid, never>;
/**
 * The sleep implementation: arm the durable clock, park under `timer`, wake.
 *
 * Provide it beside the other action implementation layers a body calls, over
 * the {@link module:Implementations.layerImplementations} table they file
 * themselves in:
 *
 * ```ts
 * Layer.mergeAll(Sleep.layer, Interpreter.layer(Pipeline)).pipe(
 *   Layer.provideMerge(Action.layerImplementations)
 * )
 * ```
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: Layer.Layer<never, never, Crypto.Crypto | FlowRuntime>;
export {};
