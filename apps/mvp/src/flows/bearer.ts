import { Effect, Option, Result, Schema } from "effect"
import { Base64Url } from "effect/encoding"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { signedOut } from "../features/auth/store"
import { credentialRoute } from "./contract"

// How a request goes as a run rather than as the person (decision 0017 slice 0, docs/features/sign-in.md#run-credentials):
// with the run's credential as a bearer token, and without the session cookie, so the server never mistakes it for the
// person's own press. The engine sends its runs' requests this way (src/flows/credentials.ts), and so does the tab for a
// write a run queued in its outbox (src/features/issues/writes.ts, src/features/runs/writes.ts). Nothing here imports
// more than Effect.

/** `request` carrying run credential `token`. */
export const withBearer = (request: HttpClientRequest.HttpClientRequest, token: string) =>
  HttpClientRequest.setHeader(request, "authorization", `Bearer ${token}`)

/** `effect`, whose fetch leaves the session cookie off. */
export const withoutCookie = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Effect.serviceOption(FetchHttpClient.RequestInit), (init) =>
    Effect.provideService(effect, FetchHttpClient.RequestInit, {
      ...Option.getOrElse(init, () => ({})),
      credentials: "omit",
    }))

/** Routing hints only. Renewal verifies the signed token, never these client-decoded fields. */
export const renewalOf = (token: string): Option.Option<{ readonly run: string; readonly flow: string }> => {
  const separator = token.lastIndexOf(".")
  if (separator <= 0 || separator === token.length - 1) return Option.none()
  const payload = token.slice(0, separator)
  const decoded = Base64Url.decodeString(payload)
  if (Result.isFailure(decoded)) return Option.none()
  const claims = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ run: Schema.String, chain: Schema.Array(Schema.String).check(Schema.isMinLength(1)) })))(decoded.success)
  return Option.map(claims, ({ run, chain }) => ({ run, flow: chain[chain.length - 1]! }))
}

/**
 * A fresh credential for the run `credential` was minted for, from ChatApi on `origin`: what a request the tab sends for
 * a run goes with. This exchange authenticates the original person but never sends the request in their session; the
 * server reads the old signature, revocation and exact authority, and the decoded run only routes it. Fails with the
 * status ChatApi answered, or none when it didn't answer or the token isn't one.
 */
export const renewed = (origin: string, credential: string) =>
  Effect.gen(function* () {
    if (yield* signedOut) return yield* Effect.fail({ status: 401 as number | undefined })
    const renewal = renewalOf(credential)
    if (Option.isNone(renewal)) return yield* Effect.fail({ status: 403 as number | undefined })
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(HttpClientRequest.post(`${origin}${credentialRoute(renewal.value.run)}`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ flow: renewal.value.flow, renew: credential }),
    )).pipe(Effect.mapError(() => ({ status: undefined as number | undefined })))
    if (response.status !== 200) return yield* Effect.fail({ status: response.status as number | undefined })
    const body = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ token: Schema.String }))),
      Effect.mapError(() => ({ status: undefined as number | undefined })),
    )
    return body.token
  })
