import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { type Actor, CurrentActor } from "#vibelang/emitted/worker/Actor"
import { codeOf } from "#vibelang/emitted/worker/ErrorCode"
import * as ModelRoles from "./ModelRoles.ts"

// `admin/SetModel { role, model }` (docs/features/model-endpoint.md#roles): an admin sets which model answers a role.
// The setting is a `model_roles` row, read on every call, so the next call uses it; the change is recorded in
// `model_role_changes`. Only a person with the Admin role, acting in person, may run it: never an agent, flow or
// sandbox acting for them (decision 0004 question 2, decision 0007). The step decides in the same step that writes.
// It runs on any host; the host that starts it provides `CurrentActor`.

/** Why `admin/SetModel` refused: the actor isn't an Admin, or an agent, flow or sandbox is acting for them. */
export class NotAllowed extends Schema.TaggedError<NotAllowed>()("@smthrs/mvp/admin/NotAllowed", {
  reason: Schema.Literals(["not_admin", "delegated"]),
}) {}

/** The flow's step could not tell which step it is, so it could not record its change once. */
export class NoInvocationKey extends Schema.TaggedError<NoInvocationKey>()("@smthrs/mvp/admin/NoInvocationKey", {}) {}

const payload = { role: ModelRoles.Role, model: ModelRoles.ModelRecord }

/** What changed: the role and the model id it now uses. */
const Changed = Schema.Struct({ role: ModelRoles.Role, modelId: Schema.String })

/** The step: authorize the actor, then write the setting and its record. */
export const WriteModel = Action.make("admin/WriteModel", {
  payload,
  success: Changed,
  error: NotAllowed,
  capabilities: ["db:write:model_roles"],
})

/** `admin/SetModel`: sets the model a role uses and records who changed it. */
export const SetModel = Flow.make("admin/SetModel", {
  description: "Set the model a role (agent, coding, renderer, judge or summary) uses; an Admin acting in person only.",
  capabilities: ["db:write:model_roles"],
  modelInvocable: false,
  payload,
  success: Changed,
  error: NotAllowed,
  body: Node.capture({}, (change) => WriteModel.call(change)),
})

/**
 * What `admin/WriteModel` does for one change, as `actor`, in the step `invocationKey` names. Refuses before it
 * writes anything.
 */
export const write = (
  change: { readonly role: typeof ModelRoles.Role.Type; readonly model: ModelRoles.ModelRecord },
  actor: Actor,
  invocationKey: string | undefined,
) =>
  Effect.gen(function* () {
    if (actor.act !== undefined) return yield* new NotAllowed({ reason: "delegated" })
    if (actor.role !== "admin") return yield* new NotAllowed({ reason: "not_admin" })
    if (invocationKey === undefined) return yield* Effect.die(new NoInvocationKey())
    yield* ModelRoles.set(change, { actorId: actor.subject.id, invocationKey })
    return { role: change.role, modelId: change.model.modelId }
  }).pipe(
    Effect.tap(() =>
      Effect.logInfo("admin.set_model").pipe(
        Effect.annotateLogs({ outcome: "set", role: change.role, modelId: change.model.modelId }),
      )
    ),
    Effect.tapError((error) =>
      error instanceof NotAllowed
        ? Effect.logWarning("admin.set_model").pipe(
          Effect.annotateLogs({ outcome: "refused", role: change.role, reason: error.reason }),
        )
        : Effect.logError("admin.set_model").pipe(
          Effect.annotateLogs({ outcome: "error", role: change.role, errorCode: codeOf(error) }),
        )
    ),
    Effect.withSpan("admin.set_model", { attributes: { "smithers.model.role": change.role } }),
  )

/**
 * Registers `admin/SetModel` with its step, writing through `database` as the `CurrentActor` the host provides.
 */
export const registration = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Interpreter.layerWithImplementations(
    SetModel,
    WriteModel.toLayer((change) =>
      Effect.gen(function* () {
        const actor = yield* CurrentActor
        const invocationKey = yield* Action.CurrentInvocationKey
        // A refusal is the step's declared failure; a database failure is a defect that fails the run.
        return yield* write(change, actor, invocationKey).pipe(
          Effect.provide(database),
          Effect.catch((error) => error instanceof NotAllowed ? Effect.fail(error) : Effect.die(error)),
        )
      })
    ),
  ).pipe(Layer.provideMerge(Action.layerImplementations))
