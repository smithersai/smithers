/**
 * The runner's side of the runner routes: claim, heartbeat and settle over
 * HTTPS with the runner's bearer token ({@link AgentRunner.ROUTES}).
 *
 * @since 1.0.0
 */

import * as AgentRunner from "@smthrs/agent/AgentRunner"
import * as Transcript from "@smthrs/agent/Transcript"
import { Context, Duration, Effect, Layer, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"

/**
 * The host didn't answer as the protocol says: `unavailable` (it couldn't be
 * reached, or answered 5xx or 429), `refused` (it refused the runner's token),
 * or `invalid` (it refused the request, or answered what isn't the protocol).
 *
 * @category errors
 * @since 1.0.0
 */
export class HostError extends Schema.TaggedError<HostError>()("@smthrs/cli/Runner/HostError", {
  code: Schema.Literals(["unavailable", "refused", "invalid"]),
  route: Schema.String,
  status: Schema.optional(Schema.Int),
  /** The wait the host's `retry-after` said, in seconds, on a `429` or `503`. */
  retryAfterSeconds: Schema.optional(Schema.Int),
  /**
   * On a heartbeat refused `403`: the host ended the job for a Stop, which is
   * all it tells a runner it no longer takes (decision 0148).
   */
  cancel: Schema.optional(Schema.Boolean)
}) {}

/**
 * The runner routes of one host: `events` sends a job's transcript events and
 * answers the next `seq` the host lacks.
 *
 * @category services
 * @since 1.0.0
 */
export class Host extends Context.Service<Host, {
  readonly claim: (
    request: typeof AgentRunner.ClaimRequest.Type
  ) => Effect.Effect<AgentRunner.Job | null, HostError>
  readonly heartbeat: (
    request: typeof AgentRunner.HeartbeatRequest.Type
  ) => Effect.Effect<typeof AgentRunner.HeartbeatResponse.Type, HostError>
  readonly settle: (
    request: typeof AgentRunner.SettleRequest.Type
  ) => Effect.Effect<typeof AgentRunner.SettleResponse.Type, HostError>
  readonly events: (
    request: typeof Transcript.EventsRequest.Type
  ) => Effect.Effect<typeof Transcript.EventsResponse.Type, HostError>
  /** A read credential for the repository of a job the runner holds (decision 0148). */
  readonly gitCredential: (
    request: typeof AgentRunner.GitCredentialRequest.Type
  ) => Effect.Effect<typeof AgentRunner.GitCredentialResponse.Type, HostError>
}>()("@smthrs/cli/Runner/Host") {}

const decodeClaim = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentRunner.ClaimResponse))
const decodeHeartbeat = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentRunner.HeartbeatResponse))
const decodeSettle = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentRunner.SettleResponse))
const decodeEvents = Schema.decodeUnknownEffect(Schema.fromJsonString(Transcript.EventsResponse))
const decodeGitCredential = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentRunner.GitCredentialResponse))

/**
 * The longest the runner reads a refusal's body for its `cancel`.
 *
 * @category constants
 * @since 1.0.0
 */
export const REFUSAL_BODY_MS = 5000

/**
 * The routes at `origin` with `token`, over the context's `HttpClient`. A
 * claim may wait for `waitSeconds` on the host, so each request's own bound is
 * that wait and 30 seconds more, its answer's body included. A `401` or `403`
 * is a refusal whatever its body; the body is read, within the same bound and
 * at most `REFUSAL_BODY_MS`, only for the `cancel` a Stop adds (decision
 * 0148), and one that doesn't arrive whole or doesn't parse says none.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (options: { readonly origin: string; readonly token: string }) =>
  Layer.effect(
    Host,
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const post = <A>(
        route: keyof typeof AgentRunner.ROUTES,
        body: unknown,
        decode: (text: string) => Effect.Effect<A, unknown>,
        waitSeconds = 0
      ) =>
        Effect.gen(function*() {
          const request = HttpClientRequest.post(`${options.origin}${AgentRunner.ROUTES[route]}`).pipe(
            HttpClientRequest.bearerToken(options.token),
            HttpClientRequest.bodyJsonUnsafe(body)
          )
          const deadline = Date.now() + Duration.toMillis(Duration.seconds(waitSeconds + 30))
          const left = () => Math.max(0, deadline - Date.now())
          const response = yield* client.execute(request).pipe(
            Effect.timeout(left()),
            Effect.mapError(() => new HostError({ code: "unavailable", route }))
          )
          const status = response.status
          if (status === 401 || status === 403) {
            const said = yield* response.json.pipe(
              Effect.timeout(Math.min(left(), REFUSAL_BODY_MS)),
              Effect.orElseSucceed(() => undefined)
            )
            const cancel = typeof said === "object" && said !== null &&
              (said as { readonly cancel?: unknown }).cancel === true
            return yield* new HostError({ code: "refused", route, status, ...(cancel ? { cancel } : {}) })
          }
          if (status >= 500 || status === 429) {
            const wait = Number(response.headers["retry-after"])
            return yield* new HostError({
              code: "unavailable",
              route,
              status,
              ...(Number.isInteger(wait) && wait > 0 ? { retryAfterSeconds: wait } : {})
            })
          }
          if (status !== 200) return yield* new HostError({ code: "invalid", route, status })
          const text = yield* response.text.pipe(
            Effect.timeout(left()),
            Effect.mapError(() => new HostError({ code: "unavailable", route }))
          )
          return yield* decode(text).pipe(Effect.mapError(() => new HostError({ code: "invalid", route, status })))
        })
      return Host.of({
        claim: (request) =>
          post("claim", request, decodeClaim, request.waitSeconds).pipe(Effect.map((answer) => answer.job)),
        heartbeat: (request) => post("heartbeat", request, decodeHeartbeat),
        settle: (request) => post("settle", request, decodeSettle),
        events: (request) => post("events", request, decodeEvents),
        gitCredential: (request) => post("gitCredential", request, decodeGitCredential)
      })
    })
  )

/**
 * Whether the host refused a request for want of authorization (`403`:
 * cleared, or its repository's installation forgotten) or authentication
 * (`401`: the token rotated or the runner retired), as opposed to answering
 * that a claim no longer holds (decision 0148). A job's work is suspended for
 * it, never ended.
 *
 * @category predicates
 * @since 1.0.0
 */
export const authorizationLost = (error: HostError): boolean =>
  error.code === "refused" && (error.status === 401 || error.status === 403)
