import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Metric, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { PROTOCOLS } from "../../src/features/personal-model/contract.ts"
import { codeOf } from "../ErrorCode.ts"
import * as Store from "./Store.ts"

// `model/Put` and `model/Delete` (decision 0096, docs/features/personal-model.md#saving): a person saves or removes
// their own model. The route admits the write and seals the key before it starts the flow, so the payload, and with it
// the journal, holds only ciphertext. Each flow is one durable step that writes the row and records the change once,
// under its invocation key. They run on any host; the deployment runs them on the Cloudflare host (`FlowExecution`).

/** Postgres couldn't record the write. Retried. */
export class StoreUnavailable extends Schema.TaggedError<StoreUnavailable>()(
  "@smthrs/mvp/personal/StoreUnavailable",
  {},
) {}

/** The step couldn't tell which step it is, so it couldn't record its change once. */
export class NoInvocationKey extends Schema.TaggedError<NoInvocationKey>()("@smthrs/mvp/personal/NoInvocationKey", {}) {}

/** Writes, by `op` (`put`, `delete`) and `change` (`set`, `replace`, `deleted`, `missing`, `repeat`). */
export const writes = Metric.counter("smithers_personal_model_writes", {
  description: "Personal model saves and removals, by op and change",
  incremental: true,
})

/** Recording: 1 s doubling to a minute, for at most 30 minutes, while Postgres is unreachable. */
export const STORE_RETRY = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000, expirationMs: 30 * 60_000 })

const putPayload = {
  personId: Schema.String,
  protocol: Schema.Literals(PROTOCOLS),
  baseUrl: Schema.String,
  modelId: Schema.String,
  sealed: Schema.Struct({ ciphertext: Schema.String, nonce: Schema.String }),
  keyVersion: Schema.Int,
  keyLast4: Schema.String,
}

const deletePayload = { personId: Schema.String }

/** Writes the model and its sealed key, and records `set` or `replace`. */
export const Store_ = Action.make("model/Store", {
  payload: putPayload,
  success: Schema.Struct({ change: Schema.Literals(["set", "replace", "repeat"]) }),
  error: StoreUnavailable,
  capabilities: ["db:write:personal_models"],
  retryPolicy: STORE_RETRY,
})

/** Deletes the model and records `delete`. */
export const Erase = Action.make("model/Erase", {
  payload: deletePayload,
  success: Schema.Struct({ change: Schema.Literals(["deleted", "missing", "repeat"]) }),
  error: StoreUnavailable,
  capabilities: ["db:write:personal_models"],
  retryPolicy: STORE_RETRY,
})

/** `model/Put`: saves or replaces a person's own model, its key sealed. */
export const Put = Flow.make("model/Put", {
  description: "Save or replace a person's own model and its sealed key; the person acting in person only.",
  capabilities: ["db:write:personal_models"],
  modelInvocable: false,
  payload: putPayload,
  success: Store_.successSchema,
  error: StoreUnavailable,
  body: Node.capture({ store: Store_.name }, (write) => Store_.call(write)),
})

/** `model/Delete`: removes a person's own model, so the deployment's model answers them again. */
export const Delete = Flow.make("model/Delete", {
  description: "Remove a person's own model, so the deployment's model answers them again.",
  capabilities: ["db:write:personal_models"],
  modelInvocable: false,
  payload: deletePayload,
  success: Erase.successSchema,
  error: StoreUnavailable,
  body: Node.capture({ erase: Erase.name }, (write) => Erase.call(write)),
})

/** Every outcome as one record: a count, a log line and a span, carrying the op and the change, never the person's model. */
const recorded = <A extends { readonly change: string }, R>(
  op: "put" | "delete",
  effect: Effect.Effect<A, StoreUnavailable, R>,
) =>
  effect.pipe(
    Effect.tap(({ change }) =>
      Effect.andThen(
        Metric.update(Metric.withAttributes(writes, { op, change }), 1),
        Effect.logInfo("personal_model.write").pipe(Effect.annotateLogs({ op, change })),
      )
    ),
    Effect.withSpan("personal_model.write", { attributes: { "smithers.personal_model.op": op } }),
  )

/** A database failure as the step's retried failure, recorded by its code. */
const unavailable = (error: unknown) =>
  Effect.andThen(
    Effect.logWarning("personal_model.write").pipe(
      Effect.annotateLogs({ outcome: "unavailable", errorCode: codeOf(error) }),
    ),
    Effect.fail(new StoreUnavailable()),
  )

/** The invocation key of the running step; a step without one is a defect. */
const invocationKey = Effect.flatMap(
  Action.CurrentInvocationKey,
  (key) => key === undefined ? Effect.die(new NoInvocationKey()) : Effect.succeed(key),
)

/** The steps over `database`, each writing and recording once under its invocation key; none sees a key. */
export const steps = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) => {
  const store = (write: typeof Store_.payloadSchema.Type) =>
    Effect.gen(function* () {
      const key = yield* invocationKey
      const change = yield* Store.put({
        personId: write.personId,
        protocol: write.protocol,
        baseUrl: write.baseUrl,
        modelId: write.modelId,
        ciphertext: write.sealed.ciphertext,
        nonce: write.sealed.nonce,
        keyVersion: write.keyVersion,
        keyLast4: write.keyLast4,
        invocationKey: key,
      }).pipe(Effect.provide(database), Effect.catch(unavailable))
      return { change }
    }).pipe((effect) => recorded("put", effect))

  const erase = (write: typeof Erase.payloadSchema.Type) =>
    Effect.gen(function* () {
      const key = yield* invocationKey
      const change = yield* Store.remove({ personId: write.personId, invocationKey: key }).pipe(
        Effect.provide(database),
        Effect.catch(unavailable),
      )
      return { change }
    }).pipe((effect) => recorded("delete", effect))

  return { store, erase }
}

/** Registers `model/Put` and `model/Delete` with their steps over `database`. */
export const registration = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) => {
  const implementation = steps(database)
  return Layer.merge(
    Interpreter.layerWithImplementations(Put, Store_.toLayer(implementation.store)),
    Interpreter.layerWithImplementations(Delete, Erase.toLayer(implementation.erase)),
  ).pipe(Layer.provideMerge(Action.layerImplementations))
}
