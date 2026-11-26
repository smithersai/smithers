import { type Duration, Effect, Layer } from "effect"
import { HttpClient, HttpClientError, type HttpClientRequest, HttpClientResponse } from "effect/http"
import { describe, expect, test } from "vitest"
import { getProfile, PROFILE_REQUEST_WITHIN, ProfileClient, ProfileRefused } from "./api.vibe"
import type { Profile as ProfileData } from "./schema"

// ChatApi's profile route through the real Effect HttpClient, its transport answering as the test says.

const ada: ProfileData = {
  kind: "User",
  login: "ada",
  name: "Ada",
  avatarUrl: null,
  bio: null,
  company: null,
  location: null,
  website: null,
  twitter: null,
  pronouns: null,
  status: null,
  followers: 1,
  following: 2,
  publicRepos: 3,
  createdAt: null,
  organizations: [],
  pinned: [],
  repositories: [],
  readme: null,
  contributions: null,
}

const transport = (
  respond: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<Response, HttpClientError.HttpClientError>,
) => {
  const urls: Array<string> = []
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      urls.push(request.url)
      return Effect.map(respond(request), (response) => HttpClientResponse.fromWeb(request, response))
    }),
  )
  return { urls, layer }
}

const answering = (response: () => Response) => transport(() => Effect.sync(response))

const refusal = (http: { readonly layer: Layer.Layer<HttpClient.HttpClient> }, within: Duration.Input = PROFILE_REQUEST_WITHIN) =>
  Effect.runPromise(Effect.flip(getProfile("https://app.test", "ada", within).pipe(Effect.provide(http.layer))))

describe("features/profile api", () => {
  test("a 200 with a profile answers it, through the layer's default deadline", async () => {
    const http = answering(() => Response.json(ada))
    const profile = await Effect.runPromise(
      Effect.flatMap(ProfileClient, (client) => client.get("a b")).pipe(
        Effect.provide(ProfileClient.layer({ origin: "https://app.test" }).pipe(Layer.provide(http.layer))),
      ),
    )
    expect(profile).toEqual(ada)
    expect(http.urls).toEqual(["https://app.test/api/profiles/a%20b"])
  })

  test("the layer's own deadline refuses a stalled answer with no status", async () => {
    const http = transport(() => Effect.never)
    const error = await Effect.runPromise(Effect.flip(
      Effect.flatMap(ProfileClient, (client) => client.get("ada")).pipe(
        Effect.provide(ProfileClient.layer({ origin: "https://app.test", within: "20 millis" }).pipe(Layer.provide(http.layer))),
      ),
    ))
    expect(error).toEqual(new ProfileRefused({}))
  })

  test("a transport failure is refused with no status", async () => {
    const http = transport((request) =>
      Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request }) })))
    expect(await refusal(http)).toEqual(new ProfileRefused({}))
  })

  test("a 200 that isn't JSON, or isn't a profile, is refused with its status", async () => {
    expect(await refusal(answering(() => new Response("not json", { status: 200 })))).toEqual(new ProfileRefused({ status: 200 }))
    expect(await refusal(answering(() => Response.json({ login: 7 })))).toEqual(new ProfileRefused({ status: 200 }))
  })

  test("a refusal carries its status, code and whole-second Retry-After", async () => {
    const error = await refusal(answering(() =>
      Response.json({ code: "rate_limited" }, { status: 429, headers: { "retry-after": " 30 " } })))
    expect(error).toEqual(new ProfileRefused({ status: 429, retryAfterMillis: 30_000, code: "rate_limited" }))
  })

  test("a refusal whose body names no code and whose Retry-After is a date carries its status alone", async () => {
    const error = await refusal(answering(() =>
      new Response("<html>", { status: 503, headers: { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" } })))
    expect(error).toEqual(new ProfileRefused({ status: 503 }))
  })

  test("a refusal whose body can't be read carries its status alone", async () => {
    const broken = new ReadableStream({ start: (controller) => controller.error(new Error("reset")) })
    expect(await refusal(answering(() => new Response(broken, { status: 502 })))).toEqual(new ProfileRefused({ status: 502 }))
  })
})
