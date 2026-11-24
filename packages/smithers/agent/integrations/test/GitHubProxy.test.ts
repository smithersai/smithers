/**
 * The GitHub proxy over real sockets: a fixture server stands in for
 * api.github.com, the proxy listens on an ephemeral port and calls it over the
 * real fetch transport, and clients reach it by URL, including two separate
 * Node processes.
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { Clock, Context, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { HttpClient, HttpClientRequest, HttpServerRequest } from "effect/http"
import * as HttpServer from "effect/http/HttpServer"
import { TestClock } from "effect/testing"
import { execFile } from "node:child_process"
import { createServer, request as httpRequest } from "node:http"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { IntegrationError } from "../src/core/IntegrationError.ts"
import {
  type Credential,
  DEFAULT_MAX_BODY_BYTES,
  layer,
  make,
  PEOPLE_ONLY,
  type ProxyOptions,
  repositoryOf
} from "../src/github/Proxy.ts"
import { DEFAULT_LIMITS } from "../src/github/RateLimit.ts"
import { type Fixture, json, startFixture } from "./Fixture.ts"
import { fetchLayer, gitHubClient as client } from "./Http.ts"

const TOKEN = "ghs_operator_token"
const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

const github = async (handler: Parameters<typeof startFixture>[0]): Promise<Fixture> => {
  const fixture = await startFixture(handler)
  closers.push(fixture.close)
  return fixture
}

const operator = (repository: string | undefined): Effect.Effect<Credential, IntegrationError> =>
  Effect.succeed(
    repository?.startsWith("other/")
      ? { token: "ghs_other", principal: "app:other" }
      : { token: TOKEN, principal: "gh-user" }
  )

/** Serves the proxy on an ephemeral loopback port. */
const proxy = async (upstream: Fixture, options: Partial<ProxyOptions> = {}): Promise<string> => {
  const scope = Effect.runSync(Scope.make())
  const context = await Effect.runPromise(Layer.buildWithScope(
    Layer.provideMerge(
      layer({ upstream: upstream.origin, credential: operator, ...options }),
      Layer.merge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" }), fetchLayer)
    ),
    scope
  ))
  closers.push(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  const address = Context.get(context, HttpServer.HttpServer).address as { readonly port: number }
  return `http://127.0.0.1:${address.port}`
}

describe("GitHub proxy forwarding", () => {
  it("injects the operator's credential and drops the caller's", async () => {
    const upstream = await github((_request, response) => json(response, 201, { id: 1 }, { "set-cookie": "a=b" }))
    const origin = await proxy(upstream)
    const response = await fetch(`${origin}/repos/o/r/issues/1/comments?x=1`, {
      method: "POST",
      headers: {
        authorization: "Bearer caller-token",
        cookie: "session=1",
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json"
      },
      body: JSON.stringify({ body: "hello" })
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ id: 1 })
    expect(response.headers.get("set-cookie")).toBeNull()
    const [sent] = upstream.requests
    expect(sent).toMatchObject({
      method: "POST",
      url: "/repos/o/r/issues/1/comments?x=1",
      body: "{\"body\":\"hello\"}"
    })
    expect(sent?.headers["authorization"]).toBe(`Bearer ${TOKEN}`)
    expect(sent?.headers["cookie"]).toBeUndefined()
    expect(sent?.headers["x-github-api-version"]).toBe("2022-11-28")
  })

  it("keeps pagination on the proxy", async () => {
    const upstream = await github((_request, response) =>
      json(response, 200, [1], { link: `<${upstream.origin}/repos/o/r/issues?page=2>; rel="next"` })
    )
    const origin = await proxy(upstream)
    const page = await fetch(`${origin}/repos/o/r/issues`)
    expect(page.headers.get("link")).toBe(`<${origin}/repos/o/r/issues?page=2>; rel="next"`)
  })

  // Following GitHub's redirect would send the operator's credential, which
  // the proxy injected, to the origin the Location names.
  it.each([["GET", 302], ["POST", 307]] as const)(
    "answers a %s redirected %i to another origin without following it",
    async (method, status) => {
      const elsewhere = await github((_request, response) => json(response, 200, { stolen: true }))
      const upstream = await github((_request, response) => {
        response.writeHead(status, { location: `${elsewhere.origin}/captured` })
        response.end()
      })
      const origin = await proxy(upstream)
      const moved = await fetch(`${origin}/repos/o/r/issues`, {
        method,
        redirect: "manual",
        ...(method === "GET" ? {} : { body: "{}" })
      })
      expect(moved.status).toBe(status)
      expect(moved.headers.get("location")).toBe(`${elsewhere.origin}/captured`)
      expect(upstream.requests.map((request) => request.headers["authorization"])).toEqual([`Bearer ${TOKEN}`])
      expect(elsewhere.requests).toHaveLength(0)
    }
  )

  it("lets a GitHubClient paginate through it with no token of its own", async () => {
    const upstream = await github((request, response) =>
      request.url.includes("page=2")
        ? json(response, 200, [2])
        : json(response, 200, [1], { link: `<${upstream.origin}/repos/o/r/issues?page=2>; rel="next"` })
    )
    const origin = await proxy(upstream)
    const page = await Effect.runPromise(client({ apiBaseUrl: origin }, {}).paginate("/repos/o/r/issues"))
    expect(page).toEqual({ items: [1, 2], truncated: false })
    expect(upstream.requests.every((request) => request.headers["authorization"] === `Bearer ${TOKEN}`)).toBe(true)
  })

  it("answers 502 when GitHub is unreachable and 504 when it does not answer in time", async () => {
    const upstream = await github(() => undefined)
    const unreachable = await proxy({ ...upstream, origin: "http://127.0.0.1:1" })
    expect((await fetch(`${unreachable}/x`)).status).toBe(502)
    const slow = await proxy(upstream, { requestTimeout: "100 millis" })
    expect((await fetch(`${slow}/x`)).status).toBe(504)
  })

  it("answers 502 with the reason when no credential is available", async () => {
    const upstream = await github((_request, response) => json(response, 200, {}))
    const origin = await proxy(upstream, {
      credential: () => Effect.fail(new IntegrationError("credentials-missing", "No GitHub token."))
    })
    const response = await fetch(`${origin}/repos/o/r`)
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ message: "No GitHub token.", reason: "credentials-missing" })
    expect(upstream.requests).toHaveLength(0)
  })
})

/** One in-memory exchange with the proxy application, for a request no socket client can send. */
const exchange = (options: ProxyOptions, request: HttpServerRequest.HttpServerRequest) =>
  Effect.runPromise(
    Effect.flatMap(
      make(options),
      (app) => app.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))
    ).pipe(Effect.provide(fetchLayer))
  )

const GRAPHQL_REVIEW =
  "mutation($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { clientMutationId } }"

// People approve and merge; agents never do. Each of these would act with the operator's token.
const PEOPLE_ACTIONS: ReadonlyArray<readonly [name: string, method: string, path: string, body: string]> = [
  ["a pull request merge", "PUT", "/repos/o/r/pulls/7/merge", "{\"merge_method\":\"squash\"}"],
  ["a merge in another case", "PUT", "/REPOS/o/r/PULLS/7/MERGE", "{}"],
  ["a percent-encoded merge", "PUT", "/repos/o/r/pulls/7/%6Derge", "{}"],
  ["a merge behind empty segments", "PUT", "//repos/o/r/pulls/7/merge/", "{}"],
  ["a branch merge", "POST", "/repos/o/r/merges", "{\"base\":\"main\",\"head\":\"x\"}"],
  ["an approval", "POST", "/repos/o/r/pulls/7/reviews", "{\"event\":\"APPROVE\"}"],
  ["a change request", "POST", "/repos/o/r/pulls/7/reviews", "{\"event\":\"REQUEST_CHANGES\",\"body\":\"no\"}"],
  ["a review that is not JSON", "POST", "/repos/o/r/pulls/7/reviews", "event=APPROVE"],
  ["a review that is not an object", "POST", "/repos/o/r/pulls/7/reviews", "[{\"event\":\"COMMENT\"}]"],
  ["a submitted approval", "POST", "/repos/o/r/pulls/7/reviews/9/events", "{\"event\":\"APPROVE\"}"],
  ["a submission naming no event", "POST", "/repos/o/r/pulls/7/reviews/9/events", "{}"],
  ["a dismissal", "PUT", "/repos/o/r/pulls/7/reviews/9/dismissals", "{\"message\":\"stale\"}"],
  ["a path that is not percent-encoding", "PUT", "/repos/o/r/pulls/7/%zz", "{}"],
  [
    "a GraphQL merge",
    "POST",
    "/graphql",
    JSON.stringify({ query: "mutation { m: mergePullRequest(input: {pullRequestId: \"PR_1\"}) { clientMutationId } }" })
  ],
  [
    "GraphQL auto-merge on an Enterprise path",
    "POST",
    "/api/graphql",
    JSON.stringify({
      query: "mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"PR_1\"}) { clientMutationId } }"
    })
  ],
  [
    "a GraphQL dismissal",
    "POST",
    "/graphql",
    JSON.stringify({
      query:
        "mutation { dismissPullRequestReview(input: {pullRequestReviewId: \"R\", message: \"x\"}) { clientMutationId } }"
    })
  ],
  [
    "a GraphQL approval named in the variables",
    "POST",
    "/graphql",
    JSON.stringify({ query: GRAPHQL_REVIEW, variables: { input: { pullRequestId: "PR_1", event: "APPROVE" } } })
  ],
  [
    "a GraphQL approval named in the document",
    "POST",
    "/graphql",
    JSON.stringify({
      query: "mutation { addPullRequestReview(input: {pullRequestId: \"PR_1\", event: APPROVE}) { clientMutationId } }"
    })
  ],
  ["a GraphQL request that is not JSON", "POST", "/graphql", "mutation { mergePullRequest }"],
  ["a GraphQL request with no query", "POST", "/graphql", "{\"variables\":{}}"]
]

// What an agent may still send on the same routes.
const AGENT_ACTIONS: ReadonlyArray<readonly [name: string, method: string, path: string, body: string | undefined]> = [
  [
    "a comment review",
    "POST",
    "/repos/o/r/pulls/7/reviews",
    "{\"event\":\"COMMENT\",\"body\":\"I would APPROVE this\"}"
  ],
  ["a pending review", "POST", "/repos/o/r/pulls/7/reviews", "{\"body\":\"draft\"}"],
  ["a submitted comment review", "POST", "/repos/o/r/pulls/7/reviews/9/events", "{\"event\":\"COMMENT\"}"],
  ["an edited review body", "PUT", "/repos/o/r/pulls/7/reviews/9", "{\"body\":\"edited\"}"],
  ["a review comment reply", "POST", "/repos/o/r/pulls/7/comments", "{\"body\":\"merge\"}"],
  ["a branch update", "PUT", "/repos/o/r/pulls/7/update-branch", "{}"],
  ["the merged check", "GET", "/repos/o/r/pulls/7/merge", undefined],
  ["a write outside repositories", "POST", "/user/repos", "{\"name\":\"merge\"}"],
  ["a GraphQL query", "POST", "/graphql", JSON.stringify({ query: "query { viewer { login } }" })],
  [
    "a GraphQL comment review whose text says APPROVE",
    "POST",
    "/graphql",
    JSON.stringify({
      query:
        "mutation($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { clientMutationId } } # \"APPROVE\"",
      variables: { input: { pullRequestId: "PR_1", event: "COMMENT", body: "I would APPROVE this", n: 1, x: null } }
    })
  ],
  [
    "a GraphQL comment review written inline",
    "POST",
    "/graphql",
    JSON.stringify({
      query:
        "mutation { addPullRequestReview(input: {event: COMMENT, body: \"\"\"APPROVE\"\"\", pullRequestId: \"PR_1\"}) { clientMutationId } }"
    })
  ]
]

describe("GitHub proxy people-only actions", () => {
  it.each(PEOPLE_ACTIONS)(
    "refuses %s without a credential or a request to GitHub",
    async (_name, method, path, body) => {
      const upstream = await github((_request, response) => json(response, 200, { merged: true }))
      let credentials = 0
      const origin = await proxy(upstream, {
        credential: (repository) => {
          credentials++
          return operator(repository)
        }
      })
      const response = await fetch(`${origin}${path}`, { method, body })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ reason: PEOPLE_ONLY })
      expect(upstream.requests).toHaveLength(0)
      expect(credentials).toBe(0)
    }
  )

  it.each(AGENT_ACTIONS)("forwards %s", async (_name, method, path, body) => {
    const upstream = await github((_request, response) => json(response, 200, {}))
    const origin = await proxy(upstream)
    const response = await fetch(`${origin}${path}`, { method, ...(body === undefined ? {} : { body }) })
    expect(response.status).toBe(200)
    expect(upstream.requests.map((request) => [request.method, request.url, request.body])).toEqual([
      [method, path, body ?? ""]
    ])
  })

  it("forwards a merge only from a proxy configured for a person's own actions", async () => {
    const upstream = await github((_request, response) => json(response, 200, { merged: true }))
    const origin = await proxy(upstream, { forwardPeopleActions: true })
    const response = await fetch(`${origin}/repos/o/r/pulls/7/merge`, { method: "PUT", body: "{}" })
    expect(await response.json()).toEqual({ merged: true })
    expect(upstream.requests.map((request) => request.url)).toEqual(["/repos/o/r/pulls/7/merge"])
  })
})

describe("GitHub proxy request bodies", () => {
  it("answers 413 for a body past the limit, declared or streamed, and forwards one at it", async () => {
    const upstream = await github((_request, response) => json(response, 201, {}))
    const origin = await proxy(upstream, { maxBodyBytes: 8 })
    const declared = await fetch(`${origin}/repos/o/r/issues`, { method: "POST", body: "123456789" })
    expect(declared.status).toBe(413)
    expect(await declared.json()).toEqual({ message: "The request body is larger than 8 bytes" })
    // A chunked body declares no length; the proxy counts what arrives.
    const chunks = [new TextEncoder().encode("12345"), new TextEncoder().encode("6789")]
    const streamed = await fetch(`${origin}/repos/o/r/issues`, {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks.shift()
          if (chunk === undefined) controller.close()
          else controller.enqueue(chunk)
        }
      }),
      duplex: "half"
    } as RequestInit)
    expect(streamed.status).toBe(413)
    expect(upstream.requests).toHaveLength(0)
    expect((await fetch(`${origin}/repos/o/r/issues`, { method: "POST", body: "12345678" })).status).toBe(201)
    expect(upstream.requests.map((request) => request.body)).toEqual(["12345678"])
    expect(DEFAULT_MAX_BODY_BYTES).toBe(32 * 1024 * 1024)
  })

  it("answers 400, not a defect, when the caller never finishes its body", async () => {
    const upstream = await github((_request, response) => json(response, 201, {}))
    // A body stream that fails mid-read is what a reset connection is to the proxy.
    const response = await exchange(
      { upstream: upstream.origin, credential: operator },
      HttpServerRequest.fromWeb(
        new Request("http://proxy.invalid/repos/o/r/issues", {
          method: "POST",
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("connection reset"))
            }
          }),
          duplex: "half"
        } as RequestInit)
      )
    )
    expect(response.status).toBe(400)
    expect(upstream.requests).toHaveLength(0)
  })
})

describe("GitHub proxy pagination origin", () => {
  const paged = () =>
    github((_request, response) =>
      json(response, 200, [1], { link: `<${upstreamOrigin.value}/repos/o/r/issues?page=2>; rel="next"` })
    )
  const upstreamOrigin = { value: "" }

  it("names the configured public origin, scheme included", async () => {
    const upstream = await paged()
    upstreamOrigin.value = upstream.origin
    const origin = await proxy(upstream, { publicOrigin: "https://github-proxy.example/ignored" })
    const page = await fetch(`${origin}/repos/o/r/issues`)
    expect(page.headers.get("link")).toBe("<https://github-proxy.example/repos/o/r/issues?page=2>; rel=\"next\"")
  })

  it("refuses a Host that is not a host name and port before calling GitHub", async () => {
    const upstream = await paged()
    upstreamOrigin.value = upstream.origin
    const origin = await proxy(upstream)
    // fetch sets Host itself, so a raw request sends the hostile one.
    const status = await new Promise<number>((resolve, reject) => {
      httpRequest(`${origin}/repos/o/r/issues`, { headers: { host: "evil.example/>; rel=\"next\", <http://x" } }, (
        response
      ) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      }).on("error", reject).end()
    })
    expect(status).toBe(400)
    expect(upstream.requests).toHaveLength(0)
  })

  it("names the path alone for a request that carries no Host", async () => {
    const upstream = await paged()
    upstreamOrigin.value = upstream.origin
    const response = await exchange(
      { upstream: upstream.origin, credential: operator },
      HttpServerRequest.fromWeb(new Request("http://proxy.invalid/repos/o/r/issues"))
    )
    expect(response.headers["link"]).toBe("</repos/o/r/issues?page=2>; rel=\"next\"")
  })
})

describe("GitHub proxy route case", () => {
  it("routes /REPOS/ to the repository's credential and forwards the canonical path", async () => {
    const upstream = await github((_request, response) => json(response, 200, {}))
    const origin = await proxy(upstream)
    expect((await fetch(`${origin}/REPOS/other/r/issues?x=1`)).status).toBe(200)
    expect(upstream.requests.map((request) => [request.url, request.headers["authorization"]])).toEqual([
      ["/repos/other/r/issues?x=1", "Bearer ghs_other"]
    ])
  })
})

describe("GitHub proxy capability", () => {
  it("refuses a caller without the capability and forwards one with it", async () => {
    const upstream = await github((_request, response) => json(response, 200, {}))
    const origin = await proxy(upstream, { capability: "cap-secret" })
    expect((await fetch(`${origin}/repos/o/r`)).status).toBe(401)
    expect((await fetch(`${origin}/repos/o/r`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401)
    // As long as the capability, or extending it: refused without a length shortcut.
    expect((await fetch(`${origin}/repos/o/r`, { headers: { authorization: "Bearer cap-secreX" } })).status).toBe(401)
    expect((await fetch(`${origin}/repos/o/r`, { headers: { authorization: "Bearer cap-secret2" } })).status).toBe(401)
    expect((await fetch(`${origin}/_smithers/admission?repo=o/r`)).status).toBe(401)
    expect(upstream.requests).toHaveLength(0)
    const ok = await fetch(`${origin}/repos/o/r`, { headers: { authorization: "token cap-secret" } })
    expect(ok.status).toBe(200)
    expect(upstream.requests[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`)
  })
})

describe("GitHub proxy control endpoints", () => {
  it("answers health, refuses unknown control paths, and reports admission without booking", async () => {
    const upstream = await github((_request, response) => json(response, 201, {}))
    const origin = await proxy(upstream, { limits: { ...DEFAULT_LIMITS, writeSpacingMs: 30_000 } })
    expect(await (await fetch(`${origin}/_smithers/health`)).json()).toEqual({ ok: true })
    expect((await fetch(`${origin}/_smithers/nope`)).status).toBe(404)
    expect((await fetch(`${origin}/_smithers/admission?writes=x`)).status).toBe(400)
    const idle = await (await fetch(`${origin}/_smithers/admission?repo=o/r&writes=2`)).json()
    expect(idle).toMatchObject({ principal: "gh-user", deferred: false })
    // Writes 30 s apart: three fit a one-minute wait, four do not.
    expect((await (await fetch(`${origin}/_smithers/admission?repo=o/r&writes=4`)).json()).deferred).toBe(true)
    await fetch(`${origin}/repos/o/r/issues`, { method: "POST", body: "{}" })
    const busy = await (await fetch(`${origin}/_smithers/admission?repo=o/r&writes=2`)).json()
    expect(busy.deferred).toBe(false)
    expect(Date.parse(busy.startsAt) - Date.now()).toBeGreaterThan(50_000)
    expect(await (await fetch(`${origin}/_smithers/admission?repo=other/r&writes=1`)).json())
      .toMatchObject({ principal: "app:other", deferred: false })
    // No repository and no writes: the read-only admission of the principal without a repository.
    expect(await (await fetch(`${origin}/_smithers/admission`)).json()).toMatchObject({ principal: "gh-user" })
  })

  it("defaults to api.github.com and GitHub's limits", async () => {
    const upstream = await github((_request, response) => json(response, 201, {}))
    const sent: Array<{ readonly url: string; readonly at: number }> = []
    await Effect.runPromise(
      Effect.gen(function*() {
        const real = yield* HttpClient.HttpClient
        // Record the actual target before routing the real transport to the local fixture.
        const transport = HttpClient.make((request) =>
          Effect.gen(function*() {
            sent.push({ url: request.url, at: yield* Clock.currentTimeMillis })
            return yield* real.execute(HttpClientRequest.setUrl(
              request,
              request.url.replace(new URL(request.url).origin, upstream.origin)
            ))
          })
        )
        const app = yield* make({ credential: operator }).pipe(
          Effect.provideService(HttpClient.HttpClient, transport)
        )
        // An in-memory body keeps request preparation synchronous before TestClock advances.
        const write = () =>
          app.pipe(Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromClientRequest(
              HttpClientRequest.post("http://proxy.invalid/repos/o/r/issues").pipe(HttpClientRequest.bodyText("{}"))
            )
          ))
        expect((yield* write()).status).toBe(201)
        const second = yield* Effect.forkChild(write())
        yield* TestClock.adjust("999 millis")
        expect(sent).toEqual([{ url: "https://api.github.com/repos/o/r/issues", at: 0 }])
        yield* TestClock.adjust("1 millis")
        expect((yield* Fiber.join(second)).status).toBe(201)
        expect(sent).toEqual([
          { url: "https://api.github.com/repos/o/r/issues", at: 0 },
          { url: "https://api.github.com/repos/o/r/issues", at: 1000 }
        ])
      }).pipe(Effect.provide(fetchLayer), Effect.provide(TestClock.layer()))
    )
    expect(upstream.requests.map((request) => [request.method, request.url, request.body])).toEqual([
      ["POST", "/repos/o/r/issues", "{}"],
      ["POST", "/repos/o/r/issues", "{}"]
    ])
  })
})

describe("GitHub proxy rate limit", () => {
  it("pauses every caller of a principal after GitHub's secondary limit, and only that principal", async () => {
    let refuse = true
    const upstream = await github((_request, response) =>
      refuse
        ? json(response, 403, { message: "You have exceeded a secondary rate limit" }, { "retry-after": "120" })
        : json(response, 200, {})
    )
    const origin = await proxy(upstream)
    const first = await fetch(`${origin}/repos/o/r/issues`, { method: "POST", body: "{}" })
    expect(first.status).toBe(403)
    refuse = false
    const deferred = await fetch(`${origin}/repos/o/r`)
    expect(deferred.status).toBe(429)
    expect(Number(deferred.headers.get("retry-after"))).toBeGreaterThan(100)
    expect(deferred.headers.get("x-smithers-rate-limit-reason")).toBe("paused")
    expect((await deferred.json()).message).toMatch(/rate limit/)
    // A GitHubClient reads the refusal as a typed failure with the instant to retry.
    const failure = await Effect.runPromise(
      Effect.flip(client({ apiBaseUrl: origin }, {}).request("GET", "/repos/o/r"))
    )
    expect(failure.reason).toBe("rate-limited")
    expect(Date.parse(String(failure.details?.["retryAt"]))).toBeGreaterThan(Date.now() + 100_000)
    // Another principal's budget is its own.
    expect((await fetch(`${origin}/repos/other/r`)).status).toBe(200)
    expect(upstream.requests.map((request) => request.url)).toEqual(["/repos/o/r/issues", "/repos/other/r"])
  })

  it("spaces the writes of two concurrent client processes as one queue", async () => {
    const upstream = await github((_request, response) => json(response, 201, {}))
    const origin = await proxy(upstream, { limits: { ...DEFAULT_LIMITS, writeSpacingMs: 250 } })
    const source = new URL("../src/github/GitHubClient.ts", import.meta.url).href
    const writer = `
      import { Effect } from "effect"
      import { FetchHttpClient } from "effect/http"
      import { make } from ${JSON.stringify(source)}
      await Effect.runPromise(Effect.gen(function*() {
        const github = yield* make({ apiBaseUrl: process.argv[1] }, {})
        yield* Effect.all(
          [1, 2, 3].map((n) => github.request("POST", "/repos/o/r/issues/1/comments", { body: String(n) })),
          { concurrency: "unbounded" }
        )
      }).pipe(Effect.provide(FetchHttpClient.layer)))
    `
    const spawn = () =>
      promisify(execFile)(process.execPath, ["--input-type=module", "-e", writer, origin], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        timeout: 30_000
      })
    await Promise.all([spawn(), spawn()])
    const arrivals = upstream.requests.map((request) => request.receivedAt).sort((a, b) => a - b)
    expect(arrivals).toHaveLength(6)
    // The proxy starts each write 250 ms after the last; loopback latency jitters arrival by a few ms.
    for (let i = 1; i < arrivals.length; i++) expect(arrivals[i]! - arrivals[i - 1]!).toBeGreaterThanOrEqual(200)
    expect(upstream.requests.every((request) => request.headers["authorization"] === `Bearer ${TOKEN}`)).toBe(true)
  }, 60_000)
})

describe("repositoryOf", () => {
  it("names the repository a REST path addresses", () => {
    expect(repositoryOf("/repos/smithersai/smithers/issues/1")).toBe("smithersai/smithers")
    expect(repositoryOf("/repos/o/r")).toBe("o/r")
    expect(repositoryOf("/repos/o/r?x=1")).toBe("o/r")
    expect(repositoryOf("/user")).toBeUndefined()
    expect(repositoryOf("/repos/o")).toBeUndefined()
    expect(repositoryOf("/REPOS/o/r/pulls/1")).toBe("o/r")
  })
})
