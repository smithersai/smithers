import * as WriteAuthority from "../WriteAuthority.ts"
import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node, type Planned } from "@smthrs/plan"
import { Clock, type Config, Effect, Layer, Metric, Option, Redacted, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { CONNECTION_KINDS, PROTOCOLS } from "../../src/features/personal-model/contract.ts"
import { codeOf } from "../ErrorCode.ts"
import { SecretKeys } from "../secrets/Keys.ts"
import * as Codex from "./Codex.ts"
import * as Store from "./Store.ts"

// `model/Put` and `model/Delete` (decisions 0096, 0107 and 0132, docs/features/personal-model.md#saving): a person saves
// or removes their own connections. The route admits the write and seals each credential typed before it starts the flow, so the payload, and with it the journal, holds only ciphertext. Each flow is one durable step that writes the row and records the change once,
// under its invocation key. They run on any host; the deployment runs them on the Cloudflare host (`FlowExecution`).

/** Postgres couldn't record the write. Retried. */
export class StoreUnavailable extends Schema.TaggedError<StoreUnavailable>()(
  "@smthrs/mvp/personal/StoreUnavailable",
  {},
) {}

/** The step couldn't tell which step it is, so it couldn't record its change once. */
export class NoInvocationKey extends Schema.TaggedError<NoInvocationKey>()("@smthrs/mvp/personal/NoInvocationKey", {}) {}

/** Writes, by `op` (`put`, `delete`) and `change` (`set`, `replace`, `stale`, `deleted`, `missing`, `repeat`). */
export const writes = Metric.counter("smithers_personal_model_writes", {
  description: "Personal model saves and removals, by op and change",
  incremental: true,
})

/** Recording: 1 s doubling to a minute, for at most 30 minutes, while Postgres is unreachable. */
export const STORE_RETRY = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000, expirationMs: 30 * 60_000 })

const Models = Schema.Struct({
  fast: Schema.optional(Schema.String),
  implement: Schema.optional(Schema.String),
  hard: Schema.optional(Schema.String),
})

/** A connection the save keeps: sealed when the person typed its credential again, else the saved one stays. */
const ConnectionWrite = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(CONNECTION_KINDS),
  active: Schema.Boolean,
  protocol: Schema.NullOr(Schema.Literals(PROTOCOLS)),
  baseUrl: Schema.NullOr(Schema.String),
  models: Models,
  sealed: Schema.optional(Schema.Struct({
    ciphertext: Schema.String,
    nonce: Schema.String,
    keyVersion: Schema.Int,
    keyLast4: Schema.String,
  })),
})

const decodeDevice = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ deviceAuthId: Schema.String, userCode: Schema.String })),
)

const putPayload = {
  authority: WriteAuthority.Admission,
  personId: Schema.String,
  connections: Schema.Array(ConnectionWrite),
  known: Schema.optional(Schema.Array(Schema.String)),
}

const deletePayload = { authority: WriteAuthority.Admission, personId: Schema.String }

/** Writes the connections, and records `set` or `replace`. */
export const Store_ = Action.make("model/Store", {
  payload: putPayload,
  success: Schema.Struct({ change: Schema.Literals(["set", "replace", "repeat", "stale"]) }),
  error: StoreUnavailable,
  capabilities: ["db:write:personal_models"],
  retryPolicy: STORE_RETRY,
})

/** Deletes the model and records `delete`. */
export const Erase = Action.make("model/Erase", {
  payload: deletePayload,
  success: Schema.Struct({ change: Schema.Literals(["deleted", "missing", "repeat", "stale"]) }),
  error: StoreUnavailable,
  capabilities: ["db:write:personal_models"],
  retryPolicy: STORE_RETRY,
})

/** `model/Put`: saves or replaces a person's own connections, sealed, in their order. */
export const Put = Flow.make("model/Put", {
  description: "Save or replace a person's own connections, sealed; the person acting in person only.",
  capabilities: ["db:write:personal_models"],
  modelInvocable: false,
  payload: putPayload,
  success: Store_.successSchema,
  error: StoreUnavailable,
  body: Node.capture({ store: Store_.name }, (write) => Store_.call(write)),
})

/** `model/Delete`: removes a person's own connections, so the deployment's model answers them again. */
export const Delete = Flow.make("model/Delete", {
  description: "Remove a person's own connections, so the deployment's model answers them again.",
  capabilities: ["db:write:personal_models"],
  modelInvocable: false,
  payload: deletePayload,
  success: Erase.successSchema,
  error: StoreUnavailable,
  body: Node.capture({ erase: Erase.name }, (write) => Erase.call(write)),
})

/** Where a device link stands while the person hasn't typed the code. Retried on the code's own clock. */
export class LinkPending extends Schema.TaggedError<LinkPending>()("@smthrs/mvp/personal/LinkPending", {}) {}

/** OpenAI refused the link for good, by its status: the person starts again. */
export class LinkRefused extends Schema.TaggedError<LinkRefused>()("@smthrs/mvp/personal/LinkRefused", {
  status: Schema.NullOr(Schema.Number),
}) {}

/** Polling a device code: every 5 seconds for its 15 minutes, as `codex login --device-auth` does. A refusal ends it. */
export const LINK_RETRY = RetryPolicy.make({
  initialMs: 5_000,
  factor: 1,
  maxMs: 5_000,
  expirationMs: 15 * 60_000,
  nonRetryable: ["@smthrs/mvp/personal/LinkRefused"],
})

const linkPayload = {
  authority: WriteAuthority.Admission,
  generation: Schema.optional(Schema.String),
  personId: Schema.String,
  /** The new connection's id, chosen by the route, so a replay writes one row. */
  id: Schema.String,
  /** The device code, sealed: `{ deviceAuthId, userCode }`. */
  ciphertext: Schema.String,
  nonce: Schema.String,
  keyVersion: Schema.Int,
}

/** The credential OpenAI issued, sealed: what `model/CodexPoll` journals. */
const SealedCredential = Schema.Struct({
  ciphertext: Schema.String,
  nonce: Schema.String,
  keyVersion: Schema.Int,
  keyLast4: Schema.String,
})

/**
 * Polls the device code and seals the credential once approved. Its own step, since OpenAI's code works once: a store
 * that fails after it retries from the journaled seal, never exchanging the code again.
 */
export const Poll = Action.make("model/CodexPoll", {
  payload: linkPayload,
  success: SealedCredential,
  error: Schema.Union([LinkPending, LinkRefused]),
  capabilities: ["network:auth.openai.com"],
  retryPolicy: LINK_RETRY,
})

/** Puts the sealed credential on the person's list, once. */
export const Keep = Action.make("model/CodexKeep", {
  payload: { authority: WriteAuthority.Admission, personId: Schema.String, id: Schema.String, generation: Schema.optional(Schema.String), sealed: SealedCredential },
  success: Schema.Struct({ change: Schema.Literals(["set", "replace", "repeat", "stale"]) }),
  error: StoreUnavailable,
  capabilities: ["db:write:personal_models"],
  retryPolicy: STORE_RETRY,
})

/** `model/CodexLink`: one device-code sign-in, from the code the person was shown to their sealed credential. */
export const CodexLink = Flow.make("model/CodexLink", {
  description: "Link a person's Codex subscription once they approve its device code at OpenAI.",
  capabilities: ["db:write:personal_models", "network:auth.openai.com"],
  modelInvocable: false,
  payload: linkPayload,
  success: Keep.successSchema,
  error: Schema.Union([LinkPending, LinkRefused, StoreUnavailable]),
  body: Node.capture({ poll: Poll.name, keep: Keep.name }, (write) =>
    Poll.call(write).pipe(
      Node.bindPlanned(Node.capture({ keep: Keep.name }, (sealed: Planned.Planned<typeof SealedCredential.Type>) =>
        Keep.call({ authority: write.authority, personId: write.personId, id: write.id, generation: write.generation, sealed }))),
    )),
})

/** Every outcome as one record: a count, a log line and a span, carrying the op and the change, never the person's model. */
const recorded = <A extends { readonly change: string }, E, R>(
  op: "put" | "delete" | "link",
  effect: Effect.Effect<A, E, R>,
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
      if (write.authority === undefined) return { change: "stale" as const }
      const change = yield* Store.put({
        authority: write.authority,
        personId: write.personId,
        connections: write.connections,
        known: write.known,
        invocationKey: key,
      }).pipe(Effect.provide(database), Effect.catch(unavailable))
      return { change }
    }).pipe((effect) => recorded("put", effect))

  const erase = (write: typeof Erase.payloadSchema.Type) =>
    Effect.gen(function* () {
      const key = yield* invocationKey
      if (write.authority === undefined) return { change: "stale" as const }
      const change = yield* Store.remove({ authority: write.authority, personId: write.personId, invocationKey: key }).pipe(
        Effect.provide(database),
        Effect.catch(unavailable),
      )
      return { change }
    }).pipe((effect) => recorded("delete", effect))

  return { store, erase }
}

/** The link's polling step, opening and sealing under `SecretKeys`. */
export const pollStep = (write: typeof Poll.payloadSchema.Type) =>
    Effect.gen(function* () {
      const keys = yield* SecretKeys
      if (Option.isNone(keys)) return yield* new LinkRefused({ status: null })
      const { cipher, version } = keys.value
      const opened = yield* cipher.open(
        { ciphertext: write.ciphertext, nonce: write.nonce },
        { id: `person:${write.personId}`, name: "model-link", version: write.keyVersion },
      ).pipe(Effect.mapError(() => new LinkRefused({ status: null })))
      const device = yield* decodeDevice(Redacted.value(opened)).pipe(Effect.mapError(() => new LinkRefused({ status: null })))
      const now = yield* Clock.currentTimeMillis
      const credential = yield* Codex.poll(device.deviceAuthId, device.userCode, now).pipe(
        Effect.mapError((failure) =>
          failure.reason === "refused" ? new LinkRefused({ status: failure.status }) : new LinkPending()
        ),
      )
      const sealed = yield* cipher.seal(
        Redacted.make(JSON.stringify(credential)),
        { id: `person:${write.personId}`, name: "model", version },
      ).pipe(Effect.orDie)
      return { ...sealed, keyVersion: version, keyLast4: credential.accountId.slice(-4).padStart(4, "*") }
    })

/** The link's storing step over `database`, recording once under its invocation key. */
export const keepStep = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  (write: typeof Keep.payloadSchema.Type) =>
    Effect.gen(function* () {
      const key = yield* invocationKey
      if (write.authority === undefined) return { change: "stale" as const }
      const change = yield* Store.link({
        authority: write.authority,
        personId: write.personId,
        id: write.id,
        generation: write.generation,
        sealed: write.sealed,
        invocationKey: key,
      }).pipe(Effect.provide(database), Effect.catch(unavailable))
      return { change }
    }).pipe((effect) => recorded("link", effect))

/** What steps holding credentials read: `SecretKeys` and `Codex.CodexAuth`. */
export type Credentials = Layer.Layer<SecretKeys | Codex.CodexAuth>

/**
 * `Credentials` from configuration, read now: run it where a program builds, as a step can't read Config
 * (tests/worker-config.test.ts).
 */
export const captureCredentials: Effect.Effect<Credentials, Config.ConfigError> = Effect.gen(function* () {
  const keys = yield* Effect.service(SecretKeys).pipe(Effect.provide(SecretKeys.layerConfig))
  const codex = yield* Codex.config
  return Layer.merge(Layer.succeed(SecretKeys, keys), Layer.succeed(Codex.CodexAuth, codex))
})

/** Registers `model/Put`, `model/Delete` and `model/CodexLink` with their steps over `database`, under `credentials`. */
export const registration = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, credentials: Credentials) => {
  const implementation = steps(database)
  return Layer.mergeAll(
    Interpreter.layerWithImplementations(Put, Store_.toLayer(implementation.store)),
    Interpreter.layerWithImplementations(Delete, Erase.toLayer(implementation.erase)),
    Interpreter.layerWithImplementations(CodexLink, Layer.merge(Poll.toLayer(pollStep), Keep.toLayer(keepStep(database)))),
  ).pipe(Layer.provide(credentials), Layer.provideMerge(Action.layerImplementations))
}
