/**
 * The model a host answers with, chosen by configuration rather than code:
 * the provider's model id and the `Model` that serves it.
 *
 * `layerConfig` reads a configured-model record (@smthrs/rpc/ConfiguredModel)
 * and its credential through Effect `Config`, so whatever `ConfigProvider` the
 * host installs supplies them: the environment on Node or Bun, the Worker's
 * bindings on Cloudflare. A key only ever goes to an origin it is pinned to.
 *
 * @since 1.0.0
 */

import type { Model } from "@smthrs/model"
import { ConfiguredModel } from "@smthrs/rpc"
import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { type HostModelRoute, toModel } from "./ConfiguredModelRoute.ts"

/**
 * A configured-model record without its name: what `layerConfig` reads.
 *
 * @category models
 * @since 1.0.0
 */
export interface HostModelRecord {
  readonly protocol: string
  readonly baseUrl?: string | undefined
  readonly path?: string | undefined
  readonly modelId: string
  readonly credential: string
  /**
   * Fields added to every request body the model sends, beside the protocol's own, such as a gateway's routing
   * preferences (`ModelExtraBodySchema` in `@smthrs/rpc`). Never a credential.
   */
  readonly extraBody?: Readonly<Record<string, unknown>> | undefined
}

/**
 * How `HostModel` reaches its provider.
 *
 * @category models
 * @since 1.0.0
 */
export interface HostModelOptions {
  /** The fetch provider calls go through, wrapped to refuse redirects. Defaults to the host's injected FetchHttpClient.Fetch, then the runtime's global fetch. */
  readonly fetch?: typeof globalThis.fetch | undefined
}

/**
 * A configured-model record this host cannot use: `reason` is the planner's
 * failure code (`invalid`, `credential_missing`, `model_not_allowed` and the
 * other `ConfiguredModel` codes), or `config` when the host's configuration
 * could not be read. It never carries a key.
 *
 * @category errors
 * @since 1.0.0
 */
export class HostModelUnusable extends Schema.TaggedError<HostModelUnusable>()(
  "@smthrs/model-host/HostModelUnusable",
  { reason: Schema.String }
) {}

const RecordJson = Schema.fromJsonString(
  Schema.Struct({
    protocol: Schema.String,
    baseUrl: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
    modelId: Schema.String,
    credential: Schema.String,
    extraBody: Schema.optional(Schema.Record(Schema.String, Schema.Json))
  })
)

/**
 * The host's model: the provider model id every request names, the `Model`
 * that streams it, and the credential-free `route` that prepares a request
 * exactly as the model sends it, unsigned, for a durable step's key.
 *
 * @category services
 * @since 1.0.0
 */
export class HostModel extends Context.Service<HostModel, {
  readonly modelId: string
  readonly model: Model.Model
  readonly route: HostModelRoute
}>()("@smthrs/model-host/HostModel") {
  /**
   * Provides a validated generation plan and its credential. Provider calls go
   * over a transport that refuses redirects, so the key never leaves the
   * planned origin. `fetch` defaults to the host's injected FetchHttpClient.Fetch.
   *
   * @category layers
   * @since 1.0.0
   */
  static readonly layer = (
    plan: ConfiguredModel.ModelPlan,
    apiKey: Redacted.Redacted<string>,
    options: HostModelOptions = {}
  ): Layer.Layer<HostModel> =>
    Layer.effect(
      HostModel,
      // A plan from planModelBinding always routes, so a refusal here is a defect.
      Effect.map(
        Effect.orDie(toModel(plan, apiKey, { fetch: options.fetch })),
        ({ model, route }) => HostModel.of({ modelId: plan.modelId, model, route })
      )
    )

  /**
   * Builds the model a configured-model record names, at run time: for a
   * record read from a database rather than from configuration. Its key and
   * origin are read through Effect `Config` exactly as {@link layerConfig}
   * reads them. A record this host cannot use, its key missing included,
   * fails with {@link HostModelUnusable}.
   *
   * @category constructors
   * @since 1.0.0
   */
  static readonly make = (
    record: HostModelRecord,
    options: HostModelOptions = {}
  ): Effect.Effect<HostModel["Service"], HostModelUnusable> =>
    Effect.gen(function*() {
      const keyName = ConfiguredModel.modelCredentialEnvName(record.credential)
      const originName = `${keyName}${ConfiguredModel.MODEL_CREDENTIAL_ORIGIN_SUFFIX}`
      const apiKey = yield* Config.option(Config.Redacted(keyName))
      const origin = yield* Config.option(Config.String(originName))
      const planned = ConfiguredModel.planModelBinding(
        record,
        ConfiguredModel.hostModelCredentials({
          [keyName]: Option.match(apiKey, { onNone: () => undefined, onSome: Redacted.value }),
          [originName]: Option.getOrUndefined(origin)
        }),
        { kind: "generation" }
      )
      if (!planned.ok) return yield* new HostModelUnusable({ reason: planned.failure.code })
      // The planner refuses a record whose key is missing, so a usable plan has one.
      const key = Option.getOrThrow(apiKey)
      const { model, route } = yield* Effect.orDie(toModel(planned.plan, key, { fetch: options.fetch }))
      return HostModel.of({ modelId: planned.plan.modelId, model, route })
    }).pipe(
      Effect.catchTag("ConfigError", () => Effect.fail(new HostModelUnusable({ reason: "config" })))
    )

  /**
   * Provides the model a configured-model record names. The record is JSON
   * under `name` (or `fallback` when unset). A built-in credential's key is
   * read under its own name (`CEREBRAS_API_KEY`); a custom credential `NAME`
   * reads `SMITHERS_MODEL_KEY_NAME` and its origin `SMITHERS_MODEL_KEY_NAME_ORIGIN`. A record this host cannot use stops the host with
   * the planner's reason.
   *
   * @category layers
   * @since 1.0.0
   */
  static readonly layerConfig = (
    name: string,
    fallback?: HostModelRecord,
    options: HostModelOptions = {}
  ): Layer.Layer<HostModel, Config.ConfigError> =>
    Layer.unwrap(Effect.gen(function*() {
      const configured = Config.schema(RecordJson, name)
      const record = yield* (fallback === undefined ? configured : configured.pipe(Config.withDefault(fallback)))
      const keyName = ConfiguredModel.modelCredentialEnvName(record.credential)
      const apiKey = yield* Config.Redacted(keyName)
      const originName = `${keyName}${ConfiguredModel.MODEL_CREDENTIAL_ORIGIN_SUFFIX}`
      const origin = yield* Config.option(Config.String(originName))
      const planned = ConfiguredModel.planModelBinding(
        record,
        ConfiguredModel.hostModelCredentials({
          [keyName]: Redacted.value(apiKey),
          [originName]: Option.getOrUndefined(origin)
        }),
        { kind: "generation" }
      )
      if (!planned.ok) return yield* Effect.die(new Error(`${name} is not usable: ${JSON.stringify(planned.failure)}`))
      return HostModel.layer(planned.plan, apiKey, options)
    }))
}
