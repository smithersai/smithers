/**
 * Pure catch-up policy decisions.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import type { Cron } from "../../../src/Cron.ts";
import type { CatchUp as Policy } from "./Schedule.vibe";
import { TriggerError } from "./TriggerError.vibe";
/**
 * The occurrences a trigger owes since it last fired, bounded by
 * `maxCatchUp` and by the policy named in `Schedule.CatchUp`: `none` owes
 * nothing, `one` owes only the most recent, and `all` owes every missed tick.
 *
 * Every policy answers to `maxCatchUp`, `one` included: a bound of zero says
 * no occurrence may be caught up, so a missed occurrence under `one` is
 * `catch_up_bound_exceeded` exactly as three missed occurrences under `all`
 * are. The bound is validated before any policy branch, so an unusable bound
 * is refused even where the policy owes nothing.
 *
 * @category computation
 * @since 0.1.0
 */
export declare const occurrences: (policy: Policy, maxCatchUp: number, lastFiredAt: Date | undefined, now: Date, cron: Cron) => Effect.Effect<ReadonlyArray<Date>, TriggerError>;
