import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import * as Keys from "../SessionSigningKeys.ts"

const payload = { keyId: Schema.String }
const bounded = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000, maxAttempts: 5 })
const unbounded = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 })
const options = { capabilities: ["db:write:session_signing_keys"], modelInvocable: false }
class RotationFailed extends Schema.TaggedError<RotationFailed>()("SessionKeyRotationFailed", { reason: Schema.String }) {}
const Stage = Action.make("auth/StageSigningKeyRow", { ...options, payload, success: Schema.Void, error: RotationFailed, retryPolicy: bounded })
const Promote = Action.make("auth/PromoteSigningKeyRow", { ...options, payload, success: Schema.Array(Schema.String), error: RotationFailed, retryPolicy: bounded })
const Cease = Action.make("auth/CeaseSigningKeyRows", { ...options, payload: { keyIds: Schema.Array(Schema.String) }, success: Schema.Void, error: RotationFailed, retryPolicy: unbounded })
const resetOptions = { capabilities: ["db:write:session_seal_key"], modelInvocable: false }
const ResetSeal = Action.make("auth/ResetSessionSealPin", { ...resetOptions, payload: {}, success: Schema.Void, error: RotationFailed, retryPolicy: bounded })
const emergencyPayload = { keyId: Schema.String, replacementId: Schema.String }
const emergencyOptions = { ...options, capabilities: [...options.capabilities, "db:write:sessions", "db:write:host_sessions", "db:write:github_token_cleanups", "db:write:session_end_receipts"] }
const PrepareEmergency = Action.make("auth/PrepareEmergencyKeyDrop", { ...emergencyOptions, payload: emergencyPayload, success: Schema.Array(Schema.String), error: RotationFailed, retryPolicy: bounded })
const Compromise = Action.make("auth/CompromiseSigningKey", { ...emergencyOptions, payload, success: Schema.Void, error: RotationFailed, retryPolicy: unbounded })
const Retire = Action.make("auth/RetireSigningKeyRow", { ...options, payload, success: Schema.Void, error: RotationFailed, retryPolicy: bounded })

export const StageSigningKey = Flow.make("auth/StageSigningKey", {
  ...options, description: "Stage a configured signing key as a verifier.", payload, success: Schema.Void, error: RotationFailed,
  body: Node.capture({}, request => Stage.call(request)),
})
export const RotateSigningKey = Flow.make("auth/RotateSigningKey", {
  ...options, description: "Promote a configured signing key, then record cessation after its commit.", payload,
  success: Schema.Void, error: RotationFailed,
  body: Node.capture({}, request => Promote.call(request).pipe(
    Node.bindPlanned(Node.capture({}, keyIds => Cease.call({ keyIds }))),
  )),
})
export const RetireSigningKey = Flow.make("auth/RetireSigningKey", {
  ...options, description: "Retire a signing key only after its database-time retention bound.", payload,
  success: Schema.Void, error: RotationFailed, body: Node.capture({}, request => Retire.call(request)),
})

export const ResetSealKey = Flow.make("auth/ResetSealKey", {
  ...resetOptions, description: "Clear a lost session seal pin after the operator confirms sign-out.", payload: {},
  success: Schema.Void, error: RotationFailed, body: Node.capture({}, () => ResetSeal.call({})),
})

export const EmergencyDropSigningKey = Flow.make("auth/EmergencyDropSigningKey", {
  ...emergencyOptions, description: "Promote a replacement, record cessation, then fence and end a compromised key's sessions.",
  payload: emergencyPayload, success: Schema.Void, error: RotationFailed,
  body: Node.capture({}, request => PrepareEmergency.call(request).pipe(
    Node.bindPlanned(Node.capture({}, keyIds => Cease.call({ keyIds }))),
    Node.andThen(Compromise.call({ keyId: request.keyId })),
  )),
})

/** The operator's database credential is the authority; these flows are not registered on the app's public host. */
export const registration = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, secrets: Keys.Secrets) => {
  const run = <A, E2>(effect: Effect.Effect<A, E2, SqlClient.SqlClient>) => effect.pipe(
    Effect.provide(database), Effect.mapError(error => new RotationFailed({
      reason: error instanceof Keys.RotationRefused ? error.reason : "database",
    })),
  )
  const configured = (keyId: string) => Object.hasOwn(secrets, keyId) ? Effect.void
    : Effect.fail(new RotationFailed({ reason: "unknown_key" }))
  const implementations = Layer.mergeAll(
    PrepareEmergency.toLayer(({ keyId, replacementId }) => Effect.andThen(configured(replacementId),
      run(Keys.prepareEmergency(keyId, replacementId, secrets[replacementId]!)))),
    Compromise.toLayer(({ keyId }) => run(Keys.compromise(keyId))),
    Stage.toLayer(({ keyId }) => Effect.andThen(configured(keyId), run(Keys.stage(keyId, secrets[keyId]!)))),
    Promote.toLayer(({ keyId }) => Effect.andThen(configured(keyId), run(Keys.promote(keyId)))),
    Cease.toLayer(({ keyIds }) => run(Effect.asVoid(Effect.forEach(keyIds, id => Keys.cease(id))))),
    ResetSeal.toLayer(() => run(Keys.resetSeal())),
    Retire.toLayer(({ keyId }) => run(Keys.retire(keyId))),
  )
  return Layer.mergeAll(
    Interpreter.layerWithImplementations(EmergencyDropSigningKey, implementations),
    Interpreter.layerWithImplementations(StageSigningKey, implementations),
    Interpreter.layerWithImplementations(ResetSealKey, implementations),
    Interpreter.layerWithImplementations(RotateSigningKey, implementations),
    Interpreter.layerWithImplementations(RetireSigningKey, implementations),
  ).pipe(Layer.provideMerge(Action.layerImplementations))
}
