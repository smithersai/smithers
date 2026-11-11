import { finalFailure } from "../ModelRefusal.ts"
import type { Model } from "@smthrs/model"
import { toModel } from "@smthrs/model-host"
import { ConfiguredModel } from "@smthrs/rpc"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import type { SqlClient } from "effect/sql"
import type { ModelTier } from "../../src/features/model/contract.ts"
import { hostOf, type Protocol, resolveTier } from "../../src/features/personal-model/contract.ts"
import { codeOf } from "#vibelang/emitted/worker/ErrorCode"
import { acceptsEffort } from "#vibelang/emitted/worker/ModelTiers"
import { SecretKeys } from "../secrets/Keys.ts"
import * as Store from "./Store.ts"

// A person's own model, opened for one call (decisions 0096, 0107 and 0132, docs/features/personal-model.md#answering).
// The model endpoint asks for the tier of the call's role before every call: a person with a connection that serves
// models is answered by the model that tier resolves to among them (`resolveTier`), and never by the deployment's. The
// key opens in memory for that call only, and goes only to its saved base URL's origin: the planner pins it there, and
// the provider transport refuses redirects (`@smthrs/model-host`'s `toModel`).

/**
 * The wire protocol a saved key's call speaks. OpenAI's own API answers its reasoning models' function tools only
 * through the Responses API: Chat Completions refuses tools beside a reasoning effort for gpt-6 models, which every
 * agent turn sends. So an OpenAI-compatible key at api.openai.com reaches a model that takes an effort there, with
 * the same key and origin; every other key and model speaks the protocol it was saved under.
 */
export const wireOf = (protocol: Protocol, host: string, modelId: string): ConfiguredModel.ModelProtocol =>
  protocol === "openai-chat" && host === "api.openai.com" && acceptsEffort(modelId) ? "openai-responses" : protocol

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
  readonly connectionId: string
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
    /** One connection of theirs on a model wire, opened for Check Access; none when it isn't theirs or isn't one. */
    readonly openConnection: (
      personId: string,
      connectionId: string,
    ) => Effect.Effect<Option.Option<Opened>, PersonalModelUnusable | PersonalModelsUnavailable>
  }
>()("@smthrs/mvp/personal/PersonalModels") {
  /** Nobody has a model of their own: every call is the deployment's. */
  static readonly none: Layer.Layer<PersonalModels> = Layer.succeed(
    PersonalModels,
    PersonalModels.of({ open: () => Effect.succeedNone, openConnection: () => Effect.succeedNone }),
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
        const savedOf = (personId: string) =>
          Store.saved(personId).pipe(
            Effect.provide(database),
            Effect.provideContext(context),
            Effect.mapError((error) => new PersonalModelsUnavailable({ errorCode: codeOf(error) })),
          )
        /** `row`'s credential opened and pinned to its base URL, as `modelId` for `tier`. */
        const openOn = (personId: string, row: Store.Saved, modelId: string, tier: ModelTier) =>
          Effect.gen(function* () {
            const protocol = row.protocol!
            const baseUrl = row.baseUrl!
            const host = hostOf(baseUrl)
            if (Option.isNone(keys)) return yield* new PersonalModelUnusable({ reason: "off", host })
            const key = yield* keys.value.cipher.open(row, sealContext(personId, row.keyVersion)).pipe(
              Effect.mapError(() => new PersonalModelUnusable({ reason: "key", host })),
            )
            const planned = ConfiguredModel.planModelBinding(
              { protocol: wireOf(protocol, host, modelId), baseUrl, modelId, credential: CREDENTIAL },
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
            return { modelId: planned.plan.modelId, model, host, protocol, connectionId: row.id, tier } satisfies Opened
          })
        const open = (personId: string, tier: ModelTier) =>
          Effect.gen(function* () {
            const saved = yield* savedOf(personId)
            // A subscription or Jev alone serves no model call: such a person has no model of their own to answer one.
            if (!saved.some((connection) => connection.active && connection.protocol !== null)) {
              return Option.none<Opened>()
            }
            const resolved = resolveTier(saved, tier)
            // A list with no model named anywhere and no preset's host has no model for any tier.
            if (resolved === undefined) {
              const named = saved.find((connection) => connection.active && connection.protocol !== null)
              return yield* new PersonalModelUnusable({ reason: "no_model", host: hostOf(named!.baseUrl!) })
            }
            const row = saved.find((each) => each.id === resolved.connectionId)!
            return Option.some(yield* openOn(personId, row, resolved.modelId, resolved.tier))
          })
        const openConnection = (personId: string, connectionId: string) =>
          Effect.gen(function* () {
            const row = (yield* savedOf(personId)).find((connection) => connection.id === connectionId)
            if (row === undefined || row.protocol === null) return Option.none<Opened>()
            // Whatever routing makes of the list, Check Access tries this connection with the first model it serves.
            const resolved = resolveTier([{ ...row, active: true }], "fast")
            if (resolved === undefined) {
              return yield* new PersonalModelUnusable({ reason: "no_model", host: hostOf(row.baseUrl!) })
            }
            return Option.some(yield* openOn(personId, row, resolved.modelId, resolved.tier))
          })
        return PersonalModels.of({ open, openConnection })
      }),
    )
}
