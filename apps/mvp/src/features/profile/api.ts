import { Context, Data, type Duration, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http"
import { profileRoute } from "./contract"
import { Profile } from "./schema"

/** Profile API didn't answer with a valid profile: network/timeout (`status` absent), HTTP refusal, or malformed JSON. */
export class ProfileRefused extends Data.TaggedError("ProfileRefused")<{
  readonly status?: number
  readonly code?: string
  readonly retryAfterMillis?: number
}> {}

/** Default per-request deadline covering the full exchange. */
export const PROFILE_REQUEST_WITHIN = "15 seconds"

const RefusalBody = Schema.Struct({ code: Schema.String })
const decodeRefusal = Schema.decodeUnknownOption(Schema.fromJsonString(RefusalBody))

const retryAfter = (value: string | undefined): { readonly retryAfterMillis?: number } =>
  value !== undefined && /^\d+$/.test(value.trim()) ? { retryAfterMillis: Number(value.trim()) * 1000 } : {}

const refusedBy = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
    const body = decodeRefusal(yield* Effect.orElseSucceed(response.text, () => ""))
    return yield* new ProfileRefused({
      status: response.status,
      ...retryAfter(response.headers["retry-after"]),
      ...Option.match(body, { onNone: () => ({}), onSome: ({ code }) => ({ code }) }),
    })
  })

/** `GET /api/profiles/<owner>`: fetches a user or organization profile from ChatApi. */
export const getProfile = Effect.fn("profile.get")(function* (
  origin: string,
  owner: string,
  within: Duration.Input,
) {
  const client = yield* HttpClient.HttpClient
  const response = yield* client
    .execute(HttpClientRequest.get(`${origin}${profileRoute(owner)}`))
    .pipe(Effect.mapError(() => new ProfileRefused({})))
  if (response.status !== 200) return yield* refusedBy(response)
  yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
  return yield* response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Profile)),
    Effect.mapError(() => new ProfileRefused({ status: response.status })),
  )
}, (effect, _origin, _owner, within) =>
  effect.pipe(Effect.timeoutOrElse({ duration: within, orElse: () => Effect.fail(new ProfileRefused({})) })),
)

/** ChatApi's profile client as an injected Effect service. */
export class ProfileClient extends Context.Service<
  ProfileClient,
  { readonly get: (owner: string) => Effect.Effect<Profile, ProfileRefused> }
>()("@smthrs/mvp/profile/ProfileClient") {
  static readonly layer = (options: { readonly origin: string; readonly within?: Duration.Input }) =>
    Layer.effect(
      ProfileClient,
      Effect.map(HttpClient.HttpClient, (client) => {
        const within = options.within ?? PROFILE_REQUEST_WITHIN
        return ProfileClient.of({
          get: (owner) => getProfile(options.origin, owner, within).pipe(Effect.provideService(HttpClient.HttpClient, client)),
        })
      }),
    )
}
