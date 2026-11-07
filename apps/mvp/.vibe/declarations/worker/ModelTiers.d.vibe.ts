import { ModelRequest } from "@smthrs/model";
import { Config, Effect, Metric, Schema } from "effect";
import { type ModelRole } from "../../../src/features/model/contract.ts";
/**
 * How a role's calls run: the tier that answers them, and the reasoning effort hinted to its model, on a heavy turn and
 * else. A hint reaches only a model that takes an effort ({@link acceptsEffort}).
 */
export declare const RoleTier: Schema.Struct<{
    readonly tier: Schema.Literals<readonly ["fast", "implement", "hard"]>;
    /** The effort every call of the role is hinted to run at; absent, the request's stands. */
    readonly reasoningEffort: Schema.optional<Schema.Literals<readonly ["none", "minimal", "low", "medium", "high", "xhigh", "max"]>>;
    /** The effort a heavy turn (`heavy`) runs at instead; absent, `reasoningEffort`. */
    readonly heavyReasoningEffort: Schema.optional<Schema.Literals<readonly ["none", "minimal", "low", "medium", "high", "xhigh", "max"]>>;
}>;
/** The decoded form of {@link RoleTier}. */
export type RoleTier = typeof RoleTier.Type;
/**
 * The defaults (Will, 2026-10-25): chat, views, Jev's judgments and summaries on the cheap `fast` tier, the judgments
 * and summaries at low effort and chat at high effort once a turn is heavy; the `todo` run's coding on `implement`;
 * plans and reviews on `hard`.
 */
export declare const ROLE_TIERS: Readonly<Record<ModelRole, RoleTier>>;
/**
 * `MODEL_ROLE_TIERS`: a JSON object of roles to {@link RoleTier}s, each replacing that role's default, such as
 * `{ "renderer": { "tier": "implement" } }`; unset, {@link ROLE_TIERS}.
 */
export declare const roleTiers: Config.Config<Readonly<Record<ModelRole, RoleTier>>>;
/**
 * Whether a call is a heavy turn: since the person's last message, the agent has used a tool, so it is working through
 * a task rather than answering in conversation.
 */
export declare const heavy: (request: ModelRequest.ModelRequest) => boolean;
/**
 * Model ids that take a reasoning effort, matched after any gateway prefix (`openai/gpt-5` is `gpt-5`): Claude models,
 * whose effort the model package keeps only for those with effort control, and OpenAI-style reasoning models. Data only.
 * Any other model, such as `gpt-4.1-mini`, refuses a call that carries one, so a role's hint never reaches it.
 */
export declare const EFFORT_MODELS: ReadonlyArray<RegExp>;
/** Whether the model `modelId` takes a reasoning effort: it matches one of {@link EFFORT_MODELS}. */
export declare const acceptsEffort: (modelId: string) => boolean;
/** The effort a role hints for a call: its heavy effort on a heavy turn, else its own; none when it sets none. */
export declare const hintOf: (route: RoleTier, request: ModelRequest.ModelRequest) => ModelRequest.ReasoningEffort | undefined;
/**
 * The effort a call runs at: `record`'s (a model record that sets one, which its author chose for that model), else the
 * role's hint when the model `modelId` takes one, else the request's own.
 */
export declare const effortOf: (route: RoleTier, request: ModelRequest.ModelRequest, modelId: string, record?: ModelRequest.ReasoningEffort) => ModelRequest.ReasoningEffort | undefined;
/** Role effort hints, by `role` and `outcome`: `sent` to a model that takes one, `dropped` for one that doesn't. */
export declare const effortHints: Metric.Counter<number>;
/** {@link effortOf} for a call on `role`, counting a hint the role set and no record overrode as sent or dropped. */
export declare const effortFor: (role: ModelRole, route: RoleTier, request: ModelRequest.ModelRequest, modelId: string, record?: ModelRequest.ReasoningEffort) => Effect.Effect<ModelRequest.ReasoningEffort | undefined>;
