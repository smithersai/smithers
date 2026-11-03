/**
 * Which occurrences one scheduler tick owes a trigger.
 *
 * @since 1.0.0-rc.0
 */
import * as Effect from "effect/Effect";
import type { TriggerError } from "../TriggerError.vibe";
import type { Registered } from "../../../../src/TriggerStore.ts";
/**
 * The occurrences to claim, oldest first, and the watermark that stands once
 * every one of them has been dispatched.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export interface Due {
    readonly occurrences: ReadonlyArray<number>;
    readonly watermark: number;
}
/**
 * Computes what a trigger owes at `now`, given the watermark this process has
 * already dispatched through, or `undefined` on first sight of the trigger.
 *
 * The answer depends on nothing but its arguments. The watermark is the
 * caller's to keep: it only moves forward, and only past occurrences the
 * caller finished dispatching.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export declare const compute: (trigger: Registered, now: number, observed: number | undefined) => Effect.Effect<Due, TriggerError>;
