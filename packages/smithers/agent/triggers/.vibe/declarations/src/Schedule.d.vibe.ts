/**
 * Reusable schedule declarations shared by triggers.
 *
 * @see packages/smithers/agent/triggers/docs/api.md
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type TriggerError } from "./TriggerError.vibe";
/**
 * Schedule overlap policies.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Overlap: Schema.Literals<readonly ["skip", "buffer-one", "supersede"]>;
/**
 * Schedule overlap policy.
 *
 * @category models
 * @since 0.1.0
 */
export type Overlap = typeof Overlap.Type;
/**
 * Schedule catch-up policies.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const CatchUp: Schema.Literals<readonly ["none", "one", "all"]>;
/**
 * Schedule catch-up policy.
 *
 * @category models
 * @since 0.1.0
 */
export type CatchUp = typeof CatchUp.Type;
/**
 * The greatest catch-up bound a schedule may declare.
 *
 * A schedule may not owe more occurrences than one occurrence search returns,
 * so the ceiling is the search's own cap.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maxCatchUpLimit = 1000;
/**
 * A reusable cron schedule and its overlap and catch-up policies.
 *
 * All three policy fields are optional. `maxCatchUp` defaults to `0`, which
 * pairs with the `catchUp` default of `none`: a schedule that states no
 * catch-up intent owes nothing after downtime.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Schedule: Schema.Struct<{
    readonly cron: Schema.NonEmptyString;
    readonly timezone: Schema.optional<Schema.NonEmptyString>;
    readonly overlap: Schema.withDecodingDefault<Schema.Literals<readonly ["skip", "buffer-one", "supersede"]>, never>;
    readonly catchUp: Schema.withDecodingDefault<Schema.Literals<readonly ["none", "one", "all"]>, never>;
    readonly maxCatchUp: Schema.withDecodingDefault<Schema.Int, never>;
}>;
/**
 * A reusable cron schedule.
 *
 * @category models
 * @since 0.1.0
 */
export type Schedule = typeof Schedule.Type;
/**
 * Refuses a declaration whose cron expression is malformed or which the
 * calendar never satisfies.
 *
 * The schema types `cron` as a non-empty string, which is as much as a field
 * schema can say: `0 0 30 2 *` passes every range check and matches no date.
 * Only the occurrence search knows that, so every declaration path runs it
 * here rather than leaving it to the tick that would have fired the trigger.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const validate: <A extends {
    readonly cron: string;
    readonly timezone?: string | undefined;
}>(declaration: A) => Effect.Effect<A, TriggerError>;
/**
 * Decodes and validates a schedule declaration.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: (input: unknown) => Effect.Effect<Schedule, TriggerError>;
