import { finalFailure } from "../ModelRefusal.ts"
import type { Model } from "@smthrs/model"
import { toModel } from "@smthrs/model-host"
import { ConfiguredModel } from "@smthrs/rpc"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import type { SqlClient } from "effect/sql"
import type { ModelTier } from "../../src/features/model/contract.ts"
import { hostOf, type Protocol, resolveTier } from "../../src/features/personal-model/contract.ts"
import { codeOf } from "../ErrorCode.ts"
import { SecretKeys } from "../secrets/Keys.ts"
import * as Store from "./Store.ts"

// A person's own model, opened for one call (decisions 0096 and 0107, docs/features/personal-model.md#answering). The
// model endpoint asks for the tier of the call's role before every call: a person who saved a key is answered by the
// model that tier resolves to among their keys (`resolveTier`), with that key, and never by the deployment's model. The
// key opens in memory for that call only, and goes only to its saved base URL's origin: the planner pins it there, and
// the provider transport refuses redirects (`@smthrs/model-host`'s `toModel`).

/** The credential name a person's key is planned under. A name only: the planner never reads a value by it. */
export const CREDENTIAL = "PERSONAL_MODEL_KEY"

/** The authenticated context a person's key is sealed under: the person and the key's version, so it opens on no other row. */
export const sealContext = (personId: string, version: number) => ({ id: `person:${personId}`, name: "model", version })

/**
 * A person's model, ready for one call: the provider's model id, the model, the provider's host for failures, the key
 * that answers it (by protocol) and the tier that answered, which a fallback makes another than the one asked for.
 */
export interface Opened {
  readonly modelId: string
  readonly model: Model.Model
  readonly host: string
  readonly protocol: Protocol
  readonly tier: ModelTier
}

/**
 * A person's saved model that can't answer here: `off` (no SECRETS_KEY), `key` (the sealed key doesn't open under this
 * deployment's key), `no_model` (no tier resolves to a model among their keys), or the planner's failure code; and the
 * host it names. It never carries the key.
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

/** Each person's own model, by their subject id. Tests of a call that fails provide a faulty one. */
export class PersonalModels extends Context.Service<
  PersonalModels,
  {
    /** The model `tier` resolves to among the person's keys, opened for one call; none when they saved no key. */
    readonly open: (
      personId: string,
      tier: ModelTier,
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
        const open = (personId: string, tier: ModelTier) =>
          Effect.gen(function* () {
            const saved = yield* Store.saved(personId).pipe(
              Effect.provide(database),
              Effect.provideContext(context),
              Effect.mapError((error) => new PersonalModelsUnavailable({ errorCode: codeOf(error) })),
            )
            if (saved.length === 0) return Option.none<Opened>()
            const resolved = resolveTier(saved, tier)
            // A save always leaves some tier a model; only a key whose tiers' models were removed by hand has none.
            if (resolved === undefined) {
              return yield* new PersonalModelUnusable({ reason: "no_model", host: hostOf(saved[0]!.baseUrl) })
            }
            const { protocol, modelId } = resolved
            const { baseUrl, ciphertext, nonce, keyVersion } = saved.find((key) => key.protocol === protocol)!
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
            return Option.some({ modelId: planned.plan.modelId, model, host, protocol, tier: resolved.tier } satisfies Opened)
          })
        return PersonalModels.of({ open })
      }),
    )
}
