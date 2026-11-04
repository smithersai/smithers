/**
 * The system wait point, as an ordinary declared action.
 *
 * `docs/concepts/flows-and-actions.md` names wait-for-event the
 * other half of the timer gap and says how to close it: ship it over the
 * existing `DurableDeferred`, so an external signal is a visible, keyed plan
 * node. That is this module. {@link action} is a plain `Action.make`
 * declaration — catalogable, `.call()`-able, one node in the built plan — and
 * {@link layer} is the implementation.
 *
 * Nothing about resolution is new. The wait is a `DurableDeferred`, so whoever
 * satisfies it completes it the way every other durable deferred is completed:
 * a token, and `DurableDeferred.succeed`, `fail`, `failCause`, or `done`.
 * {@link deferred} is how a resolver names the same wait point the action
 * awaits. The park is declared through the ordinary waiting vocabulary
 * ({@link module:WaitingAnnotation.annotateWaiting}) under `event`, carrying
 * that token as the compare-and-swap material a wake handler matches. Replay is
 * the deferred's: once a result is recorded, a re-driven round reads it and
 * runs through instead of parking again.
 *
 * @since 0.1.0
 */
import type { Crypto } from "@smthrs/crypto";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Action from "../../../src/Action/index.ts";
import * as DurableDeferred from "./DurableDeferred.vibe";
import type { FlowRuntime } from "./FlowRuntime/FlowRuntime.vibe";
declare const WaitForRequestInvalid_base: Schema.Class<WaitForRequestInvalid, Schema.TaggedStruct<"@smthrs/flow/WaitForRequestInvalid", {
    readonly code: Schema.Literals<readonly ["missing_target", "ambiguous_target", "malformed_token", "foreign_execution"]>;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A wait whose payload does not name exactly one reachable wait point.
 *
 * A payload names the wait point by `name`, relative to the running execution,
 * or by an absolute `token`. Naming both, or neither, leaves nothing to await;
 * a token that does not parse names nothing either; and a token addressed to a
 * different flow or a different execution names a wait point this execution
 * cannot observe, because a durable deferred result is recorded against the
 * flow and execution that own it.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class WaitForRequestInvalid extends WaitForRequestInvalid_base {
}
/**
 * The tag the wait declaration is catalogued and resolved under.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const tag = "system/wait-for";
/**
 * The durable deferred a named wait point resolves through.
 *
 * This is the resolver's half of {@link action}: the value to hand
 * `DurableDeferred.tokenFromExecutionId` and `DurableDeferred.succeed`, so a
 * wait that a body declared by name is completed through the existing deferred
 * completion path rather than a second one.
 *
 * ```ts
 * const gate = WaitFor.deferred("approval")
 * const token = DurableDeferred.tokenFromExecutionId(gate, { flow, executionId })
 * yield* DurableDeferred.succeed(gate, { token, value: { approved: true } })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const deferred: (name: string) => DurableDeferred.DurableDeferred<typeof Schema.Json>;
/**
 * The declared wait action: a wait point named by `name` or by `token`.
 *
 * **When to use**
 *
 * Use it in a body wherever a round has to wait for something outside the run —
 * an approval, a webhook, a human — `WaitFor.action.call({ name: "approval"
 * })`. The node settles with whatever value resolved the wait, so downstream
 * steps read it the way they read any other step result.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const action: Action.Declared<typeof tag, Schema.Struct<{
    readonly token: Schema.optional<Schema.String>;
    readonly name: Schema.optional<Schema.String>;
}>, typeof Schema.Json, typeof WaitForRequestInvalid, never>;
/**
 * The wait implementation: park under `event` with the wake token, and settle
 * with the value that resolved the wait.
 *
 * Provide it beside the other action implementation layers a body calls, over
 * the {@link module:Implementations.layerImplementations} table they file
 * themselves in:
 *
 * ```ts
 * Layer.mergeAll(WaitFor.layer, Interpreter.layer(Pipeline)).pipe(
 *   Layer.provideMerge(Action.layerImplementations)
 * )
 * ```
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: Layer.Layer<never, never, Crypto.Crypto | FlowRuntime>;
export {};
