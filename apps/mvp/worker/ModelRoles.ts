import { type Model, ModelRequest } from "@smthrs/model"
import { HostModel, HostModelUnusable } from "@smthrs/model-host"
import { ConfiguredModel } from "@smthrs/rpc"
import { Config, Effect, Option, Result, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { MODEL_ROLES, type ModelRole, type ModelTier } from "../src/features/model/contract.ts"

// Which of the deployment's models answers each role (docs/features/model-endpoint.md#roles): the model an admin set
// in `model_roles`, read on every call, else the deployment's defaults. The summary role's own default comes first
// (`SUMMARY_MODEL`), then the role's tier's (`TIER_MODELS`, decision 0107), then the row of the role it inherits from:
// the agent role's for `coding` (decision 0033) and `plan`, the judge role's for `review`, so a new role answers as it
// did before it had a name; then `HostModel` (the `CHAT_MODEL` configuration), never for the summary role. Changing a
// role needs no deploy.

/** One of the model roles, as a schema. */
export const Role = Schema.Literals(MODEL_ROLES)

const nonEmpty = Schema.String.check(Schema.isMinLength(1))

/**
 * Fields the role's model adds to every request body it sends, beside the protocol's own: a gateway's routing
 * preferences, such as `{ "providerOptions": { "gateway": { "order": ["cerebras"] } } }` on the Vercel AI Gateway.
 * `@smthrs/rpc`'s `ModelExtraBodySchema`: a JSON object of at most 2 KiB, no field named for a credential.
 */
export const ExtraBody = Schema.Record(Schema.String, Schema.Json).check(
  Schema.makeFilter((value) => ConfiguredModel.ModelExtraBodySchema.safeParse(value).success),
)

/**
 * The model a role uses: a configured-model record (`@smthrs/rpc` ConfiguredModel) without its name, and how the role
 * calls it. `credential` names the key the Worker holds, never the key itself.
 */
export const ModelRecord = Schema.Struct({
  protocol: nonEmpty,
  baseUrl: Schema.optional(nonEmpty),
  path: Schema.optional(nonEmpty),
  modelId: nonEmpty,
  credential: nonEmpty,
  extraBody: Schema.optional(ExtraBody),
  /**
   * How hard the role's model thinks before it answers, set on every call it serves: `none` or `minimal` for a role
   * that only labels or judges, such as `summary` and `judge`, whose default reasoning spent up to 1,300 output tokens
   * on a 170-token entry on 2026-10-25. Absent, the caller's request decides.
   */
  reasoningEffort: Schema.optional(ModelRequest.ReasoningEffort),
})

/** The decoded form of {@link ModelRecord}. */
export type ModelRecord = typeof ModelRecord.Type

/** The record the host's planner reads: the model, without how the role calls it. */
const hostRecord = ({ protocol, baseUrl, path, modelId, credential, extraBody }: ModelRecord) => ({
  protocol,
  modelId,
  credential,
  ...(baseUrl === undefined ? {} : { baseUrl }),
  ...(path === undefined ? {} : { path }),
  ...(extraBody === undefined ? {} : { extraBody }),
})

/**
 * The deployment's default model when `CHAT_MODEL` is unset: ChatApi's, and the agent evals' (evals/agent.eval.ts).
 */
export const DEFAULT_CHAT_MODEL: ModelRecord = {
  protocol: "openai-chat",
  baseUrl: "https://api.cerebras.ai",
  modelId: "qwen-3.8-27b",
  credential: "CEREBRAS_API_KEY",
}

/**
 * `TIER_MODELS`: a JSON object of tiers to model records, the deployment's model for each tier it names, such as a cheap
 * model for `fast`. Read once when the endpoint builds; unset, no tier has one.
 */
export const TierModels = Schema.Struct({
  fast: Schema.optional(ModelRecord),
  implement: Schema.optional(ModelRecord),
  hard: Schema.optional(ModelRecord),
})

/** The decoded form of {@link TierModels}. */
export type TierModels = typeof TierModels.Type

/** `TIER_MODELS` as {@link TierModels}; none when unset. */
export const tierModels = Config.option(Config.schema(Schema.fromJsonString(TierModels), "TIER_MODELS"))

/** The role whose row a role without its own answers with, after its tier's model: the role it was before it had a name. */
const INHERITS: Partial<Record<ModelRole, ModelRole>> = { coding: "agent", plan: "agent", review: "judge" }

/** The deployment's defaults the endpoint captured when it built, each kept as a failure when it doesn't parse. */
export interface Defaults {
  readonly summary: Result.Result<Option.Option<ModelRecord>, HostModelUnusable>
  readonly tiers: Result.Result<Option.Option<TierModels>, HostModelUnusable>
}

/** The model that answers a role now, where the choice came from, and the effort its record sets on each call. */
export interface Resolved {
  readonly source: "setting" | "default"
  readonly modelId: string
  readonly model: Model.Model
  /** The role record's reasoning effort, which the endpoint sets on the call; absent, the request's stands. */
  readonly reasoningEffort?: ModelRequest.ReasoningEffort | undefined
}

const decodeRecord = Schema.decodeUnknownEffect(ModelRecord)

/**
 * The summary role's model when no admin set one: `SUMMARY_MODEL`, a model record as JSON, such as a cheap model for
 * the timeline's summaries. Read once when the endpoint builds; unset, the role has no model.
 */
export const summaryModel = Config.option(Config.schema(Schema.fromJsonString(ModelRecord), "SUMMARY_MODEL"))

/** A role's record as the role resolves it: built with the key the Worker holds, and the effort it sets. */
const fromRecord = (source: Resolved["source"], record: ModelRecord) =>
  Effect.map(HostModel.make(hostRecord(record)), (built): Resolved => ({
    source,
    modelId: built.modelId,
    model: built.model,
    ...(record.reasoningEffort === undefined ? {} : { reasoningEffort: record.reasoningEffort }),
  }))

/**
 * The model `role` uses, on `tier`: its `model_roles` row, built with the key the Worker holds; else `SUMMARY_MODEL` for
 * the summary role; else the tier's `TIER_MODELS` record; else the row of the role it inherits from (`INHERITS`); else
 * `HostModel`, except for the summary role. A row or default this Worker can't use fails with `HostModelUnusable` and
 * the planner's reason (`invalid` for a row that isn't a record, `unconfigured` for a summary role with nothing to
 * answer it, `config` for a default that doesn't parse). `defaults` are those captured when the endpoint built.
 */
export const resolve = (role: ModelRole, tier: ModelTier, defaults: Defaults) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rowOf = (name: ModelRole) =>
      Effect.map(sql<{ readonly model: unknown }>`SELECT model FROM model_roles WHERE role = ${name}`, ([found]) => found)
    const setting = (row: { readonly model: unknown }) =>
      decodeRecord(row.model).pipe(
        Effect.mapError(() => new HostModelUnusable({ reason: "invalid" })),
        Effect.flatMap((record) => fromRecord("setting", record)),
      )
    const own = yield* rowOf(role)
    if (own !== undefined) return yield* setting(own)
    if (role === "summary") {
      if (Result.isFailure(defaults.summary)) return yield* defaults.summary.failure
      if (Option.isSome(defaults.summary.success)) return yield* fromRecord("default", defaults.summary.success.value)
    }
    if (Result.isFailure(defaults.tiers)) return yield* defaults.tiers.failure
    const tiered = Option.flatMap(defaults.tiers.success, (tiers) => Option.fromNullishOr(tiers[tier]))
    if (Option.isSome(tiered)) return yield* fromRecord("default", tiered.value)
    const parent = INHERITS[role]
    const inherited = parent === undefined ? undefined : yield* rowOf(parent)
    if (inherited !== undefined) return yield* setting(inherited)
    // Auxiliary navigation must not silently spend on the main agent model: only its own defaults answer it.
    if (role === "summary") return yield* new HostModelUnusable({ reason: "unconfigured" })
    const fallback = yield* HostModel
    return { source: "default", modelId: fallback.modelId, model: fallback.model } satisfies Resolved
  })

/**
 * Sets `role`'s model and records the change, in one transaction. `invocationKey` names the step that made the change,
 * so a replayed step changes neither the setting nor its audit history.
 */
export const set = (
  change: { readonly role: ModelRole; readonly model: ModelRecord },
  by: { readonly actorId: string; readonly invocationKey: string },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const model = JSON.stringify(change.model)
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const inserted = yield* sql`
          INSERT INTO model_role_changes (invocation_key, role, model, changed_by)
          VALUES (${by.invocationKey}, ${change.role}, ${model}::jsonb, ${by.actorId})
          ON CONFLICT (invocation_key) DO NOTHING
          RETURNING invocation_key`
        if (inserted.length === 0) return
        yield* sql`
          INSERT INTO model_roles (role, model, updated_by, updated_at)
          VALUES (${change.role}, ${model}::jsonb, ${by.actorId}, now())
          ON CONFLICT (role) DO UPDATE SET model = EXCLUDED.model, updated_by = EXCLUDED.updated_by,
            updated_at = EXCLUDED.updated_at`
      }),
    )
  })
