// How ChatApi calls Electric's gateway at runtime: through its service binding, which infra/Electric.ts declares in
// production. Every other request ChatApi sends keeps the global fetch.
import { ShapeProxy } from "@smthrs/effect-electric"
import { Effect, Layer, Option } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"

/** The name of ChatApi's service binding to the gateway Worker. */
export const GATEWAY_BINDING = "ELECTRIC_GATEWAY"

/**
 * ChatApi's `ELECTRIC_URL` in production. A service binding ignores the host, so it names no address: the gateway has
 * no public URL, and only ChatApi's binding reaches it.
 */
export const GATEWAY_URL = "http://electric-gateway"

/** What `upstream` needs of a service binding: its `fetch`. */
type Fetcher = { readonly fetch: typeof globalThis.fetch }

const isFetcher = (binding: unknown): binding is Fetcher =>
  typeof binding === "object" && binding !== null && typeof (binding as { fetch?: unknown }).fetch === "function"

/**
 * The shape proxy's `Upstream` (`ShapeProxy.Upstream`) over `env`'s gateway binding: the same `fetch` client as
 * every other request, calling the binding's `fetch` in place of the global one. Every other request keeps the global
 * `fetch`. Without the binding (`alchemy dev`, tests) it provides nothing, and the proxy calls `ELECTRIC_URL` with
 * the request's own client.
 */
export const upstream = (env: Readonly<Record<string, unknown>>): Layer.Layer<never> =>
  Layer.unwrap(Effect.sync((): Layer.Layer<never> => {
    const binding = env[GATEWAY_BINDING]
    if (!isFetcher(binding)) return Layer.empty
    const fetch: typeof globalThis.fetch = (input, init) => binding.fetch(input, init)
    // Provided around each call, innermost, so no `Fetch` the request's own context holds replaces the binding's.
    const client = Effect.map(
      Effect.service(HttpClient.HttpClient),
      (client) => client.pipe(
        // Old deployments can retain ELECTRIC_SECRET. The private binding needs no credentials, and none may
        // enter its cache key or platform trace, even if the generic ShapeProxy connection still supplies one.
        HttpClient.mapRequest((request) => {
          const url = Option.getOrThrow(HttpClientRequest.toUrl(request))
          url.searchParams.delete("secret")
          return HttpClientRequest.setUrl(request, url).pipe(
            HttpClientRequest.removeHeader("authorization"),
            HttpClientRequest.removeHeader("cookie"),
          )
        }),
        HttpClient.transform((effect) => Effect.provideService(effect, FetchHttpClient.Fetch, fetch)),
      ),
    )
    return Layer.effect(ShapeProxy.Upstream, client).pipe(Layer.provide(FetchHttpClient.layer))
  }))
