import * as WriteAuthority from "../WriteAuthority.ts"
import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Binding } from "@smthrs/secrets"
import { Effect, Layer, Metric, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { codeOf } from "../ErrorCode.ts"
import * as Store from "./Store.ts"

// `secret/Put` and `secret/Delete` (decision 0005 §4, docs/features/secrets.md#writing): an Admin's set, replace or
// delete of a repository secret. The route admits the write (signed in, Admin, in person; never an agent) and seals the
// value before it starts the flow, so the payload, and with it the journal, holds only ciphertext. Each flow is one
// durable step that writes the row and records the change once, under its invocation key. They run on any host; the
// deployment runs them on the Cloudflare host because only it holds SECRETS_KEY's database.

/** Postgres couldn't record the write. Retried. */
export class StoreUnavailable extends Schema.TaggedError<StoreUnavailable>()(
  "@smthrs/mvp/secrets/StoreUnavailable",
  {},
) {}

/** The step couldn't tell which step it is, so it couldn't record its change once. */
export class NoInvocationKey extends Schema.TaggedError<NoInvocationKey>()("@smthrs/mvp/secrets/NoInvocationKey", {}) {}

/** Writes, by `op` (`put`, `delete`) and `change` (`set`, `replace`, `deleted`, `missing`, `repeat`). */
export const writes = Metric.counter("smithers_secret_writes", {
  description: "Repository secret writes, by op and change",
  incremental: true,
})

/** Recording: 1 s doubling to a minute, for at most 30 minutes, while Postgres is unreachable. */
export const STORE_RETRY = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000, expirationMs: 30 * 60_000 })

const Sealed = Schema.Struct({ ciphertext: Schema.String, nonce: Schema.String })

const putPayload = {
  authority: WriteAuthority.Admission,
  repoId: Schema.String,
  name: Binding.Name,
  sealed: Sealed,
  keyVersion: Schema.Int,
  hosts: Schema.Array(Binding.Host),
  methods: Schema.optional(Schema.Array(Binding.Method)),
  actorId: Schema.String,
}

const deletePayload = { authority: WriteAuthority.Admission, repoId: Schema.String, name: Binding.Name, actorId: Schema.String }

/** Writes the sealed value and its binding, and records `set` or `replace`. */
export const Store_ = Action.make("secret/Store", {
  payload: putPayload,
  success: Schema.Struct({ change: Schema.Literals(["set", "replace", "repeat", "stale"]) }),
  error: StoreUnavailable,
  capabilities: ["db:write:secrets"],
  retryPolicy: STORE_RETRY,
})

/** Deletes the secret and records `delete`. */
export const Erase = Action.make("secret/Erase", {
  payload: deletePayload,
  success: Schema.Struct({ change: Schema.Literals(["deleted", "missing", "repeat", "stale"]) }),
  error: StoreUnavailable,
  capabilities: ["db:write:secrets"],
  retryPolicy: STORE_RETRY,
})

/** `secret/Put`: sets or replaces a repository secret, sealed, with its hosts and methods. */
export const Put = Flow.make("secret/Put", {
  description: "Set or replace a repository secret's sealed value and its hosts; an Admin acting in person only.",
  capabilities: ["db:write:secrets"],
  modelInvocable: false,
  payload: putPayload,
  success: Store_.successSchema,
  error: StoreUnavailable,
  body: Node.capture({ store: Store_.name }, (write) => Store_.call(write)),
})

/** `secret/Delete`: deletes a repository secret. */
export const Delete = Flow.make("secret/Delete", {
  description: "Delete a repository secret; an Admin acting in person only.",
  capabilities: ["db:write:secrets"],
  modelInvocable: false,
  payload: deletePayload,
  success: Erase.successSchema,
  error: StoreUnavailable,
  body: Node.capture({ erase: Erase.name }, (write) => Erase.call(write)),
})

/** Every outcome as one record: a count, a log line and a span, carrying names and codes, never a value. */
const recorded = <A extends { readonly change: string }, R>(
  op: "put" | "delete",
  write: { readonly repoId: string; readonly name: string },
  effect: Effect.Effect<A, StoreUnavailable, R>,
) =>
  effect.pipe(
    Effect.tap(({ change }) =>
      Effect.andThen(
        Metric.update(Metric.withAttributes(writes, { op, change }), 1),
        Effect.logInfo("secret.write").pipe(Effect.annotateLogs({ op, change, repoId: write.repoId, name: write.name })),
      )
    ),
    Effect.withSpan("secret.write", {
      attributes: { "smithers.secret.op": op, "smithers.repo.id": write.repoId, "smithers.secret.name": write.name },
    }),
  )

/** A database failure as the step's retried failure, recorded by its code. */
const unavailable = (error: unknown) =>
  Effect.andThen(
    Effect.logWarning("secret.write").pipe(Effect.annotateLogs({ outcome: "unavailable", errorCode: codeOf(error) })),
    Effect.fail(new StoreUnavailable()),
  )

/** The steps over `database`, each writing and recording once under its invocation key; none sees a value. */
export const steps = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) => {
  const store = (write: typeof Store_.payloadSchema.Type) =>
    Effect.gen(function* () {
      const invocationKey = yield* Action.CurrentInvocationKey
      if (invocationKey === undefined) return yield* Effect.die(new NoInvocationKey())
      if (write.authority === undefined) return { change: "stale" as const }
      const change = yield* Store.put({
        authority: write.authority,
        repoId: write.repoId,
        name: write.name,
        ciphertext: write.sealed.ciphertext,
        nonce: write.sealed.nonce,
        keyVersion: write.keyVersion,
        hosts: write.hosts,
        methods: write.methods,
        actorId: write.actorId,
        invocationKey,
      }).pipe(Effect.provide(database), Effect.catch(unavailable))
      return { change }
    }).pipe((effect) => recorded("put", write, effect))

  const erase = (write: typeof Erase.payloadSchema.Type) =>
    Effect.gen(function* () {
      const invocationKey = yield* Action.CurrentInvocationKey
      if (invocationKey === undefined) return yield* Effect.die(new NoInvocationKey())
      if (write.authority === undefined) return { change: "stale" as const }
      const change = yield* Store.remove({ ...write, invocationKey }).pipe(
        Effect.provide(database),
        Effect.catch(unavailable),
      )
      return { change }
    }).pipe((effect) => recorded("delete", write, effect))

  return { store, erase }
}

/** Registers `secret/Put` and `secret/Delete` with their steps over `database`. */
export const registration = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) => {
  const implementation = steps(database)
  return Layer.merge(
    Interpreter.layerWithImplementations(Put, Store_.toLayer(implementation.store)),
    Interpreter.layerWithImplementations(Delete, Erase.toLayer(implementation.erase)),
  ).pipe(Layer.provideMerge(Action.layerImplementations))
}
