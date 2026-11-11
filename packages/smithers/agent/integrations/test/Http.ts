/**
 * The HTTP clients the suites run on.
 *
 * Every happy path, and every failure a real server can produce, uses the
 * real fetch transport (`FetchHttpClient.layer`) against a real local server.
 * A failure no server can produce on demand, such as a transport that rejects
 * with a message of its choosing, is injected as a faulty `HttpClient`
 * service, and so is a provider refusal a durable-step test needs at an exact
 * request (`faultingTransport`). Nothing patches `fetch` or intercepts a
 * request.
 */
import { Effect, Layer } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import type { IntegrationError } from "../src/core/IntegrationError.ts"
import type { GitHubConfig } from "../src/github/Config.vibe"
import * as GitHubClient from "../src/github/GitHubClient.vibe"

/** The real transport: the platform `fetch`. */
export const fetchLayer = FetchHttpClient.layer

/** A client over the real fetch transport. Throws if the config is refused. */
export const gitHubClient = (
  config?: GitHubConfig,
  env?: Readonly<Record<string, string | undefined>>
): GitHubClient.GitHubClient => Effect.runSync(GitHubClient.make(config, env).pipe(Effect.provide(fetchLayer)))

/** The typed failure a refused config builds. */
export const gitHubConfigFailure = (
  config: GitHubConfig,
  env: Readonly<Record<string, string | undefined>> = {}
): IntegrationError => Effect.runSync(Effect.flip(GitHubClient.make(config, env)).pipe(Effect.provide(fetchLayer)))

/** The client layer over the real fetch transport. */
export const gitHubLayer = (
  config?: GitHubConfig,
  env?: Readonly<Record<string, string | undefined>>
): Layer.Layer<GitHubClient.GitHubClient, IntegrationError> =>
  GitHubClient.layer(config, env).pipe(Layer.provide(fetchLayer))

/** A transport whose every request fails before an answer, reporting `cause`. */
export const rejectingTransport = (cause: unknown): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, cause }) }))
  )

/** A transport that answers 200 and then fails the body read with `cause`. */
export const brokenBodyTransport = (cause: unknown): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(
      request,
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(cause)
          }
        })
      )
    ))
  )

/** A client over `transport`. */
export const gitHubClientOver = (
  transport: HttpClient.HttpClient,
  config: GitHubConfig
): GitHubClient.GitHubClient =>
  Effect.runSync(GitHubClient.make(config, {}).pipe(Effect.provideService(HttpClient.HttpClient, transport)))

/** The layer for a client over `transport`. */
export const gitHubLayerOver = (
  transport: HttpClient.HttpClient,
  config: GitHubConfig
): Layer.Layer<GitHubClient.GitHubClient, IntegrationError> =>
  GitHubClient.layer(config, {}).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, transport)))

/** An answer a {@link faultingTransport} gives in place of sending a request. */
export interface Fault {
  readonly status: number
  readonly headers?: Readonly<Record<string, string>> | undefined
  readonly body?: unknown
}

/** One request a {@link faultingTransport} handled. */
export interface Handled {
  readonly method: string
  readonly path: string
  /** The status it answered with, when it answered in place of the server. */
  readonly faulted: number | undefined
  /** When the transport received it, in wall-clock milliseconds. */
  readonly at: number
}

/**
 * A transport that answers each request `fault` picks with that fault, without
 * sending it, and sends every other request over the real fetch transport.
 * `handled` lists every request the client made, faulted or sent, so a test
 * counts them all, retries included.
 */
export const faultingTransport = (
  fault: (request: { readonly method: string; readonly path: string; readonly index: number }) => Fault | undefined
): { readonly transport: HttpClient.HttpClient; readonly handled: ReadonlyArray<Handled> } => {
  const real = Effect.runSync(Effect.provide(Effect.service(HttpClient.HttpClient), fetchLayer))
  const handled: Array<Handled> = []
  const transport = HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
    Effect.suspend(() => {
      const path = new URL(request.url).pathname
      const answer = fault({ method: request.method, path, index: handled.length })
      handled.push({ method: request.method, path, faulted: answer?.status, at: Date.now() })
      return answer === undefined
        ? real.execute(request)
        : Effect.succeed(HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(answer.body ?? {}), {
            status: answer.status,
            headers: { "content-type": "application/json", ...answer.headers }
          })
        ))
    })
  )
  return { transport, handled }
}
