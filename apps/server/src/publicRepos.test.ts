import { describe, expect, test } from "bun:test"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { configLayer } from "./Config"
import type { ServerEnvVars } from "./Config"
import { EdgeCache, githubAppAuthLayer, memoryEdgeCache } from "./githubApp"
import type { EdgeCacheShape } from "./githubApp"
import { transportLayer } from "./Http"
import type { FetchImplementation } from "./Http"
import { AVAILABLE_REPOS, COMING_SOON_REPOS } from "./publicRepoCatalog"
import type { PublicComingSoonRepository, PublicRepoCatalog, PublicRepository } from "./publicRepoCatalog"
import { makePublicReposHandler } from "./publicRepos"

/** The roster a claimed-repo wave will produce; the launch catalog holds only Smithers. */
const CLAIMED_ROSTER = [
  ...AVAILABLE_REPOS,
  { name: "example/claimed", title: "claimed", url: "https://github.com/example/claimed", summary: "claimed is an example." },
  { name: "example/later", title: "later", url: "https://github.com/example/later", summary: "later is an example." }
] as const

/** Every name the handler may fetch, in fetch order: the claimed wave, then the coming-soon roster. */
const EVERY_NAME: ReadonlyArray<string> = [...CLAIMED_ROSTER.map((repo) => repo.name), ...COMING_SOON_REPOS.map((repo) => repo.name)]

/** GitHub metadata for one roster entry. Stars encode the roster position so order mistakes are visible. */
const metadataFor = (name: string) => {
  const index = EVERY_NAME.indexOf(name)
  return {
    full_name: name, private: false,
    stargazers_count: 407 + index * 1000, forks_count: 50 + index, open_issues_count: 4 + index,
    language: "TypeScript", license: { spdx_id: "MIT" },
    permissions: { admin: true }, irrelevant: "never public"
  }
}

const metadata = metadataFor("smithersai/smithers")

const repoName = (req: Request) => new URL(req.url).pathname.replace("/repos/", "")

const answerEach = (req: Request) => Response.json(metadataFor(repoName(req)))

const expectedRepos = (stats: (name: string) => PublicRepoCatalog["repos"][number]["stats"]) =>
  AVAILABLE_REPOS.map((repo) => ({ name: repo.name, title: repo.title, url: repo.url, summary: repo.summary, stats: stats(repo.name) }))

const expectedComingSoon = (stats: (name: string) => PublicRepoCatalog["repos"][number]["stats"]) =>
  COMING_SOON_REPOS.map((repo) => ({ name: repo.name, title: repo.title, url: repo.url, stats: stats(repo.name) }))

/** The GitHub metadata URLs one refresh fetches, roster order first and the coming-soon roster after. */
const fetchedUrls = (repos: ReadonlyArray<{ name: string }> = AVAILABLE_REPOS) =>
  [...repos, ...COMING_SOON_REPOS].map((repo) => `https://api.github.com/repos/${repo.name}`)

const FETCH_COUNT = AVAILABLE_REPOS.length + COMING_SOON_REPOS.length

const request = (query = "") => new Request(`https://app.test/api/public/repos${query}`, {
  headers: { origin: "https://smithers.sh", cookie: "session=private", authorization: "Bearer private" }
})

/** A clock the test moves by hand; sleeps (deadlines) still run on the real timer. */
const testClock = (start: number) => {
  let now = start
  const real = Clock.Clock.defaultValue()
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: real.monotonicTimeNanos,
    sleep: (duration) => real.sleep(duration)
  }
  return { clock, advance: (ms: number) => { now += ms } }
}

interface HarnessOptions {
  readonly answer?: (req: Request) => Response | Promise<Response>
  readonly repos?: ReadonlyArray<Pick<PublicRepository, "name" | "title" | "url" | "summary">>
  readonly comingSoon?: ReadonlyArray<Pick<PublicComingSoonRepository, "name" | "title" | "url">>
  /** The Worker's vars and secrets, as the deployment binds them. */
  readonly env?: ServerEnvVars
  readonly edge?: EdgeCacheShape
}

/**
 * One Worker isolate: a catalog handler over an injected transport, config,
 * edge cache, clock, and the real `githubAppAuthLayer`. `handlers(n)` builds
 * more isolates over the same services, for the edge-cache test.
 */
const harness = (options: HarnessOptions = {}) => {
  const answer = options.answer ?? answerEach
  const { clock, advance } = testClock(1_000)
  const requests: Array<Request> = []
  const fetchImpl: FetchImplementation = async (input, init) => {
    const req = new Request(input, init)
    requests.push(req)
    return answer(req)
  }
  const services = Layer.mergeAll(
    transportLayer(fetchImpl),
    configLayer(options.env ?? {}),
    Layer.succeed(EdgeCache, options.edge ?? memoryEdgeCache()),
    Layer.succeed(Clock.Clock, clock)
  )
  const runtime = ManagedRuntime.make(githubAppAuthLayer.pipe(Layer.provideMerge(services)))
  const roster = { repos: options.repos ?? AVAILABLE_REPOS, comingSoon: options.comingSoon ?? COMING_SOON_REPOS }
  const handler = makePublicReposHandler(roster)
  const serve = (req: Request) => runtime.runPromise(handler(req))
  return {
    handler: serve,
    /** N concurrent readers of this isolate, as N fibers. */
    concurrently: (reqs: ReadonlyArray<Request>) =>
      runtime.runPromise(Effect.all(reqs.map((req) => handler(req)), { concurrency: "unbounded" })),
    /** Another isolate over the same transport, edge cache, and clock. */
    coldIsolate: () => {
      const cold = makePublicReposHandler(roster)
      return (req: Request) => runtime.runPromise(cold(req))
    },
    requests,
    advance
  }
}

const TOKEN = "ghp_test_token_never_served"

/**
 * A real RSA key pair for the GitHub App secrets: the handler signs an App JWT
 * with it, so these tests exercise the same WebCrypto path the Worker runs.
 */
const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" },
  true,
  ["sign", "verify"]
)
const exported = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
let exportedBinary = ""
for (const byte of exported) exportedBinary += String.fromCharCode(byte)
const APP_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${btoa(exportedBinary).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`
const APP_ENV: ServerEnvVars = { SMITHERS_GITHUB_APP_ID: "4163546", SMITHERS_GITHUB_APP_PRIVATE_KEY: APP_PRIVATE_KEY }
const INSTALLATION_TOKEN = "ghs_installation_token_never_served"

/** Lets the refresh fiber run until it has issued its fetches. */
const flush = async (until: () => boolean) => {
  for (let tick = 0; tick < 50 && !until(); tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

const pathOf = (req: Request) => new URL(req.url).pathname
const appCalls = (requests: ReadonlyArray<Request>) => requests.filter((req) => pathOf(req).startsWith("/app/")).map(pathOf)
const statsCalls = (requests: ReadonlyArray<Request>) => requests.filter((req) => pathOf(req).startsWith("/repos/"))

/** GitHub as the App sees it: the installation lookup, the token exchange, then the metadata reads. */
const asTheApp = (
  installations: unknown = [{ id: 150824198, account: { login: "smithersai" }, repository_selection: "all" }],
  token: string = INSTALLATION_TOKEN
) =>
(req: Request) => {
  if (pathOf(req) === "/app/installations") return Response.json(installations)
  if (pathOf(req).endsWith("/access_tokens")) return Response.json({ token }, { status: 201 })
  return answerEach(req)
}

describe("the curated catalog", () => {
  test("lists only Smithers at launch", () => {
    expect(AVAILABLE_REPOS.map((repo) => repo.name)).toEqual(["smithersai/smithers"])
  })

  test("names the Smithers Cloud mirror for every entry without publishing it", async () => {
    for (const repo of AVAILABLE_REPOS) {
      expect(repo.cloudRepo).toMatch(/^[a-z\d-]+\/[a-z\d_.-]+$/)
    }
    const { handler } = harness()
    const catalog = await (await handler(request())).json() as PublicRepoCatalog
    for (const repo of catalog.repos) {
      expect(Object.keys(repo).sort()).toEqual(["name", "stats", "summary", "title", "url"])
    }
    for (const repo of catalog.comingSoon!) {
      expect(Object.keys(repo).sort()).toEqual(["name", "stats", "title", "url"])
    }
  })

  test("links every entry to the GitHub repository its stats are fetched from", () => {
    for (const repo of [...AVAILABLE_REPOS, ...COMING_SOON_REPOS]) {
      expect(repo.url).toBe(`https://github.com/${repo.name}`)
      expect(repo.title.length).toBeGreaterThan(0)
    }
  })

  test("shows Smithers' direct and second-ring dependencies, its VCS, and the web app's dependencies as coming soon, in the landing page's order", () => {
    expect(COMING_SOON_REPOS.map((repo) => [repo.name, repo.title])).toEqual([
      ["Effect-TS/effect", "Effect"],
      ["wevm/incur", "incur"],
      ["bombshell-dev/clack", "clack"],
      ["jj-vcs/jj", "jj"],
      ["modelcontextprotocol/typescript-sdk", "MCP TypeScript SDK"],
      ["GitoxideLabs/gitoxide", "gitoxide"],
      ["TanStack/db", "TanStack DB"],
      ["xyflow/xyflow", "xyflow"],
      ["blackboardsh/electrobun", "Electrobun"],
      ["withastro/starlight", "Starlight"]
    ])
  })

  test("a coming-soon repository is never available", () => {
    // The Worker's routed app page and the Cloud mirror lookup consult
    // AVAILABLE_REPOS alone (index.test.ts covers the page each path serves).
    const available = AVAILABLE_REPOS.map((repo) => repo.name.toLowerCase())
    for (const repo of COMING_SOON_REPOS) {
      expect(available).not.toContain(repo.name.toLowerCase())
    }
  })

  test("explains every entry in one curated sentence the app's welcome can read", () => {
    for (const repo of AVAILABLE_REPOS) {
      // One sentence: a capital, one terminal period, no sentence break inside.
      expect(repo.summary).toMatch(/^[A-Z].*\.$/)
      expect(repo.summary.split(/[.!?]\s/).length).toBe(1)
      // The welcome speaks it as the repository's own introduction, so it names the title first.
      expect(repo.summary.startsWith(`${repo.title} is `)).toBe(true)
    }
  })
})

describe("public available repositories", () => {
  test("serves every approved repo in catalog order with basic stats, without using caller credentials", async () => {
    const { handler, requests } = harness()
    const response = await handler(request("?repo=private/secret&url=https://evil.test"))
    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    expect(response.headers.get("cache-control")).toBe("public, max-age=300")
    const catalog = await response.json() as PublicRepoCatalog
    const statsOf = (name: string) => {
      const github = metadataFor(name)
      return {
        stars: github.stargazers_count, forks: github.forks_count, openIssuesAndPulls: github.open_issues_count,
        language: "TypeScript", license: "MIT"
      }
    }
    expect(catalog).toEqual({ repos: expectedRepos(statsOf), comingSoon: expectedComingSoon(statsOf) })
    expect(catalog.repos[0]).toMatchObject({ name: "smithersai/smithers", stats: { stars: 407 } })
    expect(catalog.comingSoon!.map((repo) => repo.name)).toEqual([
      "Effect-TS/effect", "wevm/incur", "bombshell-dev/clack", "jj-vcs/jj", "modelcontextprotocol/typescript-sdk", "GitoxideLabs/gitoxide",
      "TanStack/db", "xyflow/xyflow", "blackboardsh/electrobun", "withastro/starlight"
    ])
    expect(catalog.comingSoon![0]).toMatchObject({ name: "Effect-TS/effect", stats: { stars: 3407 } })
    expect(requests.map((req) => req.url)).toEqual(fetchedUrls())
    for (const req of requests) {
      expect(req.headers.has("authorization")).toBe(false)
      expect(req.headers.has("cookie")).toBe(false)
      // workerd throws on redirect: "error" before sending; only "follow" and "manual" are accepted.
      expect(req.redirect).toBe("manual")
    }
  })

  test("fetches every repo in a claimed roster concurrently, and one failing repo never nulls the others", async () => {
    const pending = new Map<string, (response: Response) => void>()
    const { handler, requests } = harness({
      answer: (req) => new Promise((resolve) => { pending.set(repoName(req), resolve) }),
      repos: CLAIMED_ROSTER
    })
    const served = handler(request())
    // A refresh first asks the GitHub App layer for a bearer (undefined here,
    // with no secrets set), then issues every metadata read before any answers.
    const expected = CLAIMED_ROSTER.length + COMING_SOON_REPOS.length
    await flush(() => requests.length === expected)
    expect(requests).toHaveLength(expected)
    expect([...pending.keys()]).toEqual([...CLAIMED_ROSTER.map((repo) => repo.name), ...COMING_SOON_REPOS.map((repo) => repo.name)])
    pending.get("example/later")!(answerEach(requests[2]!))
    pending.get("example/claimed")!(Response.json({ message: "rate limited" }, { status: 403 }))
    for (const repo of COMING_SOON_REPOS) pending.get(repo.name)!(answerEach(requests[EVERY_NAME.indexOf(repo.name)]!))
    pending.get("smithersai/smithers")!(answerEach(requests[0]!))
    const response = await served
    expect(response.headers.get("cache-control")).toBe("public, max-age=300")
    const catalog = await response.json() as PublicRepoCatalog
    expect(catalog.repos.map((repo) => repo.name)).toEqual(CLAIMED_ROSTER.map((repo) => repo.name))
    expect(catalog.repos[0]!.stats?.stars).toBe(407)
    expect(catalog.repos[1]!.stats).toBeNull()
    expect(catalog.repos[2]!.stats?.stars).toBe(2407)
    expect(catalog.comingSoon!.map((repo) => repo.stats?.stars)).toEqual(COMING_SOON_REPOS.map((repo) => 407 + EVERY_NAME.indexOf(repo.name) * 1000))
  })

  test("a coming-soon repo's metadata outage nulls only its stats and shortens the cache like an available one's", async () => {
    const { handler } = harness({
      answer: (req) => repoName(req) === "wevm/incur" ? Response.json({ message: "bad gateway" }, { status: 502 }) : answerEach(req)
    })
    const response = await handler(request())
    expect(response.headers.get("cache-control")).toBe("public, max-age=30")
    const catalog = await response.json() as PublicRepoCatalog
    expect(catalog.repos[0]!.stats?.stars).toBe(407)
    expect(catalog.comingSoon!.map((repo) => [repo.name, repo.stats === null])).toEqual([
      ["Effect-TS/effect", false], ["wevm/incur", true], ["bombshell-dev/clack", false], ["jj-vcs/jj", false],
      ["modelcontextprotocol/typescript-sdk", false], ["GitoxideLabs/gitoxide", false],
      ["TanStack/db", false], ["xyflow/xyflow", false], ["blackboardsh/electrobun", false], ["withastro/starlight", false]
    ])
  })

  test("joins concurrent reads, caches for five minutes, and refreshes after expiry", async () => {
    const { handler, concurrently, requests, advance } = harness()
    const responses = await concurrently([request(), request("?cache-bust=1"), request()])
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200])
    expect(requests).toHaveLength(FETCH_COUNT)
    advance(299_000)
    expect((await handler(request())).headers.get("cache-control")).toBe("public, max-age=1")
    expect(requests).toHaveLength(FETCH_COUNT)
    advance(1_001)
    await handler(request())
    expect(requests).toHaveLength(FETCH_COUNT * 2)
  })

  test("the edge cache is reusable across Worker instances and expires", async () => {
    const edge = memoryEdgeCache()
    const { handler, coldIsolate, requests, advance } = harness({ edge })
    await handler(request())
    const second = await coldIsolate()(request("?different=1"))
    expect(requests).toHaveLength(FETCH_COUNT)
    expect((await second.json() as PublicRepoCatalog).repos[0]?.stats?.stars).toBe(407)
    expect([...edge.records.keys()]).toEqual(["https://app.test/api/public/repos"])
    advance(300_001)
    await coldIsolate()(request())
    expect(requests).toHaveLength(FETCH_COUNT * 2)
  })

  test("a transient outage never invents counts or removes availability, and retries after 30 s", async () => {
    for (const answer of [
      () => Response.json({ message: "bad gateway" }, { status: 502 }),
      () => new Response(null, { status: 503 }),
      () => { throw new Error("offline") }
    ]) {
      const { handler, requests, advance } = harness({ answer })
      const response = await handler(request())
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("public, max-age=30")
      expect(await response.json()).toEqual({ repos: expectedRepos(() => null), comingSoon: expectedComingSoon(() => null) })
      await handler(request())
      expect(requests).toHaveLength(FETCH_COUNT)
      advance(30_001)
      await handler(request())
      expect(requests).toHaveLength(FETCH_COUNT * 2)
    }
  })

  test("a GitHub rate limit nulls the stats but keeps the full cache window, so the limit is not fed", async () => {
    // Retrying a 403 or 429 every 30 s would send 600 calls an hour from one
    // instance and keep the 60-an-hour anonymous ceiling tripped forever.
    for (const status of [403, 429]) {
      const { handler, requests, advance } = harness({
        answer: () => Response.json({ message: "API rate limit exceeded" }, { status, headers: { "x-ratelimit-remaining": "0" } })
      })
      const response = await handler(request())
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("public, max-age=300")
      expect(await response.json()).toEqual({ repos: expectedRepos(() => null), comingSoon: expectedComingSoon(() => null) })
      advance(299_000)
      await handler(request())
      expect(requests).toHaveLength(FETCH_COUNT)
      advance(1_001)
      await handler(request())
      expect(requests).toHaveLength(FETCH_COUNT * 2)
    }
  })

  test("settled non-metadata answers (404, 302, private, invalid) null the stats and cache for the full window", async () => {
    for (const answer of [
      () => Response.json({ message: "Not Found" }, { status: 404 }),
      // The manual redirect mode hands a 3xx back instead of following it or throwing.
      () => new Response(null, { status: 302, headers: { location: "https://api.github.com/repositories/1" } }),
      () => Response.json({ ...metadata, private: true }),
      () => Response.json({ ...metadata, full_name: "another/repo" }),
      () => Response.json({ ...metadata, stargazers_count: -1 }),
      () => new Response("not json")
    ]) {
      const { handler, requests, advance } = harness({ answer })
      const response = await handler(request())
      expect(response.headers.get("cache-control")).toBe("public, max-age=300")
      expect(await response.json()).toEqual({ repos: expectedRepos(() => null), comingSoon: expectedComingSoon(() => null) })
      advance(30_001)
      await handler(request())
      expect(requests).toHaveLength(FETCH_COUNT)
    }
  })

  test("sends the GITHUB_TOKEN secret as a bearer on the stats reads when set, and nothing when unset", async () => {
    const { handler, requests } = harness({ env: { GITHUB_TOKEN: ` ${TOKEN} ` } })
    const response = await handler(request())
    expect(requests).toHaveLength(FETCH_COUNT)
    for (const req of requests) {
      expect(req.headers.get("authorization")).toBe(`Bearer ${TOKEN}`)
      expect(req.headers.get("x-github-api-version")).toBe("2022-11-28")
    }
    // The token authenticates the GitHub read only; the public response never carries it.
    expect([...response.headers.entries()].join("\n")).not.toContain(TOKEN)
    expect(await response.text()).not.toContain(TOKEN)

    for (const env of [{ GITHUB_TOKEN: "" }, {}]) {
      const unset = harness({ env })
      await unset.handler(request())
      expect(unset.requests).toHaveLength(FETCH_COUNT)
      for (const req of unset.requests) {
        expect(req.headers.has("authorization")).toBe(false)
        expect(req.headers.has("x-github-api-version")).toBe(false)
      }
    }
  })

  test("mints one GitHub App installation token and sends it on every stats read", async () => {
    const { handler, requests, advance } = harness({ answer: asTheApp(), env: APP_ENV })
    const response = await handler(request())
    expect(appCalls(requests)).toEqual(["/app/installations", "/app/installations/150824198/access_tokens"])
    expect(statsCalls(requests)).toHaveLength(FETCH_COUNT)
    for (const req of statsCalls(requests)) {
      expect(req.headers.get("authorization")).toBe(`Bearer ${INSTALLATION_TOKEN}`)
      expect(req.headers.get("x-github-api-version")).toBe("2022-11-28")
    }
    const catalog = await response.clone().json() as PublicRepoCatalog
    expect(catalog.repos[0]!.stats?.stars).toBe(407)
    // The token outlives the catalog's five-minute window: a second refresh reuses it.
    advance(300_001)
    await handler(request())
    expect(appCalls(requests)).toHaveLength(2)
    expect(statsCalls(requests)).toHaveLength(FETCH_COUNT * 2)
    // Neither credential is ever served.
    const served = `${[...response.headers.entries()].join("\n")}\n${await response.text()}`
    expect(served).not.toContain(INSTALLATION_TOKEN)
    expect(served).not.toContain("PRIVATE KEY")
  })

  test("a 401 on a stats read buys exactly one new installation token, and no more", async () => {
    let exchanges = 0
    const { handler, requests, advance } = harness({
      answer: (req) => {
        if (pathOf(req) === "/app/installations") return Response.json([{ id: 150824198, account: { login: "smithersai" } }])
        if (pathOf(req).endsWith("/access_tokens")) {
          exchanges += 1
          return Response.json({ token: `ghs_round_${exchanges}` }, { status: 201 })
        }
        // The first installation token has been revoked; the second one works.
        return req.headers.get("authorization") === "Bearer ghs_round_1"
          ? Response.json({ message: "Bad credentials" }, { status: 401 })
          : answerEach(req)
      },
      env: APP_ENV
    })
    const catalog = await (await handler(request())).json() as PublicRepoCatalog
    expect(exchanges).toBe(2)
    expect(statsCalls(requests)).toHaveLength(FETCH_COUNT * 2)
    expect(statsCalls(requests).at(-1)!.headers.get("authorization")).toBe("Bearer ghs_round_2")
    expect(catalog.repos[0]!.stats?.stars).toBe(407)
    // The renewed token is held: the next window does not exchange again.
    advance(300_001)
    await handler(request())
    expect(exchanges).toBe(2)
  })

  test("a token GitHub keeps refusing nulls the stats without a second re-exchange", async () => {
    let exchanges = 0
    const { handler, requests } = harness({
      answer: (req) => {
        if (pathOf(req) === "/app/installations") return Response.json([{ id: 150824198, account: { login: "smithersai" } }])
        if (pathOf(req).endsWith("/access_tokens")) {
          exchanges += 1
          return Response.json({ token: INSTALLATION_TOKEN }, { status: 201 })
        }
        return Response.json({ message: "Bad credentials" }, { status: 401 })
      },
      env: APP_ENV
    })
    const response = await handler(request())
    expect(exchanges).toBe(2)
    expect(statsCalls(requests)).toHaveLength(FETCH_COUNT * 2)
    expect(await response.json()).toEqual({ repos: expectedRepos(() => null), comingSoon: expectedComingSoon(() => null) })
  })

  test("GITHUB_TOKEN overrides the App, and an App installed nowhere reads anonymously", async () => {
    const override = harness({ answer: asTheApp(), env: { ...APP_ENV, GITHUB_TOKEN: TOKEN } })
    await override.handler(request())
    expect(appCalls(override.requests)).toEqual([])
    for (const req of statsCalls(override.requests)) expect(req.headers.get("authorization")).toBe(`Bearer ${TOKEN}`)

    const uninstalled = harness({ answer: asTheApp([]), env: APP_ENV })
    const warned: Array<unknown> = []
    const warn = console.warn
    console.warn = (line: unknown) => warned.push(line)
    const response = await uninstalled.handler(request()).finally(() => {
      console.warn = warn
    })
    expect(warned).toEqual(["the GitHub App is not installed on any organization"])
    expect(appCalls(uninstalled.requests)).toEqual(["/app/installations"])
    expect(statsCalls(uninstalled.requests)).toHaveLength(FETCH_COUNT)
    for (const req of statsCalls(uninstalled.requests)) expect(req.headers.has("authorization")).toBe(false)
    expect((await response.json() as PublicRepoCatalog).repos[0]!.stats?.stars).toBe(407)
  })

  test("preflight and unsupported writes do not touch the backend", async () => {
    const { handler, requests } = harness()
    const options = await handler(new Request(request(), { method: "OPTIONS" }))
    expect(options.status).toBe(204)
    const write = await handler(new Request(request(), { method: "POST" }))
    expect(write.status).toBe(405)
    expect(write.headers.get("allow")).toBe("GET, HEAD, OPTIONS")
    expect(await write.json()).toEqual({ message: "Method not allowed." })
    expect(requests).toHaveLength(0)
    const head = await handler(new Request(request(), { method: "HEAD" }))
    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")
  })
})
