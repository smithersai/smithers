// Model roles and tiers shared by settings, server seats and persisted usage.

/**
 * What a model call is for. Each role is answered by the model an admin set for it (`admin/SetModel`), or by the
 * deployment's configured role or tier. `coding` is the `todo` run's seat. `review` and `plan` can inherit the
 * `judge` and `agent` settings, respectively. Historical roles remain readable in usage ledgers.
 */
export const MODEL_ROLES = ["agent", "coding", "renderer", "judge", "summary", "review", "plan"] as const

/** One of {@link MODEL_ROLES}. */
export type ModelRole = (typeof MODEL_ROLES)[number]

/**
 * How strong a model a call needs (decision 0107): `fast` for chat, Jev's judgments, views and summaries; `implement`
 * for the `todo` run's coding agent; `hard` for plans and reviews. Each role maps to one (worker/ModelTiers.ts).
 */
export const MODEL_TIERS = ["fast", "implement", "hard"] as const

/** One of {@link MODEL_TIERS}. */
export type ModelTier = (typeof MODEL_TIERS)[number]

/**
 * The tiers that answer a tier when nothing of its own does, in order, itself first: a strong tier falls back to the
 * other strong one before `fast`, and `fast` to the cheaper strong one. So one model saved answers every tier.
 */
export const TIER_FALLBACKS: Readonly<Record<ModelTier, ReadonlyArray<ModelTier>>> = {
  fast: ["fast", "implement", "hard"],
  implement: ["implement", "hard", "fast"],
  hard: ["hard", "implement", "fast"],
}

/** A quota or credit refusal needs intervention; a plain rate limit can recover with backoff. */
export const quotaRefused = (code: string, httpStatus?: number): boolean =>
  httpStatus === 402 || code === "quota_exceeded" || code === "out_of_credit"
