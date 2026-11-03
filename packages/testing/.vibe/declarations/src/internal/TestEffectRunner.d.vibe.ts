/**
 * Runs one layered Effect body behind the Vitest cancellation boundary.
 *
 * This module is internal: `./internal/*` is null-mapped in the export map and
 * carries no compatibility promise.
 *
 * @since 0.0.0
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
/**
 * An Effect test body supplied directly or through a lazy callback.
 *
 * @private
 * @since 0.0.0
 */
export type Body<A, E, R> = Effect.Effect<A, E, R> | (() => Effect.Effect<A, E, R>);
/**
 * Runs one layered body and converts signal abortion to fiber interruption.
 *
 * @private
 * @since 0.0.0
 */
export declare const runEffectTest: <R, E, A, E2>(layer: Layer.Layer<R, E>, base: Layer.Layer<never>, body: Body<A, E2, R | Scope.Scope>, signal: AbortSignal) => Promise<A>;
