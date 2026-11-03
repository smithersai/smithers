/**
 * update_plan flow declaration and portable handler.
 *
 * A Codex CLI clone of the `update_plan` tool: an optional explanation and a
 * list of plan items, acknowledged with "Plan updated". Pure — no host
 * access; the harness observes plan updates through the journal.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as StdError from "./StdError.vibe";
/**
 * Registry name for the update_plan flow. Matches the Codex CLI tool name.
 *
 * @category identifiers
 * @since 1.0.0
 */
export declare const name = "update_plan";
/**
 * Model-facing description of the update_plan flow. Matches the Codex CLI
 * description.
 *
 * @category descriptions
 * @since 1.0.0
 */
export declare const description: string;
/**
 * Status of one plan step, matching Codex.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const StepStatus: Schema.Literals<readonly ["pending", "in_progress", "completed"]>;
/**
 * The plan itself: steps, at most one of them `in_progress`.
 *
 * The single-in-progress rule is the last line of the Codex description a
 * model reads every frame, so it is enforced here rather than left as prose a
 * decode ignores. A plan naming two running steps is a decode failure at the
 * `plan` path, not a silent acknowledgement.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Plan: Schema.$Array<Schema.Struct<{
    readonly step: Schema.String;
    readonly status: Schema.Literals<readonly ["pending", "in_progress", "completed"]>;
}>>;
/**
 * Input schema for the update_plan flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Input: Schema.Struct<{
    readonly explanation: Schema.optional<Schema.String>;
    readonly plan: Schema.$Array<Schema.Struct<{
        readonly step: Schema.String;
        readonly status: Schema.Literals<readonly ["pending", "in_progress", "completed"]>;
    }>>;
}>;
/**
 * Decoded input accepted by the `update_plan` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type;
/**
 * Output schema for the update_plan flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Output: Schema.Struct<{
    readonly output: Schema.String;
}>;
/**
 * Decoded output returned by the `update_plan` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type;
/**
 * Static effect envelope for the update_plan flow: no reads, no writes.
 *
 * @category effects
 * @since 1.0.0
 */
export declare const effects: import("@smthrs/plan/Effects").Declaration;
/**
 * Narrows the effect envelope for a decoded invocation.
 *
 * The flow touches nothing, so every invocation declares what the static
 * envelope declares.
 *
 * @category effects
 * @since 1.0.0
 */
export declare const effectsFor: (_input: typeof Input.Type) => import("@smthrs/plan/Effects").Declaration;
/**
 * Capabilities required by the update_plan flow: none.
 *
 * @category capabilities
 * @since 1.0.0
 */
export declare const capabilities: ReadonlyArray<string>;
/**
 * Declaration-only update_plan flow.
 *
 * @category flows
 * @since 1.0.0
 */
export declare const flow: {
    readonly name: "update_plan";
    readonly description: string;
    readonly input: Schema.Struct<{
        readonly explanation: Schema.optional<Schema.String>;
        readonly plan: Schema.$Array<Schema.Struct<{
            readonly step: Schema.String;
            readonly status: Schema.Literals<readonly ["pending", "in_progress", "completed"]>;
        }>>;
    }>;
    readonly output: Schema.Struct<{
        readonly output: Schema.String;
    }>;
    readonly capabilities: readonly string[];
    readonly effects: import("@smthrs/plan/Effects").Declaration;
};
/**
 * Acknowledges a plan update with Codex's exact response text.
 *
 * The single-in-progress rule is checked again here. `Plan` refuses it at
 * decode time, but a host that calls this handler directly never decodes, and
 * an invariant enforced in only one of the two entrances is enforced in
 * neither.
 *
 * @category handlers
 * @since 1.0.0
 */
export declare const run: (input: {
    readonly explanation?: string | undefined;
    readonly plan: readonly {
        readonly step: string;
        readonly status: "completed" | "in_progress" | "pending";
    }[];
}) => Effect.Effect<typeof Output.Type, StdError.StdError>;
