/**
 * Resolves a local owner's configured model from a trusted process environment.
 *
 * @since 1.0.0-rc.0
 */

import { ConfiguredModel } from "@smthrs/rpc"
import { Effect, Redacted } from "effect"
import type { PlannedModel } from "./ConfiguredModelRoute.vibe"
import { toModel } from "./ConfiguredModelRoute.vibe"
import type { ModelSource } from "./FastModelFallback.vibe"
import type { ModelTurnResolver } from "./HostServer.ts"
import { readContextStream } from "./internal/ContextStream.ts"
import { ResolveFailed } from "./ModelHostError.vibe"
import { refusingRedirects } from "./ProviderTransport.ts"

/**
 * Inputs for the single-owner environment-backed model resolver.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface EnvironmentModelResolverOptions {
  readonly binding: unknown
  /** Owner-resolved fast role; absent bindings reuse the resolved answer model. */
  readonly preflightBinding?: unknown
  readonly env: ConfiguredModel.ModelCredentialEnv
  readonly fetchImpl?: typeof globalThis.fetch
  readonly maxTokens?: number
}

/**
 * Single-owner resolver for the packaged local host. It plans the configured
 * binding before reading exactly one named credential from the host
 * environment. A request may choose another model only on the configured
 * binding's credential and origin, and provider redirects are refused.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const environmentModelResolver = (options: EnvironmentModelResolverOptions): ModelTurnResolver =>
(
  grant,
  selection
) => {
  const credentials = ConfiguredModel.hostModelCredentials(options.env)
  const configured = ConfiguredModel.planModelBinding(options.binding, credentials, { kind: "generation" })
  // The wire may carry null for an absent model, as the Go resolver reads it.
  const requested: unknown = grant.request.model ?? undefined
  const planned = requested === undefined
    ? configured
    : ConfiguredModel.planModelBinding(requested, credentials, { kind: "generation" })
  if (
    !configured.ok || !planned.ok || planned.plan.credential !== configured.plan.credential ||
    planned.plan.origin !== configured.plan.origin
  ) return Effect.fail(new ResolveFailed({ message: "configured model is unavailable" }))
  const credential = options.env[ConfiguredModel.modelCredentialEnvName(planned.plan.credential)]?.trim()
  if (credential === undefined || credential === "") {
    return Effect.fail(new ResolveFailed({ message: "configured model credential is unavailable" }))
  }
  // The fast proxy and its fallbacks answer quickly or not at all: one try, and 9 s for a response to start.
  const fastExecution = { maxRetries: 0, responseStartMs: 9000 }
  const modelOf = (plan: ConfiguredModel.ModelPlan, key: string, fast = plan.credential === "SMITHERS_FAST_PROXY") =>
    Effect.map(
      toModel(plan, Redacted.make(key), { fetch: options.fetchImpl, ...(fast ? { execution: fastExecution } : {}) }),
      (source) => source
    )
  return modelOf(planned.plan, credential).pipe(
    Effect.flatMap((model) =>
      Effect.gen(function*() {
        const withFallback = (
          primary: PlannedModel,
          plan: ConfiguredModel.ModelPlan,
          primaryCredential: string
        ) =>
          Effect.gen(function*() {
            const additionalCredentials: Array<string> = []
            if (plan.credential !== "SMITHERS_FAST_PROXY") {
              return { ...primary, additionalCredentials, fallbacks: [] as Array<ModelSource>, onFallback: undefined }
            }
            let bindings: unknown
            try {
              bindings = JSON.parse(options.env.SMITHERS_FAST_FALLBACK_MODELS ?? "[]")
            } catch {
              return yield* Effect.fail(new ResolveFailed({ message: "fast-model fallback unavailable" }))
            }
            if (!Array.isArray(bindings)) {
              return yield* Effect.fail(new ResolveFailed({ message: "fast-model fallback unavailable" }))
            }
            const sources: Array<ModelSource> = []
            for (const binding of bindings) {
              const fallback = ConfiguredModel.planModelBinding(binding, credentials, { kind: "generation" })
              if (!fallback.ok) {
                return yield* Effect.fail(new ResolveFailed({ message: "fast-model fallback unavailable" }))
              }
              const key = options.env[ConfiguredModel.modelCredentialEnvName(fallback.plan.credential)]?.trim()
              if (!key) {
                return yield* Effect.fail(new ResolveFailed({ message: "fast-model fallback unavailable" }))
              }
              const model = yield* modelOf(fallback.plan, key, true)
              additionalCredentials.push(key)
              sources.push({
                ...model,
                credential: key,
                modelId: fallback.plan.modelId,
                outputTokenLimitSupported: fallback.plan.protocol !== "openai-responses-chatgpt"
              })
            }
            return {
              additionalCredentials,
              ...primary,
              fallbacks: sources,
              onFallback: (index: number) =>
                Effect.tryPromise({
                  try: async (signal) => {
                    const endpoint = new URL(plan.baseUrl)
                    endpoint.pathname = endpoint.pathname.replace(/\/fast$/, "/fast/selected")
                    const response = await refusingRedirects(options.fetchImpl ?? globalThis.fetch)(endpoint, {
                      method: "POST",
                      headers: { "content-type": "application/json", authorization: `Bearer ${primaryCredential}` },
                      body: JSON.stringify({ index }),
                      signal
                    })
                    await response.body?.cancel()
                  },
                  catch: () => undefined
                }).pipe(Effect.ignore)
            }
          })
        const routedModel = yield* withFallback(model, planned.plan, credential)
        const resolved = {
          model: routedModel.model,
          options: {
            route: routedModel.route,
            ...(routedModel.fallbacks.length === 0 ? {} : { fallbacks: routedModel.fallbacks }),
            ...(routedModel.onFallback === undefined ? {} : { onFallback: routedModel.onFallback }),
            modelId: planned.plan.modelId,
            ...(planned.plan.protocol === "openai-responses-chatgpt" ? { outputTokenLimitSupported: false } : {}),
            credential,
            ...(routedModel.additionalCredentials.length === 0
              ? {}
              : { additionalCredentials: routedModel.additionalCredentials }),
            ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens })
          }
        }
        // A selection-only request brings its own host-read input; a chat
        // turn's preflight reads authorized SharedEntries through the callback.
        if (grant.request.sharedConversation !== true && selection === undefined) return resolved
        const input = selection !== undefined ? selection : yield* Effect.tryPromise({
          try: async (signal) => {
            const response = await refusingRedirects(options.fetchImpl ?? globalThis.fetch)(
              new URL("/internal/chat/context", grant.producerBaseUrl),
              {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${grant.token}` },
                body: JSON.stringify({ turnId: grant.turnId, generation: grant.generation }),
                signal
              }
            )
            if (response.status !== 200) {
              await response.body?.cancel()
              throw new Error("context unavailable")
            }
            return readContextStream(response)
          },
          catch: () => new ResolveFailed({ message: "shared conversation context is unavailable" })
        })
        if (options.preflightBinding === undefined) return { ...resolved, preflight: { ...resolved, input } }
        // This binding is supplied by the host launcher, never by the prompt.
        // It may spend a different owner key, but keeps that key's own origin.
        const fast = ConfiguredModel.planModelBinding(options.preflightBinding, credentials, { kind: "generation" })
        if (!fast.ok) return yield* Effect.fail(new ResolveFailed({ message: "preflight model is unavailable" }))
        const fastCredential = options.env[ConfiguredModel.modelCredentialEnvName(fast.plan.credential)]?.trim()
        if (fastCredential === undefined || fastCredential === "") {
          return yield* Effect.fail(new ResolveFailed({ message: "preflight model credential is unavailable" }))
        }
        const fastModel = yield* modelOf(fast.plan, fastCredential)
        const routedFast = yield* withFallback(fastModel, fast.plan, fastCredential)
        return {
          ...resolved,
          preflight: {
            input,
            model: routedFast.model,
            options: {
              route: routedFast.route,
              ...(routedFast.fallbacks.length === 0 ? {} : { fallbacks: routedFast.fallbacks }),
              ...(routedFast.onFallback === undefined ? {} : { onFallback: routedFast.onFallback }),
              modelId: fast.plan.modelId,
              ...(fast.plan.protocol === "openai-responses-chatgpt" ? { outputTokenLimitSupported: false } : {}),
              credential: fastCredential,
              ...(routedFast.additionalCredentials.length === 0
                ? {}
                : { additionalCredentials: routedFast.additionalCredentials })
            }
          }
        }
      })
    ),
    Effect.mapError(() => new ResolveFailed({ message: "configured model route is unavailable" }))
  )
}
