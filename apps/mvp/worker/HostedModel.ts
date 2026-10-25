import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Config, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { type Actor, CurrentActor } from "./Actor.ts"
import { codeOf } from "./ErrorCode.ts"
import { NoInvocationKey, NotAllowed } from "./SetModel.ts"

// Hosted inference (docs/features/model-endpoint.md#hosted-inference, decision 0099): whether the deployment's own model
// answers anyone. Will, 2026-10-25 13:28 PDT: "Please get it working with byok prioritize byok over our hosted
// inference our hosted cerebras inference is now a wip feature flagged and not being released or documented until
// post initial release". Off, a person's own model answers every call they cause, and a person without one is told to
// add it; nobody's work is skipped. The Admin's setting is the `hosted_model` row, read on every call, so a change
// needs no deploy; without a row, the Worker's `HOSTED_MODEL_ENABLED` decides.

/**
 * `HOSTED_MODEL_ENABLED`: whether the deployment's model answers when no Admin set it. Unset, `fallback`: off for a
 * deploy, on under `alchemy dev` (worker/DevChatApi.ts), so a laptop and the scripted end-to-end tests answer.
 */
export const hostedModelDefault = (fallback = false) =>
  Config.Boolean("HOSTED_MODEL_ENABLED").pipe(Config.withDefault(fallback))

/** Whether the deployment's model answers now: the Admin's `hosted_model` row, else `fallback` (the Worker's default). */
export const enabled = (fallback: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly enabled: boolean }>`SELECT enabled FROM hosted_model`
    return row === undefined ? fallback : row.enabled
  })

/**
 * Sets whether the deployment's model answers, and records the change, in one transaction. `invocationKey` names the
 * step that made the change, so a replayed step changes neither the setting nor its audit.
 */
export const set = (on: boolean, by: { readonly actorId: string; readonly invocationKey: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const inserted = yield* sql`
          INSERT INTO hosted_model_changes (invocation_key, enabled, changed_by)
          VALUES (${by.invocationKey}, ${on}, ${by.actorId})
          ON CONFLICT (invocation_key) DO NOTHING
          RETURNING invocation_key`
        if (inserted.length === 0) return
        yield* sql`
          INSERT INTO hosted_model (id, enabled, updated_by, updated_at) VALUES (true, ${on}, ${by.actorId}, now())
          ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by,
            updated_at = EXCLUDED.updated_at`
      }),
    )
  })

const payload = { enabled: Schema.Boolean }
const Changed = Schema.Struct({ enabled: Schema.Boolean })

/** The step: authorize the actor, then write the setting and its record. */
export const WriteHostedModel = Action.make("admin/WriteHostedModel", {
  payload,
  success: Changed,
  error: NotAllowed,
  capabilities: ["db:write:hosted_model"],
})

/** `admin/SetHostedModel`: turns the deployment's own model on or off for everyone; an Admin acting in person only. */
export const SetHostedModel = Flow.make("admin/SetHostedModel", {
  description: "Turn the deployment's own model on or off for everyone; an Admin acting in person only.",
  capabilities: ["db:write:hosted_model"],
  modelInvocable: false,
  payload,
  success: Changed,
  error: NotAllowed,
  body: Node.capture({}, (change) => WriteHostedModel.call(change)),
})

/**
 * What `admin/WriteHostedModel` does for one change, as `actor`, in the step `invocationKey` names, writing through
 * `database`. Only an Admin acting in person may run it (decision 0007), as `admin/SetModel`; it refuses before it
 * writes anything, and a step with no invocation key is a defect, since it couldn't record its change once.
 */
export const write = <E, R>(
  change: { readonly enabled: boolean },
  actor: Actor,
  invocationKey: string | undefined,
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
) =>
  Effect.gen(function* () {
    if (actor.act !== undefined) return yield* new NotAllowed({ reason: "delegated" })
    if (actor.role !== "admin") return yield* new NotAllowed({ reason: "not_admin" })
    if (invocationKey === undefined) return yield* Effect.die(new NoInvocationKey())
    yield* set(change.enabled, { actorId: actor.subject.id, invocationKey }).pipe(
      Effect.provide(database),
      Effect.tapError((error) =>
        Effect.logError("admin.set_hosted_model").pipe(Effect.annotateLogs({ outcome: "error", errorCode: codeOf(error) }))
      ),
      Effect.orDie,
    )
    yield* Effect.logInfo("admin.set_hosted_model").pipe(Effect.annotateLogs({ outcome: "set", enabled: change.enabled }))
    return { enabled: change.enabled }
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("admin.set_hosted_model").pipe(Effect.annotateLogs({ outcome: "refused", reason: error.reason }))
    ),
    Effect.withSpan("admin.set_hosted_model"),
  )

/** Registers `admin/SetHostedModel` with its step, writing through `database` as the `CurrentActor` the host provides. */
export const registration = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Interpreter.layerWithImplementations(
    SetHostedModel,
    WriteHostedModel.toLayer((change) =>
      Effect.gen(function* () {
        return yield* write(change, yield* CurrentActor, yield* Action.CurrentInvocationKey, database)
      })
    ),
  ).pipe(Layer.provideMerge(Action.layerImplementations))
