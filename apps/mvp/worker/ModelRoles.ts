import { type Model, ModelRequest } from "@smthrs/model"
import { HostModel, HostModelUnusable } from "@smthrs/model-host"
import { ConfiguredModel } from "@smthrs/rpc"
import { Config, Effect, Option, Result, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { MODEL_ROLES, type ModelRole } from "../src/features/model/contract.ts"

// Which model answers each role (docs/features/model-endpoint.md#roles): the model an admin set in `model_roles`, read
// on every call, else the deployment's default (`HostModel`, from the `CHAT_MODEL` configuration). The summary role's
// default is its own (`SUMMARY_MODEL`), never the agent's; the coding role's is the agent role's model, a row
// included, so the `todo` run's agent changes only when an admin sets `coding` itself (decision 0033). Changing a role
// needs no deploy.

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
 * The model `role` uses: its `model_roles` row, built with the key the Worker holds, or the deployment default when
 * the role has no row: `SUMMARY_MODEL` for the summary role, the agent role's row for the coding role, else
 * `HostModel`. A row or default this Worker can't use fails with `HostModelUnusable` and the planner's reason
 * (`invalid` for a row that isn't a record, `unconfigured` for a summary role with neither a row nor `SUMMARY_MODEL`,
 * `config` for one that doesn't parse). `summary` is the deployment default captured when the endpoint built.
 */
export const resolve = (role: ModelRole, summary: Result.Result<Option.Option<ModelRecord>, HostModelUnusable>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rowOf = (name: ModelRole) =>
      Effect.map(sql<{ readonly model: unknown }>`SELECT model FROM model_roles WHERE role = ${name}`, ([found]) => found)
    const own = yield* rowOf(role)
    // The coding role answers as the agent role does, its row included, until an admin points it somewhere of its own.
    const row = own === undefined && role === "coding" ? yield* rowOf("agent") : own
    if (row === undefined) {
      // Auxiliary navigation must not silently spend on the main agent model: only its own default answers it.
      if (role === "summary") {
        if (Result.isFailure(summary)) return yield* summary.failure
        const configured = summary.success
        if (Option.isNone(configured)) return yield* new HostModelUnusable({ reason: "unconfigured" })
        return yield* fromRecord("default", configured.value)
      }
      const fallback = yield* HostModel
      return { source: "default", modelId: fallback.modelId, model: fallback.model } satisfies Resolved
    }
    const record = yield* decodeRecord(row.model).pipe(
      Effect.mapError(() => new HostModelUnusable({ reason: "invalid" })),
    )
    return yield* fromRecord("setting", record)
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
