import { Deferred, type Duration, Effect, Exit, Fiber, Redacted, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import { TestClock } from "effect/testing"
import { inspect } from "node:util"
import { afterEach, describe, expect, expectTypeOf, it } from "vitest"
import { fromIntegrationError } from "../src/core/ActionFailure.ts"
import { type IntegrationError, isIntegrationError } from "../src/core/IntegrationError.ts"
import { DEFAULT_API_BASE_URL, DEFAULT_REQUEST_TIMEOUT, resolve } from "../src/github/Config.ts"
import { isRateLimitResponse, lastPageNumber, nextPageUrl, retryAfterMs } from "../src/github/GitHubClient.ts"
import { type Fixture, json, startFixture } from "./Fixture.ts"
import {
  brokenBodyTransport,
  fetchLayer,
  gitHubClient,
  gitHubClientOver,
  gitHubConfigFailure,
  rejectingTransport
} from "./Http.ts"

const TOKEN = "ghp-fixture-token"

let fixture: Fixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

const client = () => gitHubClient({ token: TOKEN, apiBaseUrl: (fixture as Fixture).origin })

describe("GitHub config", () => {
  it("prefers explicit values, then SMITHERS_GITHUB_TOKEN, then GITHUB_TOKEN", () => {
    const env = {
      SMITHERS_GITHUB_TOKEN: "smithers",
      GITHUB_TOKEN: "github",
      SMITHERS_GITHUB_API_BASE_URL: "https://ghe.example/api/v3"
    }
    expect(resolve({ token: "explicit" }, env).token).toBe("explicit")
    expect(resolve({}, env).token).toBe("smithers")
    expect(resolve({}, { GITHUB_TOKEN: "github" }).token).toBe("github")
    expect(resolve({}, env).apiBaseUrl).toBe("https://ghe.example/api/v3")
    expect(resolve({}, {}).apiBaseUrl).toBe(DEFAULT_API_BASE_URL)
    // The client keeps no retry budget: the flow engine's retry policy is the
    // only retry a request gets.
    expect(resolve({}, {})).not.toHaveProperty("maxRetries")
  })

  it("an explicitly blank token suppresses environment credentials", () => {
    for (const token of ["", "   ", "\t\n"]) {
      expect(resolve({ token }, { SMITHERS_GITHUB_TOKEN: "smithers", GITHUB_TOKEN: "github" }).token).toBeUndefined()
    }
  })

  it("trims tokens and skips blank environment values when the token is omitted", () => {
    expect(resolve({ token: " explicit " }, {}).token).toBe("explicit")
    expect(resolve({}, { SMITHERS_GITHUB_TOKEN: " ", GITHUB_TOKEN: " padded " }).token).toBe("padded")
  })

  it("rejects an unparseable or non-HTTP API base URL as invalid-config", () => {
    for (const apiBaseUrl of ["not a url", "httpx://nope"]) {
      const failure = gitHubConfigFailure({ apiBaseUrl })
      expect(isIntegrationError(failure), apiBaseUrl).toBe(true)
      expect(failure.reason, apiBaseUrl).toBe("invalid-config")
    }
  })
})

describe("nextPageUrl", () => {
  it.each([
    "; rel=\"next\"; type=\"application/json\"",
    "; type=\"application/json\"; rel=\"next\"",
    "; rel=\"prev next\"",
    "; rel=next",
    "; title=\"a, b; rel=prev\"; rel=\"next last\"",
    "; REL = \"next\""
  ])("reads a next target with valid link parameters: %s", (parameters) => {
    expect(nextPageUrl(`<https://api.github.com/x?cursor=a,b&page=2>${parameters}`))
      .toBe("https://api.github.com/x?cursor=a,b&page=2")
  })

  it("reads the rel=next target", () => {
    expect(
      nextPageUrl("<https://api.github.com/x?page=2>; rel=\"next\", <https://api.github.com/x?page=9>; rel=\"last\"")
    )
      .toBe("https://api.github.com/x?page=2")
  })

  it("returns null when there is no next page", () => {
    expect(nextPageUrl(null)).toBeNull()
    expect(nextPageUrl("")).toBeNull()
    expect(nextPageUrl("<https://api.github.com/x?page=1>; rel=\"prev\"")).toBeNull()
    expect(nextPageUrl("<https://api.github.com/x>; title=\"a; rel=next\"; rel=\"prev\"")).toBeNull()
    expect(nextPageUrl("<https://api.github.com/x>; rel=\"nextish\"")).toBeNull()
    expect(nextPageUrl("<https://api.github.com/x>; rel=\"prev\"; rel=\"next\"")).toBeNull()
  })
})

describe("lastPageNumber", () => {
  it("reads last links with extra parameters and multiple relation tokens", () => {
    expect(lastPageNumber("</x?page=37>; title=\"last, page\"; rel=\"next last\"; type=\"application/json\"")).toBe(37)
  })

  it("reads the rel=last target's page", () => {
    expect(
      lastPageNumber(
        "<https://api.github.com/x?per_page=1&page=2>; rel=\"next\", <https://api.github.com/x?per_page=1&page=37>; rel=\"last\""
      )
    ).toBe(37)
    expect(lastPageNumber("</x?page=5>; rel=\"last\"")).toBe(5)
  })

  it("returns null without a last page, or with one that names no whole page", () => {
    expect(lastPageNumber(null)).toBeNull()
    expect(lastPageNumber("")).toBeNull()
    expect(lastPageNumber("<https://api.github.com/x?page=2>; rel=\"next\"")).toBeNull()
    expect(lastPageNumber("<https://api.github.com/x>; rel=\"last\"")).toBeNull()
    expect(lastPageNumber("<https://api.github.com/x?page=0>; rel=\"last\"")).toBeNull()
    expect(lastPageNumber("<https://api.github.com/x?page=2.5>; rel=\"last\"")).toBeNull()
    expect(lastPageNumber("<http://[::1>; rel=\"last\"")).toBeNull()
  })
})

describe("rate-limit detection", () => {
  it("counts a 429, an exhausted 403, and a secondary-limit 403", () => {
    expect(isRateLimitResponse(429, new Headers(), null)).toBe(true)
    expect(isRateLimitResponse(403, new Headers({ "x-ratelimit-remaining": "0" }), null)).toBe(true)
    expect(isRateLimitResponse(403, new Headers(), { message: "You have exceeded a secondary rate limit" })).toBe(true)
    expect(isRateLimitResponse(403, new Headers(), { message: "abuse detection" })).toBe(true)
  })

  it("does not count an ordinary 403 or a 404", () => {
    expect(isRateLimitResponse(403, new Headers({ "x-ratelimit-remaining": "42" }), { message: "Forbidden" }))
      .toBe(false)
    expect(isRateLimitResponse(404, new Headers(), { message: "Not Found" })).toBe(false)
  })

  // A 403 whose body is not JSON, or is JSON without a `message` string, is an
  // ordinary refusal. Reading it as a secondary limit would retry a request
  // GitHub has already decided about.
  it("does not count a 403 whose body names nothing", () => {
    for (const body of [null, "Forbidden", 403, { message: 403 }, {}]) {
      expect(isRateLimitResponse(403, new Headers(), body)).toBe(false)
    }
  })

  it("honors Retry-After and x-ratelimit-reset, capped at one minute", () => {
    expect(retryAfterMs(new Headers({ "retry-after": "5" }))).toBe(5000)
    expect(retryAfterMs(new Headers({ "retry-after": "600" }))).toBe(60_000)
    expect(retryAfterMs(new Headers({ "retry-after": "soon" }))).toBeNull()
    expect(retryAfterMs(new Headers({ "x-ratelimit-reset": "1010" }), 1_000_000)).toBe(10_000)
    expect(retryAfterMs(new Headers({ "x-ratelimit-reset": "900" }), 1_000_000)).toBeNull()
    expect(retryAfterMs(new Headers())).toBeNull()
  })

  it("falls back to x-ratelimit-reset when Retry-After is blank or not delay-seconds", () => {
    for (const retryAfter of ["", " ", "0x10", "1e3", "-1", "2.5"]) {
      const headers = new Headers({ "retry-after": retryAfter, "x-ratelimit-reset": "1010" })
      expect(retryAfterMs(headers, 1_000_000), JSON.stringify(retryAfter)).toBe(10_000)
    }
  })
})

describe("GitHubClient request typing", () => {
  it("names a response type only through a schema", () => {
    const offline = gitHubClient({ token: TOKEN })

    // Schemaless: the client validated nothing, so the result is `unknown`.
    const raw = offline.request("GET", "/user")
    expectTypeOf(raw).toEqualTypeOf<Effect.Effect<unknown, IntegrationError>>()

    // With a schema the result is the schema's type, and the decode ran.
    const decoded = offline.request("GET", "/user", undefined, {
      schema: Schema.Struct({ login: Schema.String })
    })
    expectTypeOf(decoded).not.toEqualTypeOf<Effect.Effect<unknown, IntegrationError>>()
    expectTypeOf(Effect.map(decoded, (viewer) => viewer.login))
      .toEqualTypeOf<Effect.Effect<string, IntegrationError>>()

    // @ts-expect-error a request without a schema cannot name its response type
    offline.request<{ login: string }>("GET", "/user")
  })
})

describe("GitHubClient over a real HTTP server", () => {
  it.each([
    null,
    "text",
    {},
    { errors: null },
    { errors: [] },
    { errors: [null, 7, {}, { type: "FORBIDDEN" }] },
    { data: { applied: true }, errors: [{ type: "RATE_LIMITED" }] }
  ])("does not mistake ordinary or partial GraphQL responses for a safe rate-limit refusal (%j)", async (body) => {
    fixture = await startFixture((_request, response) => json(response, 200, body))
    expect(await Effect.runPromise(client().request("POST", "/graphql", { query: "query { example }" }))).toEqual(body)
  })

  it("does not mistake a REST response containing GraphQL-shaped data for a rate limit", async () => {
    const body = { errors: [{ type: "RATE_LIMITED" }] }
    fixture = await startFixture((_request, response) => json(response, 200, body))
    expect(await Effect.runPromise(client().request("GET", "/x"))).toEqual(body)
  })

  it("keeps a rate limit's full Retry-After beside the wait it caps", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 403, { message: "You have exceeded a secondary rate limit" }, { "retry-after": "600" })
    )
    const error = await Effect.runPromise(Effect.flip(client().request("GET", "/repos/acme/widgets")))
    expect(error.details).toMatchObject({ rateLimited: true, retryAfterMillis: 60_000, retryAfterUncappedMillis: 600_000 })
  })

  it("keeps a bare 403's Retry-After in full, and leaves it not a rate limit", async () => {
    fixture = await startFixture((_request, response) => json(response, 403, { message: "Forbidden" }, { "retry-after": "600" }))
    const error = await Effect.runPromise(Effect.flip(client().request("GET", "/repos/acme/widgets")))
    expect(error.details).toMatchObject({ rateLimited: false, retryable: false, retryAfterUncappedMillis: 600_000 })
  })

  it("preserves the reset time of a GraphQL primary limit without Retry-After", async () => {
    const resetAt = Math.floor(Date.now() / 1_000) + 30
    fixture = await startFixture((_request, response) =>
      json(response, 200, { data: null, errors: [{}] }, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetAt)
      })
    )
    const error = await Effect.runPromise(
      Effect.flip(client().request("POST", "/graphql", { query: "query { example }" }))
    )
    expect(error.details).toMatchObject({
      rateLimited: true,
      retryable: true,
      outcomeUnknown: false,
      rateLimitResetAt: resetAt * 1_000
    })
    expect(error.details?.["retryAfterMillis"]).toBeGreaterThan(0)
    expect(error.details?.["retryAfterMillis"]).toBeLessThanOrEqual(30_000)
  })

  it.each([
    { type: "RATE_LIMITED", message: "API rate limit exceeded" },
    { message: "You have exceeded a secondary rate limit" }
  ])("classifies HTTP 200 GraphQL rate limits before schema decoding (%j)", async (error) => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, { errors: [error] }, { "retry-after": "7" })
    )
    const failure = await Effect.runPromise(Effect.flip(
      client().request("POST", "/graphql", {
        query: "mutation { example }"
      }, { schema: Schema.Struct({ data: Schema.String }) })
    ))
    expect(failure.reason).toBe("delivery-failed")
    expect(failure.details).toMatchObject({
      status: 200,
      rateLimited: true,
      retryable: true,
      outcomeUnknown: false,
      retryAfterMillis: 7_000
    })
    expect(fixture.requests).toHaveLength(1)
  })

  it("classifies a GraphQL secondary limit returned with HTTP 403", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 403, { errors: [{ message: "You have exceeded a secondary rate limit" }] }, { "retry-after": "7" })
    )
    const error = await Effect.runPromise(
      Effect.flip(client().request("POST", "/graphql", { query: "mutation { example }" }))
    )
    expect(error.details).toMatchObject({
      status: 403,
      rateLimited: true,
      retryable: true,
      outcomeUnknown: false,
      retryAfterMillis: 7_000
    })
  })

  it("sends GraphQL calls to the Enterprise GraphQL endpoint", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { data: {} }))
    await Effect.runPromise(
      gitHubClient({ token: TOKEN, apiBaseUrl: `${fixture.origin}/api/v3` }, {})
        .request("POST", "/graphql", { query: "query { viewer { login } }" })
    )
    expect(fixture.requests.map((request) => request.url)).toEqual(["/api/graphql"])
  })

  it("does not authenticate an explicitly blank token using environment credentials", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, {}))
    await Effect.runPromise(
      gitHubClient(
        { token: " ", apiBaseUrl: fixture.origin },
        { SMITHERS_GITHUB_TOKEN: "smithers", GITHUB_TOKEN: "github" }
      ).request("GET", "/user")
    )
    expect(fixture.requests[0]?.headers["authorization"]).toBeUndefined()
  })

  it("follows next links with extra parameters and relation tokens, and reports the page cap", async () => {
    fixture = await startFixture((request, response) => {
      const page = Number(new URL(request.url, "http://x").searchParams.get("page") ?? 1)
      json(response, 200, [{ id: page }], {
        link: `<${fixture!.origin}/x?page=${page + 1}>; type="application/json"; rel="next last"; title="a, b"`
      })
    })
    const page = await Effect.runPromise(client().paginate("/x", { maxPages: 2 }))
    expect(page).toEqual({ items: [{ id: 1 }, { id: 2 }], truncated: true })
    expect(fixture.requests).toHaveLength(2)
  })

  it("sends the bearer token, the API version, and a JSON body", async () => {
    fixture = await startFixture((_request, response) => json(response, 201, { id: 7, url: "https://x" }))
    const created = await Effect.runPromise(
      client().request("POST", "/repos/o/r/issues/1/comments", { body: "hello" })
    )
    expect(created).toEqual({ id: 7, url: "https://x" })
    const [sent] = fixture.requests
    expect(sent?.headers["authorization"]).toBe(`Bearer ${TOKEN}`)
    expect(sent?.headers["user-agent"]).toBe("smithers-integrations")
    expect(sent?.headers["x-github-api-version"]).toBe("2022-11-28")
    expect(sent?.headers["content-type"]).toBe("application/json")
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({ body: "hello" })
  })

  it("appends query parameters and skips undefined ones", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, []))
    await Effect.runPromise(
      client().request("GET", "/search/issues", undefined, {
        query: { q: "is:open", page: 2, draft: false, skip: undefined }
      })
    )
    const url = new URL(`${fixture.origin}${fixture.requests[0]?.url}`)
    expect(url.searchParams.get("q")).toBe("is:open")
    expect(url.searchParams.get("page")).toBe("2")
    expect(url.searchParams.get("draft")).toBe("false")
    expect(url.searchParams.has("skip")).toBe(false)
  })

  it("decodes a response through a schema and fails loudly when it does not match", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { number: 12, title: "t" }))
    const schema = Schema.Struct({ number: Schema.Number, title: Schema.String })
    expect(await Effect.runPromise(client().request("GET", "/issues/12", undefined, { schema })))
      .toEqual({ number: 12, title: "t" })

    await fixture.close()
    fixture = await startFixture((_request, response) => json(response, 200, { number: "twelve" }))
    const exit = await Effect.runPromise(
      Effect.exit(client().request("GET", "/issues/12", undefined, { schema }))
    )
    expect(exit._tag).toBe("Failure")
  })

  it("follows Link rel=next and concatenates the pages", async () => {
    fixture = await startFixture((request, response) => {
      const page = new URL(`http://x${request.url}`).searchParams.get("page") ?? "1"
      if (page === "1") {
        json(response, 200, [{ id: 1 }, { id: 2 }], {
          link: `<${(fixture as Fixture).origin}/repos/o/r/hooks?page=2>; rel="next"`
        })
        return
      }
      json(response, 200, [{ id: 3 }])
    })
    const page = await Effect.runPromise(client().paginate("/repos/o/r/hooks"))
    expect(page.items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
    expect(page.truncated).toBe(false)
    expect(new URL(`http://x${fixture.requests[0]?.url}`).searchParams.get("per_page")).toBe("100")
  })

  // A truncated list read as a complete one is how a reconciliation plans work
  // for resources it simply did not see, so the cap has to be reported.
  it("stops at maxPages and says the answer is truncated", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, [{ id: 1 }], { link: `<${(fixture as Fixture).origin}/x?page=9>; rel="next"` })
    )
    const page = await Effect.runPromise(client().paginate("/x", { perPage: 1, maxPages: 2 }))
    expect(page.items).toHaveLength(2)
    expect(page.truncated).toBe(true)
    expect(fixture.requests).toHaveLength(2)
  })

  it("refuses a page budget that is not a finite bound", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, []))
    for (const options of [{ maxPages: Number.POSITIVE_INFINITY }, { maxPages: 0 }, { perPage: 1000 }]) {
      const failure = await Effect.runPromise(Effect.flip(client().paginate("/x", options)))
      expect(failure.reason).toBe("invalid-config")
    }
    expect(fixture.requests).toHaveLength(0)
  })

  it("wraps a single object page rather than dropping it", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { id: 1 }))
    expect((await Effect.runPromise(client().paginate("/x"))).items).toEqual([{ id: 1 }])
  })

  // A JSON `null` body is the absence of a resource, not a resource. Pushing it
  // would put a `null` member into a list every caller then dereferences.
  it("contributes nothing for a page whose body is JSON null", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, null))
    const page = await Effect.runPromise(client().paginate("/x"))
    expect(page.items).toEqual([])
    expect(page.truncated).toBe(false)
  })

  it("counts a list from its last page at one item per page, and answers its first item", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, [{ name: "main" }], {
        link: `<${(fixture as Fixture).origin}/repos/o/r/branches?per_page=1&page=2>; rel="next", ` +
          `<${(fixture as Fixture).origin}/repos/o/r/branches?per_page=1&page=42>; rel="last"`
      })
    )
    const counted = await Effect.runPromise(client().count("/repos/o/r/branches", { query: { protected: false } }))
    expect(counted).toEqual({ total: 42, first: { name: "main" } })
    expect(fixture.requests).toHaveLength(1)
    const url = new URL(`http://x${fixture.requests[0]?.url}`)
    expect(url.searchParams.get("per_page")).toBe("1")
    expect(url.searchParams.get("protected")).toBe("false")
  })

  it.each([undefined, { page: 3 }])("counts from page one despite a final caller page and query %j", async (query) => {
    fixture = await startFixture((request, response) => {
      const page = new URL(request.url, "http://x").searchParams.get("page")
      json(
        response,
        200,
        [{ id: page === "1" ? 1 : 3 }],
        page === "1"
          ? { link: `<${fixture!.origin}/items?page=3>; rel="last"` }
          : {}
      )
    })
    expect(await Effect.runPromise(client().count("/items?page=3", { query }))).toEqual({ total: 3, first: { id: 1 } })
  })

  it("counts a list with no last page as what its one page holds", async () => {
    fixture = await startFixture((request, response) => {
      const path = new URL(`http://x${request.url}`).pathname
      if (path === "/one") json(response, 200, [{ id: 1 }])
      else if (path === "/object") json(response, 200, { id: 2 })
      else if (path === "/null") json(response, 200, null)
      else json(response, 200, [])
    })
    expect(await Effect.runPromise(client().count("/one"))).toEqual({ total: 1, first: { id: 1 } })
    expect(await Effect.runPromise(client().count("/object"))).toEqual({ total: 1, first: { id: 2 } })
    expect(await Effect.runPromise(client().count("/null"))).toEqual({ total: 0, first: undefined })
    expect(await Effect.runPromise(client().count("/empty"))).toEqual({ total: 0, first: undefined })
  })

  it("fails a count GitHub refuses with the request's classified failure", async () => {
    fixture = await startFixture((_request, response) => json(response, 404, { message: "Not Found" }))
    const failure = await Effect.runPromise(Effect.flip(client().count("/repos/o/missing/tags")))
    expect(failure.details).toMatchObject({ status: 404, retryable: false })
  })

  // The flow engine decides every retry, durably. The client makes one request
  // per call and hands the engine what it needs to decide: whether another
  // attempt may help, and how long the server asked to wait.
  it("fails a 429 after one request, carrying its Retry-After for the engine", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 429, { message: "rate limited" }, { "retry-after": "2" })
    )
    const failure = await Effect.runPromise(Effect.flip(client().request("GET", "/x")))
    expect(fixture.requests).toHaveLength(1)
    expect(failure.details).toMatchObject({ status: 429, retryable: true, rateLimited: true, retryAfterMillis: 2_000 })
    expect(fromIntegrationError(failure)).toMatchObject({ retryable: true, retryAfterMillis: 2_000 })
  })

  it("fails a 5xx read after one request, retryable, with the wait it named", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 503, { message: "unavailable" }, { "retry-after": "3", "x-ratelimit-reset": "9999999999" })
    )
    const failure = await Effect.runPromise(Effect.flip(client().request("GET", "/x")))
    expect(fixture.requests).toHaveLength(1)
    expect(failure.details).toMatchObject({ status: 503, retryable: true, rateLimited: false, retryAfterMillis: 3_000 })
  })

  // `x-ratelimit-reset` rides on every GitHub response. It says when the
  // primary budget refills, which says nothing about when a 5xx clears, so only
  // a rate limit reads it.
  it("does not turn a 5xx's rate-limit reset into a wait", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 502, { message: "bad gateway" }, { "x-ratelimit-reset": "9999999999" })
    )
    const failure = await Effect.runPromise(Effect.flip(client().request("GET", "/x")))
    expect(failure.details).toMatchObject({ retryable: true })
    expect(failure.details).not.toHaveProperty("retryAfterMillis")
  })

  it("carries a secondary rate limit's wait, and a spent budget's reset", async () => {
    const resetAt = Math.floor(Date.now() / 1_000) + 30
    fixture = await startFixture((request, response) =>
      request.url === "/secondary"
        ? json(response, 403, { message: "You have exceeded a secondary rate limit" }, { "retry-after": "60" })
        : json(response, 403, { message: "API rate limit exceeded" }, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetAt)
        })
    )
    const secondary = await Effect.runPromise(Effect.flip(client().request("POST", "/secondary", { a: 1 })))
    expect(secondary.details).toMatchObject({
      status: 403,
      retryable: true,
      rateLimited: true,
      outcomeUnknown: false,
      retryAfterMillis: 60_000
    })
    const spent = await Effect.runPromise(Effect.flip(client().request("GET", "/primary")))
    expect(spent.details).toMatchObject({ retryable: true, rateLimited: true })
    const wait = spent.details?.["retryAfterMillis"] as number
    expect(wait).toBeGreaterThan(20_000)
    expect(wait).toBeLessThanOrEqual(30_000)
    // The reset itself, uncapped, for telling a person when GitHub answers again; a secondary limit names none.
    expect(spent.details?.["rateLimitResetAt"]).toBe(resetAt * 1000)
    expect(secondary.details).not.toHaveProperty("rateLimitResetAt")
    expect(fixture.requests).toHaveLength(2)
  })

  // GitHub may have committed the write and lost the answer, so repeating a
  // POST posts a second comment. The action's tier says irreversible; the
  // client has to mean it.
  it("issues an unsafe write exactly once when the server errors", async () => {
    fixture = await startFixture((_request, response) => json(response, 502, { message: "bad gateway" }))
    for (const method of ["POST", "PATCH", "PUT", "DELETE"] as const) {
      const before = fixture.requests.length
      const failure = await Effect.runPromise(Effect.flip(client().request(method, "/repos/o/r/x", { a: 1 })))
      expect(fixture.requests.length - before).toBe(1)
      expect(failure.details).toMatchObject({ outcomeUnknown: true, retryable: false })
      expect(failure.message).toContain("outcome unknown")
    }
  })

  it("issues an unsafe write exactly once when the transport fails", async () => {
    fixture = await startFixture((_request, response) => {
      response.destroy()
    })
    const failure = await Effect.runPromise(Effect.flip(client().request("POST", "/x", { a: 1 })))
    expect(fixture.requests).toHaveLength(1)
    expect(failure.details).toMatchObject({ outcomeUnknown: true, retryable: false })
  })

  it("joins a path that carries no leading slash", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, { ok: true }))
    await Effect.runPromise(client().request("GET", "repos/o/r"))
    expect(fixture.requests[0]?.url).toBe("/repos/o/r")
  })

  // A rate limit is a refusal, not an ambiguous outcome: the request was not
  // performed, so repeating it is safe for any verb.
  it("classifies a rate-limited write as retryable, because it was refused rather than applied", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 429, { message: "rate limited" }, { "retry-after": "0" })
    )
    const failure = await Effect.runPromise(Effect.flip(client().request("POST", "/x", { a: 1 })))
    expect(fixture.requests).toHaveLength(1)
    expect(failure.details).toMatchObject({ retryable: true, outcomeUnknown: false, retryAfterMillis: 0 })
  })

  it("classifies a lost write as retryable when the caller says the endpoint is idempotent", async () => {
    fixture = await startFixture((_request, response) => json(response, 502, { message: "bad gateway" }))
    const failure = await Effect.runPromise(
      Effect.flip(client().request("PUT", "/x", { a: 1 }, { retryUnsafeWrites: true }))
    )
    expect(fixture.requests).toHaveLength(1)
    expect(failure.details).toMatchObject({ retryable: true, outcomeUnknown: true })
    expect(failure.message).toContain("outcome unknown")
  })

  // `new URL("httpx")` throws a bare TypeError, which used to escape the
  // declared IntegrationError channel as a defect.
  it("fails invalid-config for a path that is not a URL rather than dying", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, {}))
    const failure = await Effect.runPromise(Effect.flip(client().request("GET", "httpx")))
    expect(failure.reason).toBe("invalid-config")
    expect(fixture.requests).toHaveLength(0)
  })

  // A read is repeatable by definition, so its failure must never claim the
  // outcome is in doubt.
  it("never marks a read's failure outcome-unknown", async () => {
    fixture = await startFixture((_request, response) => json(response, 502, { message: "bad gateway" }))
    const failure = await Effect.runPromise(Effect.flip(client().request("GET", "/x")))
    expect(failure.details).toMatchObject({ outcomeUnknown: false, retryable: true })
    expect(fixture.requests).toHaveLength(1)
  })

  // The boundary that matters: the budget was spent exactly, and the last page
  // had no successor, so the answer is complete rather than truncated.
  it("reports a walk that ends exactly on the budget as complete", async () => {
    fixture = await startFixture((request, response) => {
      const page = new URL(`http://x${request.url}`).searchParams.get("page") ?? "1"
      if (page === "1") {
        json(response, 200, [{ id: 1 }], { link: `<${(fixture as Fixture).origin}/x?page=2>; rel="next"` })
        return
      }
      json(response, 200, [{ id: 2 }])
    })
    const page = await Effect.runPromise(client().paginate("/x", { perPage: 1, maxPages: 2 }))
    expect(page.items).toEqual([{ id: 1 }, { id: 2 }])
    expect(page.truncated).toBe(false)
    expect(fixture.requests).toHaveLength(2)
  })

  it("does not retry a 404", async () => {
    fixture = await startFixture((_request, response) => json(response, 404, { message: "Not Found" }))
    const exit = await Effect.runPromise(Effect.exit(client().request("GET", "/x")))
    expect(exit._tag).toBe("Failure")
    expect(fixture.requests).toHaveLength(1)
  })

  it("classifies a failure with the status, the path, and no token", async () => {
    fixture = await startFixture((_request, response) => json(response, 404, { message: "Not Found" }))
    const failure = await Effect.runPromise(
      Effect.flip(client().request("GET", "/repos/o/r/issues/9"))
    )
    expect(isIntegrationError(failure)).toBe(true)
    expect(failure.reason).toBe("delivery-failed")
    expect(failure.details).toMatchObject({ status: 404, path: "/repos/o/r/issues/9", retryable: false })
    expect(JSON.stringify(failure.details)).not.toContain(TOKEN)
    expect(failure.message).not.toContain(TOKEN)
  })

  // The token is on every request, so a URL that leaves the configured origin
  // would hand it to someone else. A redirected `rel=next` is the realistic
  // way that happens.
  it("refuses a request URL that leaves the configured API origin", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, {}))
    const failure = await Effect.runPromise(
      Effect.flip(client().request("GET", "https://evil.example/steal"))
    )
    expect(failure.message).toContain("is not the configured GitHub API origin")
    expect(fixture.requests).toHaveLength(0)
  })

  it("refuses a rel=next page on a foreign origin", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, [{ id: 1 }], { link: "<https://evil.example/page2>; rel=\"next\"" })
    )
    const failure = await Effect.runPromise(Effect.flip(client().paginate("/x")))
    expect(failure.message).toContain("is not the configured GitHub API origin")
  })

  // RFC 8288 resolves a relative link target against the URL it came from.
  it("follows a relative rel=next target against the page that named it", async () => {
    fixture = await startFixture((request, response) =>
      request.url?.includes("page=2")
        ? json(response, 200, [{ id: 2 }])
        : json(response, 200, [{ id: 1 }], { link: "</x?page=2>; rel=\"next\"" })
    )
    const page = await Effect.runPromise(client().paginate("/x"))
    expect(page).toEqual({ items: [{ id: 1 }, { id: 2 }], truncated: false })
    expect(fixture.requests.map((request) => request.url)).toEqual(["/x?per_page=100", "/x?page=2"])
  })

  it("fails a rel=next target that is not a URL as a typed error, not a defect", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 200, [{ id: 1 }], { link: "<http://[::1>; rel=\"next\"" })
    )
    const exit = await Effect.runPromiseExit(client().paginate("/x"))
    expect(Exit.isFailure(exit) && exit.cause.reasons.every((reason) => reason._tag === "Fail")).toBe(true)
    const failure = await Effect.runPromise(Effect.flip(client().paginate("/x")))
    expect(isIntegrationError(failure) && failure.reason).toBe("delivery-failed")
    expect(failure.message).toContain("rel=\"next\"")
  })

  it("returns a non-JSON body as text rather than failing", async () => {
    fixture = await startFixture((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" })
      response.end("plain")
    })
    expect(await Effect.runPromise(client().request("GET", "/x"))).toBe("plain")
  })

  it("returns null for an empty body", async () => {
    fixture = await startFixture((_request, response) => {
      response.writeHead(204)
      response.end()
    })
    expect(await Effect.runPromise(client().request("DELETE", "/x"))).toBeNull()
  })

  it("names the status alone when the error body carries no message", async () => {
    fixture = await startFixture((_request, response) => json(response, 418, { detail: "teapot" }))
    const failure = await Effect.runPromise(Effect.flip(client().request("GET", "/x")))
    expect(failure.summary).toBe("GitHub request failed: GET /x -> 418")
  })

  it("interrupting the fiber aborts the request in flight", async () => {
    fixture = await startFixture(() => {
      // Never answers: the only way out is the interrupt.
    })
    const server = fixture
    // The fixture, not a duration, says when the request is in flight and when
    // its socket closed, so a loaded machine cannot interrupt before the
    // server ever saw the request. Interrupting the fiber is the interruption
    // a cancelled run delivers.
    const exit = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(client().request("GET", "/hang"))
        yield* Effect.promise(() => server.arrived)
        yield* Fiber.interrupt(fiber)
        yield* Effect.timeout(Effect.promise(() => server.closed), "10 seconds")
        return yield* Effect.exit(Fiber.join(fiber))
      })
    )
    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(server.requests).toHaveLength(1)
  })

  // A caller that passes its own environment must not have an ambient
  // GITHUB_TOKEN decide which account a call runs as.
  it("omits the Authorization header when the supplied environment has no token", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, {}))
    await Effect.runPromise(gitHubClient({ apiBaseUrl: fixture.origin }, {}).request("GET", "/x"))
    expect(fixture.requests[0]?.headers["authorization"]).toBeUndefined()
  })

  // GitHub authenticates `/applications/{client_id}/...` as the App's OAuth
  // client: HTTP Basic with the client id and secret, never a user's token.
  it("authenticates as an App's client with Basic credentials in place of any token, and redacts them", async () => {
    const secret = "client-secret:with/reserved chars"
    const clientCredentials = { clientId: "Iv1.fixture", clientSecret: Redacted.make(secret) }
    fixture = await startFixture((_request, response) => json(response, 422, { message: `Bad ${secret}` }))
    const failure = await Effect.runPromise(Effect.flip(
      gitHubClient({ clientCredentials, token: TOKEN, apiBaseUrl: fixture.origin }, { GITHUB_TOKEN: "ambient" })
        .request("DELETE", "/applications/Iv1.fixture/token", { access_token: "ghu_user" })
    ))
    const [sent] = fixture.requests
    const basic = btoa(`Iv1.fixture:${encodeURIComponent(secret)}`)
    expect(sent?.method).toBe("DELETE")
    expect(sent?.headers["authorization"]).toBe(`Basic ${basic}`)
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({ access_token: "ghu_user" })
    expect(failure.details).toMatchObject({ status: 422 })
    expectRedacted(failure, secret)
    expectRedacted(failure, basic)
  })
})

describe("a body that cannot be serialized", () => {
  // The throw used to happen inside the transport attempt, where every failure
  // is a lost answer, so a request that was never sent was reported as a write
  // whose outcome nobody knows.
  it("is caller input, not an unknown write outcome", async () => {
    fixture = await startFixture((_request, response) => json(response, 201, {}))
    const cyclic: Record<string, unknown> = {}
    cyclic["self"] = cyclic
    const failure = await Effect.runPromise(Effect.flip(client().request("POST", "/x", cyclic)))
    expect(failure.reason).toBe("invalid-config")
    expect(failure.details).toMatchObject({ outcomeUnknown: false, retryable: false })
    expect(fixture.requests).toHaveLength(0)
  })
})

describe("text GitHub or the transport wrote", () => {
  it("reaches the journal with the token removed", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 401, { message: `Bad credentials: ${TOKEN} is not valid` })
    )
    const failure = await Effect.runPromise(Effect.flip(client().request("GET", "/user")))
    expect(failure.message).not.toContain(TOKEN)
    expect(failure.message).toContain("Bad credentials: [REDACTED] is not valid")
    expect(fromIntegrationError(failure).message).not.toContain(TOKEN)
  })

  // An injected transport fault: no server can make the transport itself
  // reject with a message that quotes the token.
  it("reaches the journal with the token removed when the transport itself reports it", async () => {
    const transport = rejectingTransport(new Error(`proxy rejected authorization ${TOKEN}`))
    const failure = await Effect.runPromise(
      Effect.flip(
        gitHubClientOver(transport, { token: TOKEN, apiBaseUrl: "https://api.github.test" })
          .request("GET", "/user")
      )
    )
    expect(failure.message).not.toContain(TOKEN)
    expect(failure.message).toContain("proxy rejected authorization [REDACTED]")
    expect(fromIntegrationError(failure).message).not.toContain(TOKEN)
  })
})

describe("a transport failure without a cause", () => {
  // An HttpClient of the caller's own may fail with no underlying cause. The
  // failure then names the client's own description, never "undefined".
  it("reports the client's own message", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        gitHubClientOver(rejectingTransport(undefined), {
          token: TOKEN,
          apiBaseUrl: "https://api.github.test"
        }).request("GET", "/user")
      )
    )
    expect(failure.reason).toBe("delivery-failed")
    expect(failure.summary).toBe("GitHub request failed: GET - Transport error (GET https://api.github.test/user)")
    expect(failure.details).toMatchObject({ retryable: true, outcomeUnknown: false })
  })
})

// Inspect includes non-enumerable cause/stack fields that JSON serialization omits.
const expectRedacted = (failure: IntegrationError, secret: string) => {
  expect(inspect(failure, { depth: null })).not.toContain(secret)
  expect(JSON.stringify(failure)).not.toContain(secret)
  expect(JSON.stringify(fromIntegrationError(failure))).not.toContain(secret)
}

describe("credential redaction", () => {
  // Injected transport faults: a send that rejects, and a body read that fails
  // with an Error or with a bare string.
  it.each(["transport", "body", "primitive"])("sanitizes a %s failure and its retained cause", async (stage) => {
    const message = `rejected Bearer ${TOKEN}; ${TOKEN}; Bearer ${TOKEN}`
    const cause = Object.assign(new Error(message, { cause: new Error(message) }), { authorization: message })
    const transport = stage === "transport"
      ? rejectingTransport(cause)
      : brokenBodyTransport(stage === "primitive" ? message : cause)
    const failure = await Effect.runPromise(
      Effect.flip(gitHubClientOver(transport, { token: TOKEN }).request("POST", "/user"))
    )
    expectRedacted(failure, TOKEN)
    expect(failure.cause).toBeInstanceOf(Error)
    expect((failure.cause as Error).message).toBe("rejected [REDACTED]; [REDACTED]; [REDACTED]")
    expect(failure.details).toMatchObject({ outcomeUnknown: true })
  })
})

it("redacts a provider message, repeated tokens, response headers, and paths", async () => {
  fixture = await startFixture((_request, response) =>
    json(response, 401, { message: `Bearer ${TOKEN} rejected ${TOKEN} ${TOKEN}` }, {
      "x-ratelimit-remaining": TOKEN
    })
  )
  const failure = await Effect.runPromise(Effect.flip(
    gitHubClient({ token: TOKEN, apiBaseUrl: fixture.origin }, {}).request("GET", `/${TOKEN}`)
  ))
  expectRedacted(failure, TOKEN)
  expect(failure.summary).toContain("[REDACTED] rejected [REDACTED] [REDACTED]")
  expect(failure.details).toMatchObject({ ratelimitRemaining: "[REDACTED]", path: "/[REDACTED]" })
})

it("redacts credentials retained by a schema decoding error", async () => {
  fixture = await startFixture((_request, response) => json(response, 200, TOKEN))
  const failure = await Effect.runPromise(Effect.flip(
    gitHubClient({ token: TOKEN, apiBaseUrl: fixture.origin }, {}).request("GET", "/user", undefined, {
      schema: Schema.Number
    })
  ))
  expectRedacted(failure, TOKEN)
})

// A peer that answers with headers and then trickles the body forever holds
// the call, and the step around it, open: an attempt that never completes is
// one no retry policy ever sees.
describe("GitHub request deadline", () => {
  const stalled = (onClose: () => void) =>
    startFixture((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.write("{\"id\":")
      response.on("close", onClose)
    })

  const deadlined = (extra: { readonly requestTimeout?: Duration.Input } = {}) =>
    gitHubClient({
      token: TOKEN,
      apiBaseUrl: (fixture as Fixture).origin,
      requestTimeout: "200 millis",
      ...extra
    })

  it("fails a stalled read within the deadline and closes the socket", async () => {
    let closed!: () => void
    const socketClosed = new Promise<void>((resolve) => {
      closed = resolve
    })
    fixture = await stalled(closed)
    const started = Date.now()
    const failure = await Effect.runPromise(Effect.flip(deadlined().request("GET", "/user")))
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(failure.reason).toBe("delivery-failed")
    expect(failure.summary).toContain("timed out")
    // Nothing was applied by a read, so it stays repeatable.
    expect(failure.details).toMatchObject({ timedOut: true, outcomeUnknown: false, retryable: true })
    await socketClosed
  })

  it("reports a timed-out write as an unknown outcome", async () => {
    fixture = await stalled(() => {})
    const failure = await Effect.runPromise(
      Effect.flip(deadlined().request("POST", "/repos/o/r/issues/1/comments", { body: "hi" }))
    )
    expect(failure.details).toMatchObject({ timedOut: true, outcomeUnknown: true, retryable: false })
    expect(failure.summary).toContain("outcome unknown")
  })

  it("refuses a deadline that is not finite and positive", () => {
    for (const requestTimeout of [0, -1, "Infinity"] as const) {
      const failure = gitHubConfigFailure({ token: TOKEN, requestTimeout })
      expect(isIntegrationError(failure) && failure.reason, String(requestTimeout)).toBe("invalid-config")
    }
    expect(resolve({}, {}).requestTimeout).toEqual(DEFAULT_REQUEST_TIMEOUT)
  })
})

describe("GitHub redirects", () => {
  // A 3xx is answered, not followed: the redirected request would re-send the
  // bearer token, and a write's body, to wherever the Location header points.
  it.each([["GET", 302], ["POST", 307]] as const)(
    "fails a %s answered %i to another origin and never sends the token there",
    async (method, status) => {
      const elsewhere = await startFixture((_request, response) => json(response, 200, { stolen: true }))
      try {
        fixture = await startFixture((_request, response) => {
          response.writeHead(status, { location: `${elsewhere.origin}/captured` })
          response.end()
        })
        const body = method === "GET" ? undefined : { a: 1 }
        const failure = await Effect.runPromise(Effect.flip(client().request(method, "/x", body)))
        expect(failure.reason).toBe("delivery-failed")
        expect(failure.details).toMatchObject({ status, retryable: false })
        expect(fixture.requests.map((request) => request.url)).toEqual(["/x"])
        expect(elsewhere.requests).toHaveLength(0)
        // The control: the same fetch transport, unconfigured, follows the
        // redirect, so it is the client's configuration that stopped it.
        await Effect.runPromise(Effect.provide(HttpClient.get(`${fixture.origin}/x`), fetchLayer))
        expect(elsewhere.requests).toHaveLength(1)
      } finally {
        await elsewhere.close()
      }
    }
  )
})

describe("GitHub proxy refusals", () => {
  it("fails rate-limited once, with the proxy's retry instant, and does not repeat the request", async () => {
    const retryAt = new Date(Date.now() + 120_000).toISOString()
    fixture = await startFixture((_request, response) =>
      json(response, 429, { message: "API rate limit: deferred" }, {
        "retry-after": "120",
        "x-smithers-retry-at": retryAt,
        "x-smithers-rate-limit-reason": "paused"
      })
    )
    const failure = await Effect.runPromise(Effect.flip(client().request("POST", "/repos/o/r/issues")))
    expect(failure.reason).toBe("rate-limited")
    expect(failure.details).toMatchObject({
      status: 429,
      retryAt,
      reason: "paused",
      retryable: false,
      rateLimited: true,
      outcomeUnknown: false,
      path: "/repos/o/r/issues"
    })
    expect(fixture.requests).toHaveLength(1)
    expect(fromIntegrationError(failure).reason).toBe("rate-limited")
  })

  it("treats a 429 without the proxy's instant as GitHub's own, retryable limit", async () => {
    fixture = await startFixture((_request, response) =>
      json(response, 429, { message: "rate limited" }, { "x-smithers-retry-at": "never" })
    )
    const failure = await Effect.runPromise(Effect.flip(client().request("GET", "/x")))
    expect(failure.reason).toBe("delivery-failed")
    expect(failure.details).toMatchObject({ retryable: true, rateLimited: true })
    expect(fixture.requests).toHaveLength(1)
  })
})

describe("write safety regressions", () => {
  it.each(["bearer", "basic"])("preserves configured loopback HTTP for %s authentication", async (kind) => {
    fixture = await startFixture((_request, response) => json(response, 200, { authenticated: true }))
    const config = kind === "bearer"
      ? { token: TOKEN }
      : { clientCredentials: { clientId: "app", clientSecret: Redacted.make("secret") } }
    const local = gitHubClient({ ...config, apiBaseUrl: fixture.origin }, {})
    expect(await Effect.runPromise(local.request("GET", "/x"))).toEqual({ authenticated: true })
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0]?.headers["authorization"]).toBe(
      kind === "bearer" ? `Bearer ${TOKEN}` : `Basic ${btoa("app:secret")}`
    )
  })

  it.each(["transport", "body"])("retains unknown outcome with unsafe retries after a %s failure", async (stage) => {
    const transport = stage === "transport"
      ? rejectingTransport(new Error("lost response"))
      : brokenBodyTransport(new Error("lost body"))
    const failure = await Effect.runPromise(Effect.flip(
      gitHubClientOver(transport, { token: TOKEN }).request("POST", "/x", {}, { retryUnsafeWrites: true })
    ))
    expect(failure.details).toMatchObject({ retryable: true, outcomeUnknown: true })
    expect(failure.message).toContain("outcome unknown")
  })

  it("retains unknown outcome with unsafe retries after a deadline", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const transport = HttpClient.make(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
        const client = gitHubClientOver(transport, { token: TOKEN, requestTimeout: "1 second" })
        const fiber = yield* Effect.forkChild(
          Effect.flip(client.request("POST", "/x", {}, { retryUnsafeWrites: true }))
        )
        yield* Deferred.await(started)
        yield* TestClock.adjust("1 second")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer()))
    )
    expect(failure.details).toMatchObject({ timedOut: true, retryable: true, outcomeUnknown: true })
  })

  it.each([false, true])("allows anonymous HTTP with an explicit blank token: %s", async (blankToken) => {
    fixture = await startFixture((_request, response) => json(response, 200, { anonymous: true }))
    const config = { apiBaseUrl: fixture.origin, ...(blankToken ? { token: " " } : {}) }
    const anonymous = gitHubClient(config, blankToken ? { GITHUB_TOKEN: TOKEN } : {})
    expect(await Effect.runPromise(anonymous.request("GET", "/x"))).toEqual({ anonymous: true })
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0]?.headers["authorization"]).toBeUndefined()
  })
})
