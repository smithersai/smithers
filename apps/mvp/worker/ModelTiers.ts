import { ModelRequest } from "@smthrs/model"
import { Config, Effect, Metric, Schema } from "effect"
import { MODEL_TIERS, type ModelRole } from "../src/features/model/contract.ts"

// Which tier answers each role, and how hard its model thinks (decision 0107, docs/features/model-endpoint.md#tiers).
// The one place a role meets a tier: the model endpoint reads it for a person's own models (`PersonalModels.open`) and
// for the deployment's (`ModelRoles.resolve`). Read once when the endpoint builds.

/**
 * How a role's calls run: the tier that answers them, and the reasoning effort hinted to its model, on a heavy turn and
 * else. A hint reaches only a model that takes an effort ({@link acceptsEffort}).
 */
export const RoleTier = Schema.Struct({
  tier: Schema.Literals(MODEL_TIERS),
  /** The effort every call of the role is hinted to run at; absent, the request's stands. */
  reasoningEffort: Schema.optional(ModelRequest.ReasoningEffort),
  /** The effort a heavy turn (`heavy`) runs at instead; absent, `reasoningEffort`. */
  heavyReasoningEffort: Schema.optional(ModelRequest.ReasoningEffort),
})

/** The decoded form of {@link RoleTier}. */
export type RoleTier = typeof RoleTier.Type

/**
 * The defaults (Will, 2026-10-25): chat, views, Jev's judgments and summaries on the cheap `fast` tier, the judgments
 * and summaries at low effort and chat at high effort once a turn is heavy; the `todo` run's coding on `implement`;
 * plans and reviews on `hard`.
 */
export const ROLE_TIERS: Readonly<Record<ModelRole, RoleTier>> = {
  agent: { tier: "fast", heavyReasoningEffort: "high" },
  renderer: { tier: "fast" },
  judge: { tier: "fast", reasoningEffort: "low" },
  summary: { tier: "fast", reasoningEffort: "low" },
  coding: { tier: "implement" },
  review: { tier: "hard" },
  plan: { tier: "hard" },
}

const Overrides = Schema.Struct({
  agent: Schema.optional(RoleTier),
  renderer: Schema.optional(RoleTier),
  judge: Schema.optional(RoleTier),
  summary: Schema.optional(RoleTier),
  coding: Schema.optional(RoleTier),
  review: Schema.optional(RoleTier),
  plan: Schema.optional(RoleTier),
})

/**
 * `MODEL_ROLE_TIERS`: a JSON object of roles to {@link RoleTier}s, each replacing that role's default, such as
 * `{ "renderer": { "tier": "implement" } }`; unset, {@link ROLE_TIERS}.
 */
export const roleTiers: Config.Config<Readonly<Record<ModelRole, RoleTier>>> = Config.schema(
  Schema.fromJsonString(Overrides),
  "MODEL_ROLE_TIERS",
).pipe(
  Config.map((overrides): Readonly<Record<ModelRole, RoleTier>> => ({ ...ROLE_TIERS, ...overrides })),
  Config.withDefault(ROLE_TIERS),
)

/**
 * Whether a call is a heavy turn: since the person's last message, the agent has used a tool, so it is working through
 * a task rather than answering in conversation.
 */
export const heavy = (request: ModelRequest.ModelRequest): boolean => {
  for (let index = request.messages.length - 1; index >= 0; index--) {
    const { role } = request.messages[index]!
    if (role === "user") return false
    if (role === "tool") return true
  }
  return false
}

/**
 * Model ids that take a reasoning effort, matched after any gateway prefix (`openai/gpt-5` is `gpt-5`): Claude models,
 * whose effort the model package keeps only for those with effort control, and OpenAI-style reasoning models. Data only.
 * Any other model, such as `gpt-4.1-mini`, refuses a call that carries one, so a role's hint never reaches it.
 */
export const EFFORT_MODELS: ReadonlyArray<RegExp> = [/^claude-/i, /^o[1-9](?:-|$)/i, /^gpt-[56]/i, /^gpt-oss/i]

/** Whether the model `modelId` takes a reasoning effort: it matches one of {@link EFFORT_MODELS}. */
export const acceptsEffort = (modelId: string): boolean => {
  const id = modelId.slice(modelId.lastIndexOf("/") + 1)
  return EFFORT_MODELS.some((pattern) => pattern.test(id))
}

/** The effort a role hints for a call: its heavy effort on a heavy turn, else its own; none when it sets none. */
export const hintOf = (route: RoleTier, request: ModelRequest.ModelRequest): ModelRequest.ReasoningEffort | undefined =>
  (heavy(request) ? route.heavyReasoningEffort : undefined) ?? route.reasoningEffort

/**
 * The effort a call runs at: `record`'s (a model record that sets one, which its author chose for that model), else the
 * role's hint when the model `modelId` takes one, else the request's own.
 */
export const effortOf = (
  route: RoleTier,
  request: ModelRequest.ModelRequest,
  modelId: string,
  record?: ModelRequest.ReasoningEffort,
): ModelRequest.ReasoningEffort | undefined => {
  if (record !== undefined) return record
  const hint = hintOf(route, request)
  return (hint !== undefined && acceptsEffort(modelId) ? hint : undefined) ?? request.params.reasoningEffort
}

/** Role effort hints, by `role` and `outcome`: `sent` to a model that takes one, `dropped` for one that doesn't. */
export const effortHints = Metric.counter("smithers_model_effort_hints", {
  description: "Role reasoning-effort hints, by role and whether the model took them",
  incremental: true,
})

/** {@link effortOf} for a call on `role`, counting a hint the role set and no record overrode as sent or dropped. */
export const effortFor = (
  role: ModelRole,
  route: RoleTier,
  request: ModelRequest.ModelRequest,
  modelId: string,
  record?: ModelRequest.ReasoningEffort,
): Effect.Effect<ModelRequest.ReasoningEffort | undefined> => {
  const effort = effortOf(route, request, modelId, record)
  if (record !== undefined || hintOf(route, request) === undefined) return Effect.succeed(effort)
  const outcome = acceptsEffort(modelId) ? "sent" : "dropped"
  return Effect.as(Metric.update(Metric.withAttributes(effortHints, { role, outcome }), 1), effort)
}
