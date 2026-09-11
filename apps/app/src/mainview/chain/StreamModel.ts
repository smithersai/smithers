import { ModelAuthor } from "@smthrs/chain"
import type { Author } from "@smthrs/chain"
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import { Endpoint, Framing, Model, RequestExecutor, Route } from "@smthrs/model"
import { Effect, Layer, Result } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import { MODEL_STREAM_PATH } from "@smthrs/rpc/AgentApiRoutes"
import type { FetchLike } from "@smthrs/rpc/NativeAgent"
import { protocol } from "./RelayProtocol"

/*
 * The browser model seat (DESIGN.md §14, decision D1): the real @smthrs/model
 * request/stream machinery — body lowering, framing, ModelEvent fold — pointed
 * at the Worker's relay path. The Worker session-gates the call, forwards it to
 * the managed-inference upstream that owns the provider key, and streams that
 * upstream's frames back; no credential exists on this side of the wire, which
 * is why the route carries no auth at all. The session cookie the browser
 * already holds is what authenticates a same-origin request.
 */

/**
 * The seat the relay actually serves. The upstream pins the model for the whole
 * deployment, so this is a statement of which model answers, not a request the
 * relay could honour for some other value.
 */
export const DEFAULT_MODEL_ID = "gpt-oss-120b"

export interface StreamModelOptions {
  /** Absolute origin of the product Worker; defaults to the page's own origin. */
  readonly baseUrl?: string
  /** Injectable like every controller seam, so tests bind fixtures, not a network. */
  readonly fetchImpl?: FetchLike
}

const relayOrigin = (baseUrl?: string): string => {
  if (baseUrl !== undefined && baseUrl !== "") return baseUrl
  if (typeof location !== "undefined") return location.origin
  return "http://localhost"
}

const relayRoute = (origin: string) =>
  Route.make({
    id: "relay",
    protocol,
    endpoint: Result.getOrThrow(Endpoint.make({ url: origin, path: MODEL_STREAM_PATH })),
    // Same-origin: the browser's own session cookie is the credential, and
    // nothing this code holds may be sent as one.
    auth: { sign: (headers) => Effect.succeed(headers) },
    framing: Framing.ndjson
  })

/** The Model service over the relay: Route ← RequestExecutor ← fetch HttpClient. */
export const layerModel = (options: StreamModelOptions = {}): Layer.Layer<Model.Model> => {
  const fetchLayer = options.fetchImpl === undefined
    ? FetchHttpClient.layer
    : FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(options.fetchImpl as typeof fetch))
    )
  const kernelHttp = Layer.effect(KernelHttpClient.HttpClient)(
    Effect.gen(function*() {
      return yield* HttpClient.HttpClient
    })
  ).pipe(Layer.provide(fetchLayer))
  return Route.layer(relayRoute(relayOrigin(options.baseUrl))).pipe(
    Layer.provide(RequestExecutor.layer),
    Layer.provide(kernelHttp),
    Layer.provide(Layer.succeed(HttpClient.TracerDisabledWhen)(() => true))
  ) as Layer.Layer<Model.Model>
}

export interface AuthorSeatOptions extends StreamModelOptions {
  readonly modelId?: string
}

/** The chain's author seat over the relay model — what ChainRuntime provides. */
export const layerAuthor = (options: AuthorSeatOptions = {}): Layer.Layer<Author.Author> =>
  ModelAuthor.layer({ modelId: options.modelId ?? DEFAULT_MODEL_ID }).pipe(
    Layer.provide(layerModel(options))
  ) as Layer.Layer<Author.Author>
