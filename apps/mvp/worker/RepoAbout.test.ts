// The about read (worker/RepoAbout.ts) over this file's schema of the compose Postgres (`pnpm db:up`) and the scripted
// GitHub (worker/test/githubRest.ts): whose quota a read spends, the answer kept for every data center and served
// only while fresh even when GitHub can't answer, the waits after GitHub refused, many visitors causing one read across
// two, with no request resuming on another's work, and a store that fails, injected. The reads themselves are worker/about/GitHubRead.test.ts.
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Clock, ConfigProvider, Deferred, Duration, Effect, Layer, Logger, Metric, Option, Redacted } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test, vi } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import * as AboutStore from "./about/Store.vibe"
import { APP_ID, appKey } from "./github/test/scriptedGitHub.ts"
import * as RepoAbout from "./RepoAbout.ts"
import * as RepoMetrics from "./RepoMetrics.ts"
import { testFile } from "./test/harness.ts"
import { type ScriptedGitHub, scriptedGitHub, spoonKnife } from "./test/githubRest.ts"

let runtime: ReturnType<typeof testFile>

const sql = <A extends object = Record<string, unknown>>(statement: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => Effect.orDie(client.unsafe<A>(statement))))

type StructuredLog = ReturnType<typeof StructuredLogger.formatStructured.log>

let key: Redacted.Redacted<string> | undefined
/** The Smithers App's configuration, with the deployment's own repository `acme/home`. */
const appConfig = async (): Promise<Record<string, string>> => {
  key ??= await appKey()
  return { GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: Redacted.value(key), GITHUB_REPOSITORY: "acme/home" }
}

/**
 * One isolate's about read over `github` and this file's store, unless `store` injects another. `logs` and the
 * metrics are this isolate's.
 */
const isolate = async (
  github: ScriptedGitHub,
  options: {
    readonly config?: Record<string, string>
    readonly store?: AboutStore.AboutStore
    readonly database?: Layer.Layer<SqlClient.SqlClient, unknown>
    readonly timing?: RepoAbout.Timing
    readonly now?: number | (() => number)
  } = {},
) => {
  const database = options.database ?? (await runtime.runPromise(Effect.service(TestDatabase.Scratch))).database
  const logs: Array<StructuredLog> = []
  const logger = Logger.make((log) => void logs.push(StructuredLogger.formatStructured.log(log)))
  const registry: Metric.MetricRegistry = new Map()
  const provider = ConfigProvider.fromUnknown(options.config ?? {})
  const live = Effect.runSync(Clock.clockWith(Effect.succeed))
  const now = () => typeof options.now === "function" ? options.now() : options.now!
  const clock: Clock.Clock = options.now === undefined ? live : {
    ...live,
    monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
    sleep: (duration) => live.sleep(duration),
    currentTimeMillis: Effect.sync(now),
    currentTimeMillisUnsafe: now,
    currentTimeNanos: Effect.sync(() => BigInt(now()) * 1_000_000n),
    currentTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
  }
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => github.fetch(new Request(input, init))) as typeof globalThis.fetch
  const observed = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    effect.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(Metric.MetricRegistry, registry),
      Effect.provideService(ConfigProvider.ConfigProvider, provider),
      Effect.provideService(Clock.Clock, clock),
    )
  const source = await Effect.runPromise(observed(Effect.flatMap(
    RepoAbout.settings,
    (settings) =>
      RepoAbout.make(settings, options.store ?? AboutStore.postgres(database), database, options.timing),
  )))
  return {
    answer: (owner: string, name: string, member = false) =>
      Effect.runPromise(observed(source.answer(owner, name, Effect.succeed(member)))),
    logs,
    reads: () => logs.filter((log) => log.message === "repo.about.read").map((log) => log.annotations),
    count: (metric: Metric.Metric<number, Metric.CounterState<number>>, attributes: Record<string, string>) =>
      Effect.runSync(Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry))).count,
    gauge: (attributes: Record<string, string>) =>
      Effect.runSync(Metric.value(Metric.withAttributes(RepoMetrics.aboutRateRemaining, attributes)).pipe(
        Effect.provideService(Metric.MetricRegistry, registry),
      )).value,
  }
}

const answered = (outcome: RepoAbout.Outcome) => {
  if (outcome._tag !== "Answered") throw new Error(`refused ${outcome.code}`)
  return { ...outcome, about: JSON.parse(outcome.text) as { readonly name: string } }
}

/** `id`'s persisted deadlines relative to the reader's application clock, never the database host's clock. */
const row = async (id: string, now?: number) => {
  const [found] = await sql<{ readonly via: string | null; readonly refusal: string | null; readonly freshAt: number | null; readonly nextAt: number | null; readonly absentAt: number | null }>(`
    SELECT via, refusal,
      (extract(epoch FROM fresh_until) * 1000)::float8 AS "freshAt",
      (extract(epoch FROM next_read_at) * 1000)::float8 AS "nextAt",
      (extract(epoch FROM app_absent_until) * 1000)::float8 AS "absentAt"
    FROM repo_about WHERE repo_id = '${id}'`)
  const at = now ?? Date.now()
  return found === undefined ? undefined : {
    via: found.via, refusal: found.refusal,
    freshIn: found.freshAt === null ? null : found.freshAt - at,
    nextIn: found.nextAt === null ? null : found.nextAt - at,
    absentIn: found.absentAt === null ? null : found.absentAt - at,
  }
}

/** Waits until `check` holds: another isolate's step that the test can only see in the store or at GitHub. */
const until = (check: () => boolean | Promise<boolean>) =>
  vi.waitFor(async () => {
    if (!(await check())) throw new Error("not yet")
  }, { timeout: 10_000, interval: 10 })

/** This file's store, counting each look at a row: how a test sees a request waiting in it. */
const watched = async () => {
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const real = AboutStore.postgres(scratch.database)
  const looks = { count: 0 }
  const store: AboutStore.AboutStore = { ...real, get: (id) => Effect.suspend(() => (looks.count++, real.get(id))) }
  return { store, looks }
}

/** Makes `id`'s answer stale and its next read due, as if it was read `ago` before. */
const age = (id: string, ago = "11 minutes") =>
  sql(`UPDATE repo_about SET read_at = now() - interval '${ago}', fresh_until = now() - interval '1 second',
    next_read_at = now() - interval '1 second' WHERE repo_id = '${id}'`)

const SPOON = "github/octocat/spoon-knife"
const VIBE = "github/smithersai/vibelang"

/** Seed a refusal through real ownership, including the legacy missing-quota representation. */
const seedRefusal = (store: AboutStore.AboutStore, id: string, refusal: AboutStore.KeptRefusal, until: number, via?: AboutStore.Via) =>
  Effect.gen(function* () {
    const generation = yield* store.claim(id, until - 600_000, until - 570_000)
    if (generation === false) return yield* Effect.die("expected seed claim")
    return yield* store.refuse(id, refusal, until, via, generation)
  })

describe("Postgres-backed About", () => {
runtime = testFile("repo_about")
beforeEach(async () => {
  await sql("DELETE FROM repo_about")
  await sql("DELETE FROM github_repositories")
})

describe("settings", () => {
  test("defaults: fresh 10 minutes with a token and 60 anonymously, no App, every repository allowed", async () => {
    const read = (values: Record<string, string>) =>
      Effect.runPromise(RepoAbout.settings.pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values)),
      ))
    const defaults = await read({})
    expect({ ...defaults, token: await Effect.runPromise(defaults.token) }).toEqual({
      token: Option.none(),
      apiBaseUrl: "https://api.github.com",
      appSlug: "smithers",
      freshFor: Duration.minutes(10),
      anonymousFreshFor: Duration.minutes(60),
      app: Option.none(),
      allowed: Option.none(),
    })
    const set = await read({
      GITHUB_TOKEN: "ghp_x",
      GITHUB_API_URL: "https://ghe.example/api/v3",
      GITHUB_APP_SLUG: "smithers-dev",
      REPO_ABOUT_FRESH_MINUTES: "3",
      REPO_ABOUT_ANONYMOUS_FRESH_MINUTES: "30",
      GITHUB_ALLOWED_REPOSITORIES: "smithersai/vibelang",
      ...await appConfig(),
    })
    expect(Option.map(await Effect.runPromise(set.token), Redacted.value)).toEqual(Option.some("ghp_x"))
    expect(set).toMatchObject({
      apiBaseUrl: "https://ghe.example/api/v3",
      appSlug: "smithers-dev",
      freshFor: Duration.minutes(3),
      anonymousFreshFor: Duration.minutes(30),
      allowed: Option.some(new Set([VIBE])),
    })
    expect(Option.map(set.app, (app) => app.repository.id)).toEqual(Option.some("github/acme/home"))
    // A blank token is none; values that aren't one fail the deployment's config, never a request.
    expect(await Effect.runPromise((await read({ GITHUB_TOKEN: "  " })).token)).toEqual(Option.none())
    const bad: ReadonlyArray<Record<string, string>> = [
      { REPO_ABOUT_FRESH_MINUTES: "0" },
      { GITHUB_APP_SLUG: "Bad Slug" },
      { GITHUB_ALLOWED_REPOSITORIES: "nope" },
    ]
    for (const values of bad) {
      await expect(read(values)).rejects.toThrow()
    }
    // An App configuration that doesn't read leaves the App out.
    expect((await read({ ...await appConfig(), GITHUB_API_URL: "not a url" })).app).toEqual(Option.none())
  })
})

describe("whose quota a read spends", () => {
  test("a repository the App is installed on is read with the App's token for that repository, for a visitor too", async () => {
    // Before, a visitor's read was anonymous everywhere: 60 calls an hour per address, shared by every Worker, so
    // smithers.sh/smithersai/vibelang answered visitors 503 while a Member got 200.
    const github = scriptedGitHub()
    github.publish("smithersai", "vibelang", spoonKnife({ fullName: "smithersai/vibelang" }))
    github.install("smithersai", "vibelang")
    github.state.remaining = 4321
    const one = await isolate(github, { config: await appConfig() })
    const outcome = answered(await one.answer("smithersai", "vibelang"))
    expect(outcome).toMatchObject({ cache: "miss", via: "app", about: { name: "smithersai/vibelang" } })
    expect(outcome.maxAgeSeconds).toBeGreaterThan(0)
    expect(outcome.maxAgeSeconds).toBeLessThanOrEqual(600)
    expect(github.calls).toEqual(["/installation", "access_tokens", "graphql", "/contributors"])
    expect(github.minted).toEqual([{ token: "ghs_about_1", repositories: ["vibelang"], permissions: { contents: "read" } }])
    expect(github.authorizations.slice(2)).toEqual(["Bearer ghs_about_1", "Bearer ghs_about_1"])
    expect(one.reads()).toEqual([expect.objectContaining({ repoId: VIBE, via: "app", outcome: "answered", rateRemaining: 4321 })])
    expect(one.gauge({ via: "app" })).toBe(4321)
    expect(one.count(RepoMetrics.aboutReads, { via: "app", outcome: "answered" })).toBe(1)
    // The installation is remembered: the next read mints without asking where the App is installed.
    await age(VIBE)
    expect(answered(await one.answer("smithersai", "vibelang")).via).toBe("app")
    expect(github.calls.slice(4)).toEqual(["access_tokens", "graphql", "/contributors"])
    // No token reaches a record.
    expect(JSON.stringify(one.logs)).not.toMatch(/ghs_about|PRIVATE KEY/)
  })

  test("elsewhere a visitor reads anonymously over REST, and the App's absence is remembered for an hour", async () => {
    const github = scriptedGitHub()
    github.publish("octocat", "Spoon-Knife")
    const one = await isolate(github, { config: await appConfig() })
    const outcome = answered(await one.answer("octocat", "Spoon-Knife"))
    expect(outcome.via).toBe("anonymous")
    expect(outcome.maxAgeSeconds).toBeGreaterThan(0)
    expect(outcome.maxAgeSeconds).toBeLessThanOrEqual(3600)
    expect(github.calls[0]).toBe("/installation")
    expect(github.calls).not.toContain("graphql")
    expect(github.authorizations.slice(1).every((authorization) => authorization === null)).toBe(true)
    const kept = await row(SPOON)
    expect(kept?.absentIn).toBeGreaterThan(Duration.toMillis(RepoAbout.APP_RECHECK) - 60_000)
    await age(SPOON, "2 hours")
    github.calls.length = 0
    expect(answered(await one.answer("octocat", "Spoon-Knife")).via).toBe("anonymous")
    expect(github.calls).not.toContain("/installation")
  })

  test("a curated public home uses the deployment read token over REST for visitors", async () => {
    const github = scriptedGitHub()
    github.publish("Effect-TS", "effect")
    const one = await isolate(github, { config: { GITHUB_TOKEN: "ghp_curated" } })
    const outcome = answered(await one.answer("Effect-TS", "effect"))
    expect(outcome.via).toBe("deployment")
    expect(outcome.maxAgeSeconds).toBeGreaterThan(0)
    expect(outcome.maxAgeSeconds).toBeLessThanOrEqual(600)
    expect(github.calls).not.toContain("graphql")
    expect(new Set(github.authorizations)).toEqual(new Set(["Bearer ghp_curated"]))
    expect(JSON.stringify(one.logs)).not.toContain("ghp_curated")
  })

  test.each([undefined, "anonymous", "deployment", "app"] as const)("a curated cached rate limit from %s recovers only onto a different authenticated quota", async (via) => {
    const github = scriptedGitHub()
    github.publish("Effect-TS", "effect")
    const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
    const store = AboutStore.postgres(scratch.database)
    await runtime.runPromise(seedRefusal(store, "github/effect-ts/effect", "rate_limited", Date.now() + 600_000, via))
    const one = await isolate(github, { config: { GITHUB_TOKEN: "ghp_curated" } })
    const outcome = await one.answer("Effect-TS", "effect")
    if (via === undefined || via === "anonymous") {
      expect(answered(outcome)).toMatchObject({ via: "deployment", cache: "miss" })
      expect(one.reads()).toHaveLength(1)
      expect(answered(await one.answer("Effect-TS", "effect"))).toMatchObject({ cache: "hit" })
    } else {
      expect(outcome).toMatchObject({ _tag: "Refused", cache: "refusal", refusalVia: via })
      expect(RepoAbout.fieldsOf(outcome)).toMatchObject({ refusalVia: via, retryAfterMs: expect.any(Number) })
      expect(github.calls).toEqual([])
    }
  })

  test("a competing authenticated recovery waits for the winner rather than serving the old anonymous refusal", async () => {
    const github = scriptedGitHub()
    github.publish("Effect-TS", "effect")
    const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
    const store = AboutStore.postgres(scratch.database)
    await runtime.runPromise(seedRefusal(store, "github/effect-ts/effect", "rate_limited", Date.now() + 600_000, "anonymous"))
    const winner = await isolate(github, { config: { GITHUB_TOKEN: "ghp_curated" } })
    // Inject a competing claim that finishes the real winner before reporting this request lost its claim.
    const loser = await isolate(github, { config: { GITHUB_TOKEN: "ghp_curated" }, store: {
      ...store, claim: () => Effect.promise(() => winner.answer("Effect-TS", "effect")).pipe(Effect.as(false)),
    }, timing: { waitFor: Duration.seconds(1), poll: Duration.millis(1) } })
    expect(answered(await loser.answer("Effect-TS", "effect"))).toMatchObject({ cache: "hit", via: "deployment", waitedMs: expect.any(Number) })
    expect(winner.reads()).toHaveLength(1)
    expect(loser.reads()).toHaveLength(0)
  })

  test("a curated cached anonymous rate limit stays held without an authenticated fallback", async () => {
    const github = scriptedGitHub()
    const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
    await runtime.runPromise(seedRefusal(AboutStore.postgres(scratch.database), "github/effect-ts/effect", "rate_limited", Date.now() + 600_000, "anonymous"))
    const one = await isolate(github)
    expect(await one.answer("Effect-TS", "effect")).toMatchObject({ _tag: "Refused", cache: "refusal", refusalVia: "anonymous" })
    expect(github.calls).toEqual([])
  })

  test("a curated visitor falls back to the configured App's metadata read token when its own installation is absent", async () => {
    const github = scriptedGitHub()
    github.publish("Effect-TS", "effect")
    github.install("acme", "home")
    const one = await isolate(github, { config: await appConfig() })
    expect(answered(await one.answer("Effect-TS", "effect"))).toMatchObject({ via: "deployment" })
    expect(github.calls).not.toContain("graphql")
    expect(github.minted).toEqual([{ token: "ghs_about_1", repositories: ["home"], permissions: { metadata: "read" } }])
    expect(one.reads()[0]).toMatchObject({ via: "deployment", outcome: "answered" })
  })

  test("a curated repository becoming private is refused even with the deployment token", async () => {
    const github = scriptedGitHub()
    github.publish("Effect-TS", "effect", spoonKnife({ private: true }))
    const one = await isolate(github, { config: { GITHUB_TOKEN: "ghp_curated" } })
    expect(await one.answer("Effect-TS", "effect")).toMatchObject({ _tag: "Refused", code: "not_found" })
    expect(github.calls).toEqual([""])
  })

  test("a curated read records an upstream connection failure without an HTTP status", async () => {
    const github = scriptedGitHub()
    github.publish("Effect-TS", "effect")
    github.fail("", "network")
    const one = await isolate(github, { config: { GITHUB_TOKEN: "ghp_curated" } })
    expect(await one.answer("Effect-TS", "effect")).toMatchObject({
      _tag: "Refused", code: "github_unavailable",
      read: { via: "deployment", stage: "repository", outcome: "github_unavailable" },
    })
    expect(one.reads()[0]).not.toHaveProperty("upstreamStatus")
  })

  test("a Member's read of a repository without the App uses the deployment's token; nobody's spends it otherwise", async () => {
    const github = scriptedGitHub()
    github.publish("octocat", "Spoon-Knife")
    const one = await isolate(github, { config: { GITHUB_TOKEN: "ghp_deployment" } })
    const outcome = answered(await one.answer("octocat", "Spoon-Knife", true))
    expect(outcome.via).toBe("deployment")
    expect(outcome.maxAgeSeconds).toBeGreaterThan(0)
    expect(outcome.maxAgeSeconds).toBeLessThanOrEqual(600)
    expect(new Set(github.authorizations)).toEqual(new Set(["Bearer ghp_deployment"]))
    expect(github.calls[0]).toBe("graphql")
    expect(JSON.stringify(one.logs)).not.toContain("ghp_deployment")
    // Without a deployment token a Member reads anonymously too.
    await sql("DELETE FROM repo_about")
    const bare = await isolate(github)
    expect(answered(await bare.answer("octocat", "Spoon-Knife", true)).via).toBe("anonymous")
  })

  test("GITHUB_ALLOWED_REPOSITORIES keeps the App to the repositories it names, and the deployment's own always", async () => {
    const github = scriptedGitHub()
    for (const [owner, name] of [["acme", "widgets"], ["acme", "home"]] as const) {
      github.publish(owner, name, spoonKnife({ fullName: `${owner}/${name}` }))
      github.install(owner, name)
    }
    const one = await isolate(github, { config: { ...await appConfig(), GITHUB_ALLOWED_REPOSITORIES: "acme/other" } })
    expect(answered(await one.answer("acme", "widgets")).via).toBe("anonymous")
    expect(github.calls).not.toContain("/installation")
    expect(answered(await one.answer("acme", "home")).via).toBe("app")
  })

  test("an App key that doesn't import leaves every read to the visitor's own quota, and says why", async () => {
    const github = scriptedGitHub()
    github.publish("smithersai", "vibelang", spoonKnife({ fullName: "smithersai/vibelang" }))
    github.install("smithersai", "vibelang")
    const config = { ...await appConfig(), GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n" }
    const one = await isolate(github, { config })
    expect(answered(await one.answer("smithersai", "vibelang")).via).toBe("anonymous")
    expect(one.reads()).toEqual([expect.objectContaining({ via: "anonymous", tokenError: expect.any(String) })])
    expect(one.reads()[0]?.tokenError).not.toMatch(/^token:/)
  })

  test("an App token that can't be minted now leaves the read to the visitor's own quota, and says why", async () => {
    const github = scriptedGitHub()
    github.publish("smithersai", "vibelang", spoonKnife({ fullName: "smithersai/vibelang" }))
    github.install("smithersai", "vibelang")
    github.fail("access_tokens", 502)
    const one = await isolate(github, { config: await appConfig() })
    expect(answered(await one.answer("smithersai", "vibelang")).via).toBe("anonymous")
    expect(one.reads()).toEqual([expect.objectContaining({ via: "anonymous", tokenError: "token:unavailable" })])
    // The App isn't absent: the next read tries it again.
    expect((await row(VIBE))?.absentIn).toBeNull()
  })
})

describe("kept for every data center", () => {
  test("a fresh answer serves everyone from the store; a stale one is read again by the request that claims it", async () => {
    const github = scriptedGitHub()
    github.publish("octocat", "Spoon-Knife")
    const one = await isolate(github)
    expect(answered(await one.answer("octocat", "Spoon-Knife")).cache).toBe("miss")
    const calls = github.calls.length
    // Another data center: a hit, no call.
    const two = await isolate(github)
    const hit = answered(await two.answer("OctoCat", "spoon-knife"))
    expect(hit).toMatchObject({ cache: "hit", via: "anonymous", about: { name: "octocat/Spoon-Knife" } })
    expect(hit.maxAgeSeconds).toBeGreaterThan(3500)
    expect(github.calls).toHaveLength(calls)
    await age(SPOON)
    expect(answered(await two.answer("octocat", "Spoon-Knife")).cache).toBe("miss")
    expect(github.calls.length).toBeGreaterThan(calls)
  })

  test("past freshness, GitHub failing returns no content, and nobody asks again for 5 seconds", async () => {
    const github = scriptedGitHub()
    github.publish("octocat", "Spoon-Knife")
    const now = Date.now() + 60_000 // A different host clock must not change the duration.
    const one = await isolate(github, { now })
    await one.answer("octocat", "Spoon-Knife")
    await age(SPOON)
    github.fail("", 502)
    const refused = await one.answer("octocat", "Spoon-Knife")
    expect(refused).toMatchObject({ _tag: "Refused", code: "github_unavailable", cache: "miss" })
    expect(refused).not.toHaveProperty("text")
    expect(refused.read).toMatchObject({ outcome: "github_unavailable", stage: "repository", upstreamStatus: 502 })
    const kept = await row(SPOON, now)
    expect(kept).toMatchObject({ refusal: "github_unavailable" })
    expect(kept?.nextIn).toBeGreaterThan(2_000)
    expect(kept?.nextIn).toBeLessThanOrEqual(Duration.toMillis(RepoAbout.HOLD))
    const calls = github.calls.length
    const served = await one.answer("octocat", "Spoon-Knife")
    expect(served).toMatchObject({ _tag: "Refused", code: "github_unavailable", cache: "refusal", retryAfterMillis: Duration.toMillis(RepoAbout.HOLD) })
    expect(served).not.toHaveProperty("text")
    expect(served).not.toHaveProperty("read")
    expect(github.calls).toHaveLength(calls)
    // An older kept answer is refused too.
    await age(SPOON, "8 days")
    const old = await one.answer("octocat", "Spoon-Knife")
    expect(old).toMatchObject({ _tag: "Refused", code: "github_unavailable", cache: "miss" })
  })

  test("with nothing kept, GitHub's refusal is the answer, and is kept: not found, rate limited to its reset, down", async () => {
    const github = scriptedGitHub()
    const one = await isolate(github)
    expect(await one.answer("octocat", "Gone")).toMatchObject({ _tag: "Refused", code: "not_found", cache: "miss" })
    const gone = await row("github/octocat/gone")
    expect(gone?.refusal).toBe("not_found")
    expect(gone?.nextIn).toBeGreaterThan(55_000)
    expect(await one.answer("octocat", "Gone")).toMatchObject({ _tag: "Refused", code: "not_found", cache: "refusal" })
    expect(github.calls).toHaveLength(1)

    github.publish("octocat", "Limited")
    github.fail("", "rate_limited")
    const limited = await one.answer("octocat", "Limited")
    expect(limited).toMatchObject({ _tag: "Refused", code: "rate_limited", cache: "miss" })
    expect(limited._tag === "Refused" && limited.retryAfterMillis).toBeGreaterThan(0)
    // GitHub's reset is ten minutes away: nobody asks before it.
    expect((await row("github/octocat/limited"))?.nextIn).toBeGreaterThan(500_000)
    const again = await one.answer("octocat", "Limited")
    expect(again).toMatchObject({ _tag: "Refused", code: "rate_limited", cache: "refusal" })
    expect(again._tag === "Refused" && again.retryAfterMillis).toBeGreaterThan(500_000)

    github.fail("", 502)
    github.publish("octocat", "Down")
    expect(await one.answer("octocat", "Down")).toMatchObject({ _tag: "Refused", code: "github_unavailable", cache: "miss" })
    expect(await one.answer("octocat", "Down")).toMatchObject({ _tag: "Refused", code: "github_unavailable", cache: "refusal" })
  })

  test("with the anonymous quota spent, github.com's own 404 says the repository isn't there (GH-4), without a token", async () => {
    const github = scriptedGitHub()
    const one = await isolate(github)
    github.fail("", "rate_limited")
    expect(await one.answer("zzz-nope", "nothing")).toMatchObject({ _tag: "Refused", code: "not_found", cache: "miss" })
    expect(github.calls).toEqual(["", "web"])
    expect(github.authorizations).toEqual([null, null])
    expect(one.reads()).toEqual([expect.objectContaining({ via: "anonymous", outcome: "not_found", stage: "web", upstreamStatus: 404 })])
    expect((await row("github/zzz-nope/nothing"))?.refusal).toBe("not_found")
  })

  test("the rate limit stands when github.com shows the repository or doesn't answer with a 404: its existence is unknown", async () => {
    const github = scriptedGitHub()
    const one = await isolate(github)
    github.fail("", "rate_limited")
    github.publish("octocat", "Limited")
    expect(await one.answer("octocat", "Limited")).toMatchObject({ _tag: "Refused", code: "rate_limited" })
    expect(github.calls).toContain("web")
    for (const userAgent of github.userAgents) expect(userAgent).toBe("smithers-integrations")
    github.fail("web", 429)
    expect(await one.answer("zzz-nope", "throttled")).toMatchObject({ _tag: "Refused", code: "rate_limited" })
    github.fail("web", "network")
    expect(await one.answer("zzz-nope", "unreachable")).toMatchObject({ _tag: "Refused", code: "rate_limited" })
  })

  test("a deployment on another GitHub API has no github.com to ask: its rate limit stands", async () => {
    const github = scriptedGitHub()
    const one = await isolate(github, { config: { GITHUB_API_URL: "https://ghe.example" } })
    github.fail("", "rate_limited")
    expect(await one.answer("zzz-nope", "nothing")).toMatchObject({ _tag: "Refused", code: "rate_limited" })
    expect(github.calls).toEqual([""])
  })

  test("a repository GitHub stops having loses its kept answer", async () => {
    const github = scriptedGitHub()
    github.publish("octocat", "Spoon-Knife")
    const one = await isolate(github)
    await one.answer("octocat", "Spoon-Knife")
    await age(SPOON)
    github.fail("", 404)
    expect(await one.answer("octocat", "Spoon-Knife")).toMatchObject({ _tag: "Refused", code: "not_found" })
    expect(await row(SPOON)).toMatchObject({ via: null, refusal: "not_found" })
  })

  test("a rate limit that names no wait holds reads off for a minute; an answer without GitHub's limit header records none", async () => {
    const github = scriptedGitHub()
    github.publish("octocat", "Limited")
    github.fail("", 429)
    github.state.remaining = undefined
    const now = Date.now() + 60_000 // A different host clock must not change the duration.
    const one = await isolate(github, { now })
    const limited = await one.answer("octocat", "Limited")
    expect(limited).toMatchObject({ _tag: "Refused", code: "rate_limited", read: { outcome: "rate_limited", upstreamStatus: 429 } })
    expect(limited._tag === "Refused" && limited.retryAfterMillis).toBeUndefined()
    expect(limited.read?.rateRemaining).toBeUndefined()
    const next = (await row("github/octocat/limited", now))?.nextIn ?? 0
    expect(next).toBeGreaterThan(55_000)
    expect(next).toBeLessThanOrEqual(Duration.toMillis(RepoAbout.RATE_HOLD))
    expect(one.reads()[0]).not.toHaveProperty("rateRemaining")
    expect(RepoAbout.fieldsOf(limited)).toEqual({ cache: "miss", via: "anonymous", read: "rate_limited", stage: "repository", upstreamStatus: 429 })
    expect(one.gauge({ via: "anonymous" })).toBe(0)
  })

  test("an answer GitHub left parts out of is fresh for 5 minutes at most, then read again", async () => {
    const github = scriptedGitHub()
    github.publish("octocat", "Spoon-Knife")
    github.fail("/languages", "rate_limited")
    const now = Date.now() + 60_000 // A different host clock must not change the duration.
    const one = await isolate(github, { now })
    const partial = answered(await one.answer("octocat", "Spoon-Knife"))
    expect(partial.read).toMatchObject({ outcome: "partial", missing: ["languages"] })
    expect(partial.maxAgeSeconds).toBeLessThanOrEqual(300)
    expect((await row(SPOON, now))?.freshIn).toBeLessThanOrEqual(Duration.toMillis(RepoAbout.PARTIAL_FRESH))
    expect(one.reads()).toEqual([expect.objectContaining({ outcome: "partial", missing: "languages" })])
  })
})

describe("many visitors, one read", () => {
  test("thirty concurrent first reads: one request reads GitHub, the rest wait for its answer in the store, all answered", async () => {
    // Production, 2026-10-25: thirty visitors at once got 23 answers of 500. A lookup shared through Effect's `Cache`
    // resumed every request but the first on the first one's I/O, which a Worker refuses. Now no request awaits
    // another's work: the ones that didn't claim the read watch the store until the claimed read lands.
    const github = scriptedGitHub()
    github.publish("smithersai", "vibelang", spoonKnife({ fullName: "smithersai/vibelang" }))
    github.install("smithersai", "vibelang")
    const one = await isolate(github, { config: await appConfig() })
    const release = github.hold()
    const visitors = Promise.all(Array.from({ length: 30 }, () => one.answer("smithersai", "vibelang")))
    await until(() => github.holding() > 0)
    release()
    const outcomes = await visitors
    expect(outcomes.every((outcome) => outcome._tag === "Answered")).toBe(true)
    expect(outcomes.filter((outcome) => outcome.cache === "miss")).toHaveLength(1)
    // The other twenty-nine answer from the store: having waited for the read, or, if they looked after it landed, at once.
    expect(outcomes.filter((outcome) => outcome.cache === "hit")).toHaveLength(29)
    const waited = outcomes.filter((outcome) => outcome.waitedMs !== undefined)
    expect(waited.length).toBeGreaterThan(0)
    expect(RepoAbout.fieldsOf(waited[0]!)).toMatchObject({ cache: "hit", via: "app", waitedMs: expect.any(Number) })
    expect(github.calls).toEqual(["/installation", "access_tokens", "graphql", "/contributors"])
    expect(one.reads()).toHaveLength(1)
    const later = await Promise.all(Array.from({ length: 30 }, () => one.answer("smithersai", "vibelang")))
    expect(later.every((outcome) => outcome._tag === "Answered" && outcome.cache === "hit" && outcome.waitedMs === undefined)).toBe(true)
    expect(github.calls).toHaveLength(4)
  })

  test("across data centers: while one reads, the other waits for its first answer, then waits for a fresh one", async () => {
    const github = scriptedGitHub()
    github.publish("octocat", "Spoon-Knife")
    const westStore = await watched()
    const [east, west] = [await isolate(github), await isolate(github, { store: westStore.store })]
    // The first read ever: the other data center has nothing to serve, so it waits for the one reading.
    let release = github.hold()
    const first = east.answer("octocat", "Spoon-Knife")
    await until(() => github.holding() > 0)
    const waiting = west.answer("octocat", "Spoon-Knife")
    // Its first look found nothing to serve; its second is the wait.
    await until(() => westStore.looks.count >= 2)
    release()
    expect(answered(await first).cache).toBe("miss")
    expect(answered(await waiting)).toMatchObject({ cache: "hit", waitedMs: expect.any(Number) })
    // Stale everywhere: of fifteen visitors in each, one reads GitHub and the rest wait for a fresh answer.
    await age(SPOON)
    const before = github.calls.length
    release = github.hold()
    const crowd = Promise.all([east, west].flatMap((place) => Array.from({ length: 15 }, () => place.answer("octocat", "Spoon-Knife"))))
    await until(() => github.holding() > 0)
    release()
    const outcomes = await crowd
    expect(outcomes.every((outcome) => outcome._tag === "Answered")).toBe(true)
    expect(east.reads().length + west.reads().length).toBe(2)
    expect(github.calls.slice(before).filter((call) => call === "")).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.cache === "miss")).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.cache === "hit")).toHaveLength(29)
  })

  test("past freshness, a concurrent held read returns no content and can be retried", async () => {
    const github = scriptedGitHub()
    github.publish("octocat", "Spoon-Knife")
    const east = await isolate(github)
    await east.answer("octocat", "Spoon-Knife")
    await age(SPOON)
    const west = await isolate(github, { timing: { waitFor: Duration.millis(50), poll: Duration.millis(10) } })
    const release = github.hold()
    const reading = east.answer("octocat", "Spoon-Knife")
    try {
      await until(() => github.holding() > 0)
      const held = await west.answer("octocat", "Spoon-Knife")
      expect(held).toMatchObject({ _tag: "Refused", code: "unavailable", cache: "wait", retryAfterMillis: Duration.toMillis(RepoAbout.WAIT) })
      expect(held).not.toHaveProperty("text")
    } finally {
      release()
      expect(answered(await reading).cache).toBe("miss")
    }
    expect(answered(await west.answer("octocat", "Spoon-Knife")).cache).toBe("hit")
  })

  test("a request waiting for another's first read gets GitHub's refusal when that read is refused", async () => {
    const github = scriptedGitHub()
    github.publish("octocat", "Down")
    github.fail("", 502)
    const westStore = await watched()
    const [east, west] = [await isolate(github), await isolate(github, { store: westStore.store })]
    const release = github.hold()
    const first = east.answer("octocat", "Down")
    await until(() => github.holding() > 0)
    const waiting = west.answer("octocat", "Down")
    await until(() => westStore.looks.count >= 2)
    release()
    expect(await first).toMatchObject({ _tag: "Refused", code: "github_unavailable", cache: "miss" })
    expect(await waiting).toMatchObject({ _tag: "Refused", code: "github_unavailable", cache: "refusal", waitedMs: expect.any(Number) })
    expect(github.calls).toEqual([""])
  })

  test("a legacy reader's refusal remains readable both by its waiter and later cached requests", async () => {
    const github = scriptedGitHub()
    const watchedStore = await watched()
    const now = Date.now()
    const generation = await runtime.runPromise(watchedStore.store.claim(SPOON, now, now + 30_000))
    if (generation === false) throw new Error("expected ownership")
    const one = await isolate(github, { store: watchedStore.store, timing: { waitFor: Duration.seconds(2), poll: Duration.millis(10) } })
    const waiting = one.answer("octocat", "Spoon-Knife")
    await until(() => watchedStore.looks.count >= 2)
    await runtime.runPromise(watchedStore.store.refuse(SPOON, "rate_limited", now + 60_000, undefined, generation))
    const waited = await waiting
    expect(waited).toMatchObject({ _tag: "Refused", cache: "refusal", code: "rate_limited", waitedMs: expect.any(Number) })
    expect(waited).not.toHaveProperty("refusalVia")
    const cached = await one.answer("octocat", "Spoon-Knife")
    expect(cached).toMatchObject({ _tag: "Refused", cache: "refusal", code: "rate_limited" })
    expect(cached).not.toHaveProperty("refusalVia")
    expect(github.calls).toEqual([])
  })

  test("a first read that never lands: the waiting request asks the browser to come back, a store that fails included", async () => {
    const github = scriptedGitHub()
    github.publish("octocat", "Spoon-Knife")
    // Another data center claimed the read and never finished it.
    await sql(`INSERT INTO repo_about (repo_id, next_read_at) VALUES ('${SPOON}', now() + interval '30 seconds')`)
    const timing = { waitFor: Duration.millis(300), poll: Duration.millis(20) }
    const one = await isolate(github, { timing })
    const waited = await one.answer("octocat", "Spoon-Knife")
    expect(waited).toMatchObject({ _tag: "Refused", code: "unavailable", cache: "wait", retryAfterMillis: Duration.toMillis(RepoAbout.WAIT) })
    expect(waited.waitedMs).toBeGreaterThanOrEqual(300)
    expect(github.calls).toEqual([])
    // A store that answers the first look and then fails: nothing to serve until the wait ends.
    const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
    const real = AboutStore.postgres(scratch.database)
    let looks = 0
    const flaky = await isolate(github, {
      timing,
      store: { ...real, get: (id) => looks++ === 0 ? real.get(id) : Effect.fail(new AboutStore.StoreUnavailable({ op: "get" })) },
    })
    expect(await flaky.answer("octocat", "Spoon-Knife")).toMatchObject({ _tag: "Refused", cache: "wait" })
    expect(looks).toBeGreaterThan(2)
  })
})

describe("a store that fails", () => {
  const unavailable = (op: AboutStore.StoreUnavailable["op"]) => Effect.fail(new AboutStore.StoreUnavailable({ op }))
  const down: AboutStore.AboutStore = {
    get: () => unavailable("get"),
    claim: () => unavailable("claim"),
    keep: () => unavailable("keep"),
    refuse: () => unavailable("refuse"),
    appAbsent: () => unavailable("app_absent"),
  }

  test("lookup errors refuse a cold crowd without reading GitHub and name the failure", async () => {
    const github = scriptedGitHub()
    github.publish("octocat", "Spoon-Knife")
    const one = await isolate(github, { config: await appConfig(), store: down })
    const crowd = await Promise.all(Array.from({ length: 12 }, () => one.answer("octocat", "Spoon-Knife")))
    for (const served of crowd) {
      expect(served).toMatchObject({ _tag: "Refused", code: "unavailable", retryAfterMillis: 1000, store: ["get"] })
      expect(RepoAbout.fieldsOf(served)).toMatchObject({ store: "get" })
    }
    expect(github.calls).toEqual([])
  })
})
test("a superseded public reader cannot republish or return content after a newer not_found in real Postgres", async () => {
  const github = scriptedGitHub()
  github.publish("octocat", "Spoon-Knife")
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const real = AboutStore.postgres(scratch.database)
  const reached = Deferred.makeUnsafe<void>()
  const released = Deferred.makeUnsafe<void>()
  let now = Date.UTC(2026, 10, 2)
  const a = await isolate(github, { now: () => now, store: {
    ...real,
    keep: (...args) => Effect.gen(function* () {
      yield* Deferred.succeed(reached, undefined)
      yield* Deferred.await(released)
      return yield* real.keep(...args)
    }),
  } })
  const delayed = a.answer("octocat", "Spoon-Knife")
  try {
    await Effect.runPromise(Deferred.await(reached)) // A has already read the public README; only its real SQL write is held.
    now += 30_000 // The claim expires; no wall-clock wait.
    github.fail("", 404)
    const b = await isolate(github, { now: () => now })
    expect(await b.answer("octocat", "Spoon-Knife")).toMatchObject({ _tag: "Refused", code: "not_found" })
  } finally { await Effect.runPromise(Deferred.succeed(released, undefined)) }
  const rejected = await delayed
  expect(rejected).toMatchObject({ _tag: "Refused", code: "unavailable", writeRejected: "keep" })
  expect(RepoAbout.fieldsOf(rejected)).toMatchObject({ writeRejected: "keep" })
  const kept = Option.getOrThrow(await runtime.runPromise(real.get(SPOON)))
  expect(kept.answer).toEqual(Option.none())
  expect(kept.refusal).toBe("not_found")
})

})

// These regressions use the same clock and store seams without needing a database.
const noDatabase = Layer.effect(SqlClient.SqlClient, Effect.die("This read must not access Postgres"))

test("store reads decide freshness on completion and never extend the remaining cache lifetime", async () => {
  for (const waiting of [false, true]) {
    for (const remaining of [1500, 500, 0, -1]) {
      const github = scriptedGitHub()
      let now = 0
      let reading = waiting
      const completed: AboutStore.Kept = {
        answer: Option.some({ text: "fresh", via: "anonymous", readAtMs: 0, freshUntilMs: 2000 }),
        nextReadAtMs: 30_000, refusal: "github_unavailable", appAbsentUntilMs: null,
      }
      const store: AboutStore.AboutStore = {
        get: () => Effect.sync(() => {
          if (reading) {
            reading = false
            return Option.some({ ...completed, answer: Option.none(), refusal: null })
          }
          now = 2000 - remaining // Time passes while the store reads, including across expiry.
          return Option.some(completed)
        }),
        claim: () => Effect.succeed(false),
        keep: () => Effect.succeed(true), refuse: () => Effect.succeed(true), appAbsent: () => Effect.void,
      }
      const one = await isolate(github, { store, database: noDatabase, now: () => now, timing: { poll: Duration.zero, waitFor: RepoAbout.WAIT_FOR } })
      const result = await one.answer("octocat", "Spoon-Knife")
      expect(result, JSON.stringify({ waiting, remaining })).toMatchObject(remaining > 0
        ? { _tag: "Answered", text: "fresh", maxAgeSeconds: Math.floor(remaining / 1000) }
        : { _tag: "Refused", code: "github_unavailable" })
      expect(github.calls).toEqual([])
    }
  }
  // A newly fetched answer can also age while the store persists it.
  for (const remaining of [1500, 500, 0, -1]) {
    const github = scriptedGitHub()
    github.publish("octocat", "Spoon-Knife")
    let now = 0
    const store: AboutStore.AboutStore = {
      get: () => Effect.succeed(Option.none()),
      claim: () => Effect.succeed("1"),
      keep: () => Effect.sync(() => { now = 60_000 - remaining; return true }),
      refuse: () => Effect.succeed(true), appAbsent: () => Effect.void,
    }
    const one = await isolate(github, {
      store, database: noDatabase, now: () => now, config: { REPO_ABOUT_ANONYMOUS_FRESH_MINUTES: "1" },
    })
    expect(await one.answer("octocat", "Spoon-Knife")).toMatchObject(remaining > 0
      ? { _tag: "Answered", maxAgeSeconds: Math.floor(remaining / 1000) }
      : { _tag: "Refused", code: "unavailable", retryAfterMillis: 1000 })
  }
})

test("failed claims refuse a crowd with either an existing or missing row without reading GitHub", async () => {
  for (const exists of [true, false]) {
    const github = scriptedGitHub()
    github.publish("octocat", "Spoon-Knife")
    const expired: AboutStore.Kept = {
      answer: Option.some({ text: "expired", via: "anonymous", readAtMs: 0, freshUntilMs: 1000 }),
      nextReadAtMs: null, refusal: null, appAbsentUntilMs: null,
    }
    const store: AboutStore.AboutStore = {
      get: () => Effect.succeed(exists ? Option.some(expired) : Option.none()),
      claim: () => Effect.fail(new AboutStore.StoreUnavailable({ op: "claim" })),
      keep: () => Effect.succeed(true), refuse: () => Effect.succeed(true), appAbsent: () => Effect.void,
    }
    const one = await isolate(github, { store, database: noDatabase, now: 2000 })
    const crowd = await Promise.all(Array.from({ length: 12 }, () => one.answer("octocat", "Spoon-Knife")))
    for (const result of crowd) expect(result).toMatchObject({
      _tag: "Refused", code: "unavailable", retryAfterMillis: 1000, store: ["claim"],
    })
    expect(github.calls).toEqual([])
  }
})



test("a failed curated recovery claim performs zero GitHub token or metadata reads", async () => {
  const github = scriptedGitHub()
  const store: AboutStore.AboutStore = {
    get: () => Effect.succeed(Option.some({ answer: Option.none(), refusal: "rate_limited", refusalVia: "anonymous", nextReadAtMs: 60_000, appAbsentUntilMs: null })),
    claim: () => Effect.fail(new AboutStore.StoreUnavailable({ op: "claim" })),
    keep: () => Effect.die("no save without ownership"), refuse: () => Effect.die("no refusal write without ownership"),
    appAbsent: () => Effect.die("no token lookup without ownership"),
  }
  const one = await isolate(github, { store, database: noDatabase, now: 0, config: await appConfig() })
  expect(await one.answer("Effect-TS", "effect")).toMatchObject({ _tag: "Refused", code: "unavailable", store: ["claim"], retryAfterMillis: 1000 })
  expect(github.calls).toEqual([])
})
