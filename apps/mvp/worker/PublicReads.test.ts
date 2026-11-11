import { ConfigProvider, Effect, Option, Redacted } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpServerRequest, HttpServerResponse } from "effect/http"
import { expect, test } from "vitest"
import { GitHub } from "@smthrs/integrations"
import * as PublicReads from "./PublicReads.vibe"
import { APP_ID, appKey, REPOSITORY_ID, SCRIPTED_API, scriptedGitHub, type ScriptedGitHub } from "./github/test/scriptedGitHub.ts"

// smithers.sh's public-read route over the scripted GitHub: the App's key mints a real installation token, the route
// checks the repository's id and visibility with it, then reads. The site reaches the route in-process.
const origin = "https://smithers.test"
const site = "https://vibelang.smithers.test"
const secret = "s".repeat(32)
const reads = [{ repository: "acme/widgets", repositoryId: REPOSITORY_ID }]

const configuredWith = (github: ScriptedGitHub, overrides: Record<string, string | undefined> = {}) =>
  Effect.gen(function*() {
    const key = yield* Effect.promise(appKey)
    const values: Record<string, string> = {
      HOSTED_AUTH_SITES: JSON.stringify([{ origin: site, secret, reads }]),
      AUTH_BROKER_ORIGIN: origin,
      GITHUB_APP_ID: APP_ID,
      GITHUB_APP_PRIVATE_KEY: Redacted.value(key),
      GITHUB_API_URL: SCRIPTED_API,
      GITHUB_REPOSITORY: "acme/widgets"
    }
    for (const [name, value] of Object.entries(overrides)) {
      if (value === undefined) delete values[name]
      else values[name] = value
    }
    const http = yield* HttpClient.HttpClient.pipe(Effect.provide(github.layer))
    const setup = yield* PublicReads.configured().pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values)))
    )
    return { setup, http }
  })

/** The site's transport, with smithers.sh's route behind its network. */
const siteOver = (setup: PublicReads.Setup | undefined, github: HttpClient.HttpClient) =>
  GitHub.PublicRead.site({ origin: site, brokerOrigin: origin, secret: Redacted.make(secret), api: SCRIPTED_API }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function*() {
          const web = yield* Effect.orDie(HttpClientRequest.toWeb(request))
          const answer = yield* PublicReads.route(setup, github).pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(web))
          ) as Effect.Effect<HttpServerResponse.HttpServerResponse>
          return HttpClientResponse.fromWeb(request, HttpServerResponse.toWeb(answer))
        })
      )
    )
  )
const readme = (transport: HttpClient.HttpClient) =>
  GitHub.Contents.getText("acme", "widgets", "README.md").pipe(
    GitHub.Calls.withToken(Redacted.make(""), SCRIPTED_API),
    Effect.provideService(HttpClient.HttpClient, transport)
  )
const run = (name: string, body: Effect.Effect<void, unknown>) => test(name, () => Effect.runPromise(body))

run("a site's signed read is answered with an installation token minted for that repository alone, read-only", Effect.gen(function*() {
  const github = scriptedGitHub()
  github.files.set("README.md", "# Widgets\n")
  const { setup, http } = yield* configuredWith(github)
  const transport = yield* siteOver(setup, http)
  const first = yield* readme(transport)
  const second = yield* readme(transport)
  expect(Option.getOrUndefined(first)?.text).toBe("# Widgets\n")
  expect(Option.getOrUndefined(second)?.text).toBe("# Widgets\n")
  expect(github.minted.map((minted) => minted.body)).toEqual([{
    repository_ids: [REPOSITORY_ID],
    permissions: { contents: "read", issues: "read", pull_requests: "read", metadata: "read" }
  }])
}))

run("a private repository is never read, even when the registry lists it", Effect.gen(function*() {
  const github = scriptedGitHub()
  github.files.set("README.md", "# Widgets\n")
  github.private = true
  const { setup, http } = yield* configuredWith(github)
  const failure = yield* Effect.flip(readme(yield* siteOver(setup, http)))
  expect(failure.details?.["status"]).toBe(403)
  expect(github.calls.filter((call) => call.path.includes("/contents/"))).toEqual([])
}))

run("an invalid reads entry, no registry or no App disables the route: 503, and GitHub is never called", Effect.gen(function*() {
  const cases: Array<Record<string, string | undefined>> = [
    { HOSTED_AUTH_SITES: JSON.stringify([{ origin: site, secret, reads: [{ repository: "acme/widgets", repositoryId: 0 }] }]) },
    { HOSTED_AUTH_SITES: JSON.stringify([{ origin: site, secret, reads: [{ repository: "acme", repositoryId: 1 }] }]) },
    { HOSTED_AUTH_SITES: "not json" },
    { HOSTED_AUTH_SITES: undefined },
    { GITHUB_APP_ID: undefined },
    { GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n" },
    { AUTH_BROKER_ORIGIN: "http://smithers.test" }
  ]
  for (const overrides of cases) {
    const github = scriptedGitHub()
    const { setup, http } = yield* configuredWith(github, overrides)
    expect(setup, JSON.stringify(overrides)).toBeUndefined()
    const web = yield* HttpClientRequest.toWeb(HttpClientRequest.post(origin + GitHub.PublicRead.ROUTE).pipe(HttpClientRequest.bodyText("{}", "application/json")))
    const answer = yield* PublicReads.route(setup, http).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(web))
    ) as Effect.Effect<HttpServerResponse.HttpServerResponse>
    const response = HttpServerResponse.toWeb(answer)
    expect([response.status, response.headers.get(GitHub.PublicRead.REFUSAL)]).toEqual([503, "unavailable"])
    expect(github.calls).toEqual([])
  }
}))

run("a site with no reads signs in and reads nothing", Effect.gen(function*() {
  const github = scriptedGitHub()
  const { setup, http } = yield* configuredWith(github, { HOSTED_AUTH_SITES: JSON.stringify([{ origin: site, secret }]) })
  expect(setup?.sites).toEqual([{ origin: site, secret: expect.anything(), reads: [] }])
  const failure = yield* Effect.flip(readme(yield* siteOver(setup, http)))
  expect(failure.details?.["status"]).toBe(403)
  expect(github.minted).toEqual([])
}))
