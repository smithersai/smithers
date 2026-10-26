import { ModelRequest } from "@smthrs/model"
import { Config, Schema } from "effect"
import { MODEL_TIERS, type ModelRole } from "../src/features/model/contract.ts"

// Which tier answers each role, and how hard its model thinks (decision 0107, docs/features/model-endpoint.md#tiers).
// The one place a role meets a tier: the model endpoint reads it for a person's own models (`PersonalModels.open`) and
// for the deployment's (`ModelRoles.resolve`). Read once when the endpoint builds.

/** How a role's calls run: the tier that answers them, and the reasoning effort set on them, on a heavy turn and else. */
export const RoleTier = Schema.Struct({
  tier: Schema.Literals(MODEL_TIERS),
  /** The effort every call of the role runs at; absent, the request's stands. */
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
 * The effort a call runs at: `record`'s (a model record that sets one), else the role's heavy effort on a heavy turn,
 * else the role's, else the request's own.
 */
export const effortOf = (
  route: RoleTier,
  request: ModelRequest.ModelRequest,
  record?: ModelRequest.ReasoningEffort,
): ModelRequest.ReasoningEffort | undefined =>
  record ?? (heavy(request) ? route.heavyReasoningEffort : undefined) ?? route.reasoningEffort ??
    request.params.reasoningEffort
