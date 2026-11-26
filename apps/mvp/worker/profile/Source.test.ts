import { Clock, ConfigProvider, Duration, Effect, Option, Redacted } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"
import { describe, expect, test } from "vitest"
import * as ReadToken from "../github/ReadToken.ts"
import * as Source from "./Source.vibe"
import { type Kept, type KeptAnswer, type ProfileStore, StoreUnavailable } from "./Store.vibe"

const GITHUB_API = "https://api.github.com"
const success = () => Response.json({ data: { repositoryOwner: { __typename: "User", login: "octocat" } } })
const noRequest = (request: Request): never => {
  throw new Error("Unexpected request: " + request.url)
}
const storeDefaults: ProfileStore = {
  get: () => Effect.succeed(Option.none()),
  claim: () => Effect.succeed("generation"),
  keep: () => Effect.succeed(true),
  refuse: () => Effect.succeed(true),
}
const row = (overrides: Partial<Kept> = {}): Kept => ({
  answer: Option.none(),
  nextReadAtMs: 20_000,
  refusal: null,
  ...overrides,
})
const cached: KeptAnswer = { text: "cached", readAtMs: 0, freshUntilMs: 12_000, via: "deployment" }
const down = (op: StoreUnavailable["op"]) => Effect.fail(new StoreUnavailable({ op }))

const overHttp = <A, E>(
  program: Effect.Effect<A, E, HttpClient.HttpClient>,
  fetch: (request: Request) => Response = noRequest,
) =>
  program.pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, async (input, init) => fetch(new Request(input, init))),
  )

const harness = (options: {
  readonly store?: Partial<ProfileStore>
  readonly fetch?: (request: Request) => Response
  readonly apiBaseUrl?: string
  readonly anonymous?: boolean
} = {}) => {
  let now = 10_000
  const setTime = (time: number) => { now = time }
  const live = Effect.runSync(Clock.clockWith(Effect.succeed))
  const clock: Clock.Clock = {
    ...live,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeMillisUnsafe: () => now,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
    sleep: (duration) => live.sleep(duration),
  }
  const source = Source.make({
    token: ReadToken.fixed(options.anonymous ? Option.none() : Option.some(Redacted.make("test-token"))),
    apiBaseUrl: options.apiBaseUrl ?? GITHUB_API,
    freshFor: Duration.minutes(10),
    anonymousFreshFor: Duration.minutes(60),
  }, { ...storeDefaults, ...options.store }, { waitFor: Duration.seconds(10), poll: Duration.zero })
  const answer = () => Effect.runPromise(
    overHttp(source.answer("Octocat"), options.fetch).pipe(Effect.provideService(Clock.Clock, clock)),
  )
  return { answer, setTime }
}

describe("profile source", () => {
  test("reads deployment configuration and a usable token at startup", async () => {
    const settings = await Effect.runPromise(overHttp(Source.settings).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({
        GITHUB_TOKEN: "configured",
        GITHUB_API_URL: "https://github.example/api",
        PROFILE_FRESH_MINUTES: "15",
        PROFILE_ANONYMOUS_FRESH_MINUTES: "30",
      })),
    ))
    expect(settings.apiBaseUrl).toBe("https://github.example/api")
    expect(Duration.toMinutes(settings.freshFor)).toBe(15)
    expect(Duration.toMinutes(settings.anonymousFreshFor)).toBe(30)
    const token = await Effect.runPromise(settings.token)
    expect(Option.map(token, Redacted.value)).toEqual(Option.some("configured"))
  })

  test("emits the cache and upstream facts for a refused answer", () => {
    expect(Source.fieldsOf({
      _tag: "Refused",
      code: "rate_limited",
      cache: "refusal",
      retryAfterMillis: 1234,
      waitedMs: 42,
      refusalVia: "anonymous",
      store: ["get", "refuse"],
      writeRejected: "refuse",
      read: { outcome: "rate_limited", via: "deployment", stage: "graphql", upstreamStatus: 429, rateRemaining: 0, missing: [], durationMs: 2 },
    })).toEqual({
      cache: "refusal", retryAfterMs: 1234, waitedMs: 42, refusalVia: "anonymous", store: "get,refuse",
      writeRejected: "refuse", read: "rate_limited", via: "deployment", stage: "graphql", upstreamStatus: 429, rateRemaining: 0,
    })
    expect(Source.fieldsOf({ _tag: "Refused", code: "unavailable", cache: "wait" })).toEqual({ cache: "wait" })
  })

  test("reports read and claim failures without querying GitHub when the claim is lost to a store error", async () => {
    const { answer } = harness({ store: { get: () => down("get"), claim: () => down("claim") } })
    expect(await answer()).toEqual({
      _tag: "Refused", code: "unavailable", cache: "wait", retryAfterMillis: 1000, store: ["get", "claim"],
    })
  })

  test("joins an in-flight read, skipping stale answers until the holder publishes a fresh one", async () => {
    let reads = 0
    const { answer } = harness({ store: {
      claim: () => Effect.succeed(false),
      get: (owner) => Effect.sync(() => {
        expect(owner).toBe("octocat")
        reads++
        return Option.some(row({ answer: Option.some(reads < 3 ? { ...cached, freshUntilMs: 9999 } : cached) }))
      }),
    } })
    expect(await answer()).toEqual({
      _tag: "Answered", text: "cached", cache: "hit", via: "deployment", maxAgeSeconds: 2, waitedMs: 0,
    })
    expect(reads).toBe(3)
  })

  test.each([undefined, "anonymous"] as const)(
    "waits for a renewed deployment claim after a rate limit from %s",
    async (refusalVia) => {
      let reads = 0
      const limited = row({ refusal: "rate_limited", ...(refusalVia === undefined ? {} : { refusalVia }) })
      const { answer } = harness({ store: {
        get: () => Effect.sync(() => Option.some(++reads === 1 ? limited : row({ refusal: "not_found", nextReadAtMs: 10_001, ...(refusalVia === undefined ? {} : { refusalVia }) }))),
        claim: (_owner, now, until, recover) => {
          expect([now, until, recover]).toEqual([10_000, 40_000, true])
          return Effect.succeed(false)
        },
      } })
      expect(await answer()).toEqual({
        _tag: "Refused", code: "not_found", cache: "refusal", retryAfterMillis: 1000, waitedMs: 0,
        ...(refusalVia === undefined ? {} : { refusalVia }),
      })
    },
  )

  test.each([
    { refusalVia: "deployment", anonymous: false },
    { refusalVia: undefined, anonymous: true },
  ] as const)("keeps a cached rate limit when a different read cannot recover it (%j)", async ({ refusalVia, anonymous }) => {
    const { answer } = harness({ anonymous, store: {
      get: () => Effect.succeed(Option.some(row({ refusal: "rate_limited", ...(refusalVia === undefined ? {} : { refusalVia }) }))),
      claim: (_owner, _now, _until, recover) => {
        expect(recover).toBe(false)
        return Effect.succeed(false)
      },
    } })
    expect(await answer()).toEqual({
      _tag: "Refused", code: "rate_limited", cache: "refusal", retryAfterMillis: 10_000,
      ...(refusalVia === undefined ? {} : { refusalVia }),
    })
  })

  test.each(["deadline", "missing", "released", "expired", "store unavailable"] as const)(
    "returns a retry after waiting when the in-flight claim is %s",
    async (state) => {
      let reads = 0
      const { answer, setTime } = harness({ store: {
        claim: () => Effect.succeed(false),
        get: () => Effect.suspend(() => {
          if (++reads === 1) return Effect.succeed(Option.some(row()))
          if (state === "store unavailable") return down("get")
          if (state === "missing") return Effect.succeed(Option.none())
          if (state === "deadline") setTime(30_000)
          return Effect.succeed(Option.some(row({
            nextReadAtMs: state === "released" ? null : state === "expired" ? 9999 : 40_000,
          })))
        }),
      } })
      expect(await answer()).toEqual({
        _tag: "Refused", code: "unavailable", cache: "wait", retryAfterMillis: 1000,
        waitedMs: state === "deadline" ? 20_000 : 0,
      })
    },
  )

  test("keeps a partial anonymous answer for five minutes and records the smallest valid upstream quota", async () => {
    let kept: KeptAnswer | undefined
    const { answer } = harness({
      anonymous: true,
      store: { keep: (_owner, value) => Effect.sync(() => { kept = value; return true }) },
      fetch: (request) => {
        const path = new URL(request.url).pathname
        if (path === "/users/Octocat") {
          return Response.json({ type: "User", login: "octocat" }, { headers: { "x-ratelimit-remaining": "10" } })
        }
        if (path === "/users/octocat/repos") return Response.json([], { headers: { "x-ratelimit-remaining": "5" } })
        if (path === "/users/octocat/orgs") return Response.json({}, { status: 503, headers: { "x-ratelimit-remaining": "invalid" } })
        if (path === "/repos/octocat/octocat/readme") return Response.json({}, { status: 404, headers: { "x-ratelimit-remaining": "" } })
        return noRequest(request)
      },
    })
    expect(await answer()).toMatchObject({
      _tag: "Answered", cache: "miss", via: "anonymous", maxAgeSeconds: 300,
      read: { outcome: "partial", missing: ["organizations"], rateRemaining: 5 },
    })
    expect(kept).toMatchObject({ readAtMs: 10_000, freshUntilMs: 310_000, via: "anonymous" })
  })

  test.each(["fenced", "store unavailable", "expired"] as const)(
    "returns a retry when a successfully read profile is %s before delivery",
    async (failure) => {
      const { answer, setTime } = harness({
        fetch: success,
        store: { keep: (_owner, kept) => {
          if (failure === "store unavailable") return down("keep")
          if (failure === "fenced") return Effect.succeed(false)
          return Effect.sync(() => { setTime(kept.freshUntilMs); return true })
        } },
      })
      expect(await answer()).toMatchObject({
        _tag: "Refused", code: "unavailable", cache: "wait", retryAfterMillis: 1000,
        read: { outcome: "answered" },
        ...(failure === "store unavailable" ? { store: ["keep"] } : {}),
        ...(failure === "expired" ? {} : { writeRejected: "keep" }),
      })
    },
  )

  test.each([404, 200, "offline"] as const)("uses the GitHub web HEAD response %s after an anonymous rate limit", async (status) => {
    const saved: Array<ReadonlyArray<unknown>> = []
    const calls: Array<string> = []
    const { answer } = harness({
      anonymous: true,
      store: { refuse: (...args) => Effect.sync(() => { saved.push(args); return true }) },
      fetch: (request) => {
        calls.push(request.method)
        if (request.method === "HEAD") {
          if (status === "offline") throw new Error("GitHub web unavailable")
          return new Response(null, { status })
        }
        return Response.json({}, { status: 429, headers: { "retry-after": "120", "x-ratelimit-reset": "9999" } })
      },
    })
    const code = status === 404 ? "not_found" : "rate_limited"
    expect(await answer()).toMatchObject({
      _tag: "Refused", code, cache: "miss",
      read: { outcome: code, stage: status === 404 ? "web" : "owner", upstreamStatus: status === 404 ? 404 : 429 },
      ...(status === 404 ? {} : { retryAfterMillis: 60_000 }),
    })
    expect(calls).toEqual(["GET", "HEAD"])
    expect(saved).toEqual([["octocat", code, status === 404 ? 70_000 : 910_000, "anonymous", "generation"]])
  })

  test("keeps an alternate GitHub origin's anonymous rate limit without probing public GitHub", async () => {
    const calls: Array<string> = []
    const { answer } = harness({
      anonymous: true,
      apiBaseUrl: "https://github.example/api",
      fetch: (request) => {
        calls.push(request.method + " " + request.url)
        return Response.json({}, { status: 429, headers: { "retry-after": "9" } })
      },
    })
    expect(await answer()).toMatchObject({
      _tag: "Refused", code: "rate_limited", cache: "miss", retryAfterMillis: 9000,
    })
    expect(calls).toEqual(["GET https://github.example/api/users/Octocat"])
  })

  test.each(["fenced", "store unavailable", "saved"] as const)(
    "reports a bad upstream configuration when the short refusal is %s",
    async (failure) => {
      const { answer } = harness({
        apiBaseUrl: "invalid-url",
        store: { refuse: (_owner, code, nextReadAtMs) => {
          expect([code, nextReadAtMs]).toEqual(["github_unavailable", 15_000])
          return failure === "store unavailable" ? down("refuse") : Effect.succeed(failure === "saved")
        } },
      })
      expect(await answer()).toMatchObject({
        _tag: "Refused", code: failure === "saved" ? "github_unavailable" : "unavailable",
        read: { stage: "owner", outcome: "github_unavailable" },
        ...(failure === "store unavailable" ? { store: ["refuse"] } : {}),
        ...(failure === "saved" ? { cache: "miss" } : { cache: "wait", writeRejected: "refuse" }),
      })
    },
  )
})

