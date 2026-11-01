/**
 * Stable trigger failures.
 *
 * @see packages/smithers/agent/triggers/docs/api.md
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
/**
 * Stable trigger failure codes.
 *
 * Each code names one refusal a caller can branch on. `store` covers only a
 * persistence failure the store itself raised; a Control or runner failure is
 * `runner`, a malformed scheduler option is `invalid_options`, and a claim
 * refused by the durable declaration is `unknown_trigger`, `trigger_disabled`,
 * or `revision_mismatch`.
 *
 * @category models
 * @since 0.1.0
 */
export declare const TriggerErrorCode: Schema.Literals<readonly ["unknown_trigger", "trigger_disabled", "revision_mismatch", "stale_owner", "invalid_schedule", "invalid_trigger", "invalid_options", "invalid_cron", "unsatisfiable_cron", "verification_failed", "catch_up_bound_exceeded", "runner", "runner_timeout", "store"]>;
/**
 * Stable trigger failure code.
 *
 * @category models
 * @since 0.1.0
 */
export type TriggerErrorCode = typeof TriggerErrorCode.Type;
declare const TriggerError_base: Schema.Class<TriggerError, Schema.TaggedStruct<"flows/triggers/TriggerError", {
    readonly code: Schema.Literals<readonly ["unknown_trigger", "trigger_disabled", "revision_mismatch", "stale_owner", "invalid_schedule", "invalid_trigger", "invalid_options", "invalid_cron", "unsatisfiable_cron", "verification_failed", "catch_up_bound_exceeded", "runner", "runner_timeout", "store"]>;
    readonly message: Schema.String;
    readonly path: Schema.optional<Schema.String>;
    readonly cause: Schema.optional<Schema.Defect>;
}>, import("effect/Cause").YieldableError>;
/**
 * A typed schedule, verification, or persistence failure.
 *
 * `path` is the dotted field path a declaration failure belongs to, so a
 * caller reads the offending field structurally instead of parsing `message`.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class TriggerError extends TriggerError_base {
}
/**
 * Builds a declaration failure that names the offending field.
 *
 * The whole `SchemaError` is deliberately not kept as the cause: serializing
 * one costs about five kilobytes of schema AST per failure, and every byte of
 * it past the rendered issue tree repeats what the tree already says.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const fromSchemaError: (code: TriggerErrorCode, summary: string, error: unknown) => TriggerError;
export {};
