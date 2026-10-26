import { Context, Data, type Duration, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { SESSION_ROUTE, type SessionState as State, SIGN_OUT_ROUTE } from "./contract"
import { SessionState } from "./schema"

/**
 * ChatApi couldn't answer within the deadline (`code` `timeout`), the request never reached it (`unreachable`), or it
 * answered outside the contract: `status`, the HTTP status it answered with, and `code` `status`, or `malformed` for a
 * 200 whose body isn't a session. A log line names the failure by `code` (src/errorCode.ts).
 */
export class AuthUnreachable extends Data.TaggedError("AuthUnreachable")<{
  readonly status?: number
  readonly code?: "timeout" | "unreachable" | "status" | "malformed"
}> {}

/** `GET /api/auth/session`: who this browser is signed in as. */
export const getSession = Effect.fn("auth.session.get")(function* (origin: string, within: Duration.Input) {
  const client = yield* HttpClient.HttpClient
  return yield* Effect.gen(function* () {
    const response = yield* client.execute(HttpClientRequest.get(`${origin}${SESSION_ROUTE}`)).pipe(
      Effect.mapError(() => new AuthUnreachable({ code: "unreachable" })),
    )
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
    if (response.status !== 200) return yield* new AuthUnreachable({ status: response.status, code: "status" })
    return yield* HttpClientResponse.schemaBodyJson(SessionState)(response).pipe(
      Effect.mapError(() => new AuthUnreachable({ status: 200, code: "malformed" })),
    )
  }).pipe(Effect.timeoutOrElse({ duration: within, orElse: () => Effect.fail(new AuthUnreachable({ code: "timeout" })) }))
})

/** `POST /api/auth/sign-out`: ends this browser's session; `204` when it did. */
export const postSignOut = Effect.fn("auth.sign_out.post")(function* (origin: string, within: Duration.Input) {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.execute(HttpClientRequest.post(`${origin}${SIGN_OUT_ROUTE}`)).pipe(
    Effect.mapError(() => new AuthUnreachable({ code: "unreachable" })),
    Effect.timeoutOrElse({ duration: within, orElse: () => Effect.fail(new AuthUnreachable({ code: "timeout" })) }),
  )
  yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
  if (response.status !== 204) return yield* new AuthUnreachable({ status: response.status, code: "status" })
})

/**
 * Sign-in's client, as a service: the one way the browser asks who it is signed in as and signs out. Signing in is a
 * link the person follows, not a call. Tests of a ChatApi that fails provide a faulty one; every other test uses the
 * real one.
 */
export class AuthClient extends Context.Service<
  AuthClient,
  {
    readonly session: Effect.Effect<State, AuthUnreachable>
    readonly signOut: Effect.Effect<void, AuthUnreachable>
  }
>()("@smthrs/mvp/auth/AuthClient") {
  /** The real client: ChatApi at `origin`, with `within` for each whole request. */
  static readonly layer = (options: { readonly origin: string; readonly within: Duration.Input }) =>
    Layer.effect(
      AuthClient,
      Effect.map(HttpClient.HttpClient, (client) => {
        const withClient = Effect.provideService(HttpClient.HttpClient, client)
        return AuthClient.of({
          session: withClient(getSession(options.origin, options.within)),
          signOut: withClient(postSignOut(options.origin, options.within)),
        })
      }),
    )
}
