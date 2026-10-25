/**
 * The one decoder from a planned model (@smthrs/rpc/ConfiguredModel) to the
 * real @smthrs/model stack: a generation plan becomes a Route, a decision plan
 * becomes an Evaluator layer. The plan never holds a value and the credential
 * arrives already Redacted, so nothing here can name one.
 *
 * Trusted host processes import this module; browser bundles do not carry the
 * kernel-backed model runtime.
 *
 * @since 1.0.0-rc.0
 */

import { HttpClient as KernelHttpClient } from "@smthrs/kernel"
import {
  Auth,
  Endpoint,
  Evaluator,
  type Model,
  ModelError,
  type ModelRequest,
  OpenAIChatGPT,
  RequestExecutor,
  Route
} from "@smthrs/model"
import type { ConfiguredModel } from "@smthrs/rpc"
import { Effect, Layer, Redacted as Secret, Result } from "effect"
import type { Redacted } from "effect"
import { providerTransport } from "./ProviderTransport.ts"

/**
 * Visits a route without erasing its protocol-specific type parameters.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface RouteVisitor<A> {
  <Body, Frame, Event, State>(route: Route.Route<Body, Frame, Event, State>): A
}

/**
 * The plan's Route, handed to `visit`. `Route.anthropic` names its own origin,
 * so the plan's endpoint replaces it and the key header, the framing and the
 * `anthropic-version` header stay the package's own.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const withRoute = <A>(
  plan: ConfiguredModel.ModelPlan,
  apiKey: Redacted.Redacted<string>,
  given: RouteVisitor<A>
): Result.Result<A, ModelError.ModelError> => {
  // The record's extra body fields ride every request the route sends; the planner checked they are JSON.
  const extraBody = plan.extraBody as ModelRequest.JsonObject | undefined
  const visit: RouteVisitor<A> = (route) => given(extraBody === undefined ? route : { ...route, extraBody })
  switch (plan.protocol) {
    case "anthropic-messages":
      return Result.flatMap(
        Route.anthropic({ apiKey }),
        (route) =>
          Result.map(
            Endpoint.make({ url: plan.baseUrl, path: plan.path }),
            (endpoint) => visit(Route.make({ ...route, id: plan.protocol, endpoint }))
          )
      )
    case "openai-responses-chatgpt": {
      let access: { accessToken: string; accountId: string }
      try {
        access = JSON.parse(Secret.value(apiKey))
        if (!access.accessToken || !access.accountId) throw new Error("missing access")
      } catch {
        return Result.fail(
          new ModelError.ModelError({ code: "authentication", message: "ChatGPT sign-in unavailable" })
        )
      }
      const bearer = Auth.bearer(Secret.make(access.accessToken))
      return Result.map(
        OpenAIChatGPT.make({
          baseUrl: plan.baseUrl,
          auth: {
            sign: (headers) =>
              Effect.map(bearer.sign(headers), (signed) => ({ ...signed, "chatgpt-account-id": access.accountId })),
            credentialHeaders: ["Authorization", "chatgpt-account-id"]
          }
        }),
        visit
      )
    }
    case "openai-responses":
      return Result.map(
        Route.openaiResponsesCompatible({ id: plan.protocol, providerName: "openai", baseUrl: plan.baseUrl, apiKey }),
        visit
      )
    case "openai-chat":
      return Result.map(
        Route.openaiChatCompatible({
          id: plan.protocol,
          providerName: "openai",
          baseUrl: plan.baseUrl,
          path: plan.path,
          apiKey
        }),
        visit
      )
    case "evaluation":
      return Result.fail(
        new ModelError.ModelError({ code: "no_route", message: "A decision model has no generation route" })
      )
  }
}

/**
 * How {@link toModel} reaches the provider.
 *
 * @category models
 * @since 1.0.0
 */
export interface ToModelOptions {
  /** The fetch every call goes through; it never follows a redirect. Defaults to the runtime's global fetch. */
  readonly fetch?: typeof globalThis.fetch | undefined
  /** Told the status of each provider redirect the transport refused. */
  readonly onRedirect?: ((status: number) => void) | undefined
  /** Retries and the response-start deadline of each call; `RequestExecutor.makeWith`'s defaults when omitted. */
  readonly execution?: RequestExecutor.MakeOptions | undefined
}

/**
 * The credential-free half of a configured route. `prepare` compiles a request
 * into exactly the url, public headers and body the model sends, before a
 * credential signs it, so a durable step can key on what was asked without
 * reaching the key. It is structurally `RouteResolver` from `@smthrs/agent`.
 *
 * @category models
 * @since 1.0.0
 */
export interface HostModelRoute {
  readonly prepare: (
    request: ModelRequest.ModelRequest
  ) => Effect.Effect<Route.PreparedRequest, ModelError.ModelError>
}

/**
 * The model a plan names, and the prepare port of the one route it streams through.
 *
 * @category models
 * @since 1.0.0
 */
export interface PlannedModel {
  readonly model: Model.Model
  readonly route: HostModelRoute
}

/**
 * Builds the model a validated generation plan names, with its redacted
 * credential, and the {@link HostModelRoute} of the same route. Every call
 * goes over a transport that refuses redirects (`providerTransport`), so the
 * key never leaves the planned origin. Only `prepare` leaves here, never the
 * route, whose `Auth` holds the key.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const toModel = (
  plan: ConfiguredModel.ModelPlan,
  apiKey: Redacted.Redacted<string>,
  options: ToModelOptions = {}
): Effect.Effect<PlannedModel, ModelError.ModelError> =>
  Effect.flatten(
    Effect.fromResult(withRoute(plan, apiKey, (route) =>
      Effect.map(Route.toModel(route), (model): PlannedModel => ({
        model,
        route: { prepare: (request) => Route.prepare(route, request) }
      }))))
  ).pipe(
    Effect.provide(
      Layer.effect(
        RequestExecutor.RequestExecutor,
        Effect.flatMap(
          KernelHttpClient.HttpClient,
          (http) => RequestExecutor.makeWith(RequestExecutor.fixed(http), options.execution)
        )
      ).pipe(Layer.provide(providerTransport(options.fetch, options.onRedirect)))
    )
  )

/**
 * Builds the evaluator layer for a validated decision model plan.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const toEvaluatorLayer = (
  plan: ConfiguredModel.ModelPlan,
  apiKey: Redacted.Redacted<string>,
  timeoutMs: number
): Layer.Layer<Evaluator.Evaluator, never, KernelHttpClient.HttpClient> =>
  Evaluator.layerVercelGateway({ apiKey, model: plan.modelId, timeoutMs, baseUrl: plan.url })
