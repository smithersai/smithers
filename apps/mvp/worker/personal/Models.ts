import { type Model, ModelError } from "@smthrs/model"
import { toModel } from "@smthrs/model-host"
import { ConfiguredModel } from "@smthrs/rpc"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import type { SqlClient } from "effect/sql"
import { hostOf } from "../../src/features/personal-model/contract.ts"
import { codeOf } from "../ErrorCode.ts"
import { SecretKeys } from "../secrets/Keys.ts"
import * as Store from "./Store.ts"

// A person's own model, opened for one call (decision 0096, docs/features/personal-model.md#answering). The model
// endpoint asks for it before every call: a person who saved one is answered by it, with their key, and never by the
// deployment's model. The key opens in memory for that call only, and goes only to the saved base URL's origin: the
// planner pins it there, and the provider transport refuses redirects (`@smthrs/model-host`'s `toModel`).

/** The credential name a person's key is planned under. A name only: the planner never reads a value by it. */
export const CREDENTIAL = "PERSONAL_MODEL_KEY"

/** The authenticated context a person's key is sealed under: the person and the key's version, so it opens on no other row. */
export const sealContext = (personId: string, version: number) => ({ id: `person:${personId}`, name: "model", version })

/** A person's model, ready for one call: the provider's model id, the model, and the provider's host for failures. */
export interface Opened {
  readonly modelId: string
  readonly model: Model.Model
  readonly host: string
}

/**
 * A person's saved model that can't answer here: `off` (no SECRETS_KEY), `key` (the sealed key doesn't open under this
 * deployment's key), or the planner's failure code; and the host it names. It never carries the key.
 */
export class PersonalModelUnusable extends Schema.TaggedError<PersonalModelUnusable>()(
  "@smthrs/mvp/personal/PersonalModelUnusable",
  { reason: Schema.String, host: Schema.String },
) {}

/** Postgres couldn't say whether the person saved a model: `errorCode` is why, by code (worker/ErrorCode.ts). */
export class PersonalModelsUnavailable extends Schema.TaggedError<PersonalModelsUnavailable>()(
  "@smthrs/mvp/personal/PersonalModelsUnavailable",
  { errorCode: Schema.String },
) {}

/**
 * A refusal of the person's own key as final: its retry hints dropped, so no step waits out a key that was refused or
 * ran out (`isTerminalRefusal` in `@smthrs/model`). A plain rate limit keeps its hints: it passes.
 */
export const final = (error: ModelError.ModelError): ModelError.ModelError =>
  error.code === "quota_exceeded" || error.code === "out_of_credit"
    ? new ModelError.ModelError({
      code: error.code,
      message: error.message,
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    })
    : error

/** A failed call of a person's own model, its key's refusal made final ({@link final}); any other failure unchanged. */
export const finalFailure = (error: Model.ModelFailure): Model.ModelFailure =>
  error instanceof ModelError.ModelError ? final(error) : error

/** Each person's own model, by their subject id. Tests of a call that fails provide a faulty one. */
export class PersonalModels extends Context.Service<
  PersonalModels,
  {
    /** The person's model, opened for one call; none when they saved none. */
    readonly open: (
      personId: string,
    ) => Effect.Effect<Option.Option<Opened>, PersonalModelUnusable | PersonalModelsUnavailable>
  }
>()("@smthrs/mvp/personal/PersonalModels") {
  /** Nobody has a model of their own: every call is the deployment's. */
  static readonly none: Layer.Layer<PersonalModels> = Layer.succeed(
    PersonalModels,
    PersonalModels.of({ open: () => Effect.succeedNone }),
  )

  /**
   * The saved models in `database`, their keys opened under `SecretKeys`. Provider calls go through the injected
   * `FetchHttpClient.Fetch` where the call is opened, else the runtime's fetch.
   */
  static readonly layer = <E, R>(
    database: Layer.Layer<SqlClient.SqlClient, E, R>,
  ): Layer.Layer<PersonalModels, never, SecretKeys | R> =>
    Layer.effect(
      PersonalModels,
      Effect.gen(function* () {
        const keys = yield* SecretKeys
        // What the database layer needs, captured here, so opening a model needs nothing of its caller.
        const context = yield* Effect.context<R>()
        const open = (personId: string) =>
          Effect.gen(function* () {
            const saved = yield* Store.saved(personId).pipe(
              Effect.provide(database),
              Effect.provideContext(context),
              Effect.mapError((error) => new PersonalModelsUnavailable({ errorCode: codeOf(error) })),
            )
            if (Option.isNone(saved)) return Option.none<Opened>()
            const { protocol, baseUrl, modelId, ciphertext, nonce, keyVersion } = saved.value
            const host = hostOf(baseUrl)
            if (Option.isNone(keys)) return yield* new PersonalModelUnusable({ reason: "off", host })
            const key = yield* keys.value.cipher.open({ ciphertext, nonce }, sealContext(personId, keyVersion)).pipe(
              Effect.mapError(() => new PersonalModelUnusable({ reason: "key", host })),
            )
            const planned = ConfiguredModel.planModelBinding(
              { protocol, baseUrl, modelId, credential: CREDENTIAL },
              [{ name: CREDENTIAL, present: true, origins: [new URL(baseUrl).origin] }],
              { kind: "generation" },
            )
            if (!planned.ok) return yield* new PersonalModelUnusable({ reason: planned.failure.code, host })
            // A plan from planModelBinding always routes, so a refusal here is a defect.
            const built = yield* Effect.orDie(toModel(planned.plan, key))
            const model: Model.Model = {
              ...built.model,
              stream: (request) => built.model.stream(request).pipe(Stream.mapError(finalFailure)),
            }
            return Option.some({ modelId: planned.plan.modelId, model, host } satisfies Opened)
          })
        return PersonalModels.of({ open })
      }),
    )
}
