// What GitHub REST reads of public repositories go out as (worker/github/ReadToken.ts): `GITHUB_TOKEN`, else the App's
// installation token for the deployment's own repository, else none. The App is `GitHub.AppAuth` over the scripted
// GitHub (worker/github/test/scriptedGitHub.ts) on the `HttpClient` seam; nothing intercepts a request.
import { ConfigProvider, Deferred, Effect, Fiber, Logger, Metric, Option, Redacted } from "effect"
import { describe, expect, test } from "vitest"
import * as Metrics from "./Metrics.ts"
import * as ReadToken from "./ReadToken.ts"
import { APP_ID, appKey, INSTALLATION_ID, SCRIPTED_API, scriptedApp, scriptedGitHub } from "./test/scriptedGitHub.ts"

const value = (token: Option.Option<Redacted.Redacted<string>>) => Option.getOrUndefined(Option.map(token, Redacted.value))

/** Runs reads with their own metric registry and log lines, and reads back what they recorded. */
const observed = () => {
  const registry: Metric.MetricRegistry = new Map()
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const logger = Logger.make((options) => void logs.push(Logger.formatStructured.log(options)))
  return {
    run: <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.runPromise(effect.pipe(
        Effect.provideService(Metric.MetricRegistry, registry),
        Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      )),
    mints: (outcome: string) =>
      Effect.runSync(Metric.value(Metric.withAttributes(Metrics.tokenMints, { kind: "read", outcome })).pipe(
        Effect.provideService(Metric.MetricRegistry, registry),
      )).count,
    lines: () => logs.filter((log) => log.message === "github.read_token").map((log) => ({ level: log.level, ...log.annotations })),
  }
}

describe("ReadToken.fromApp", () => {
  test("mints the App's token for the deployment's repository with metadata: read only, and keeps it while it lasts", async () => {
    const github = scriptedGitHub("acme", "widgets")
    const token = await Effect.runPromise(ReadToken.fromApp(await Effect.runPromise(scriptedApp(github, await appKey())), github))
    expect(value(await Effect.runPromise(token))).toBe("ghs_scripted_1")
    expect(value(await Effect.runPromise(token))).toBe("ghs_scripted_1")
    expect(github.minted.map((minted) => minted.body)).toEqual([
      { repositories: ["widgets"], permissions: { metadata: "read" } },
    ])
  })

  test("a token within five minutes of its expiry is minted again", async () => {
    const github = scriptedGitHub("acme", "widgets")
    // GitHub's clock is 56 minutes behind: what it mints expires in 4.
    github.now = Date.now() - 56 * 60 * 1000
    const token = await Effect.runPromise(ReadToken.fromApp(await Effect.runPromise(scriptedApp(github, await appKey())), github))
    expect(value(await Effect.runPromise(token))).toBe("ghs_scripted_1")
    github.now = Date.now()
    expect(value(await Effect.runPromise(token))).toBe("ghs_scripted_2")
    expect(value(await Effect.runPromise(token))).toBe("ghs_scripted_2")
  })

  test("a read never waits on another read's mint: each cold read mints its own, and the last minted is kept", async () => {
    // workerd cancels a request waiting on another request's permit or I/O as hung (decision 0104), so nothing is shared
    // but the token itself.
    const github = scriptedGitHub("acme", "widgets")
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const minting = Deferred.makeUnsafe<void>()
    github.faults.push({
      match: (method, path) => method === "POST" && path === `/app/installations/${INSTALLATION_ID}/access_tokens`,
      hold: async () => {
        await Effect.runPromise(Deferred.succeed(minting, undefined))
        await held
      },
    })
    const token = await Effect.runPromise(ReadToken.fromApp(await Effect.runPromise(scriptedApp(github, await appKey())), github))
    const tokens = await Effect.runPromise(Effect.gen(function* () {
      const first = yield* token.pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(minting)
      // The first read's mint is still in flight at GitHub; the second read mints for itself instead of waiting.
      const second = yield* token.pipe(Effect.timeoutOption("5 seconds"))
      release()
      const firstToken = yield* Fiber.join(first)
      return { first: firstToken, second, next: yield* token }
    }))
    expect(Option.map(tokens.second, value)).toEqual(Option.some("ghs_scripted_1"))
    expect(value(tokens.first)).toBe("ghs_scripted_2")
    // The last one minted is held, and serves the next read without another mint.
    expect(value(tokens.next)).toBe("ghs_scripted_2")
    expect(github.minted).toHaveLength(2)
  })

  test("each mint is counted and logged by outcome, never with the token", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.installed = false
    const token = await Effect.runPromise(ReadToken.fromApp(await Effect.runPromise(scriptedApp(github, await appKey())), github))
    const reads = observed()
    expect(await reads.run(token)).toEqual(Option.none())
    github.installed = true
    expect(value(await reads.run(token))).toBe("ghs_scripted_1")
    expect(value(await reads.run(token))).toBe("ghs_scripted_1")
    expect({ minted: reads.mints("minted"), anonymous: reads.mints("anonymous") }).toEqual({ minted: 1, anonymous: 1 })
    const lines = reads.lines()
    expect(lines).toMatchObject([
      { level: "WARN", outcome: "anonymous", errorCode: expect.any(String) },
      { level: "INFO", outcome: "minted", durationMs: expect.any(Number) },
    ])
    expect(JSON.stringify(lines)).not.toContain("ghs_scripted")
  })

  test("an App GitHub won't mint for reads anonymously this once, and the next read mints again", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.installed = false
    const token = await Effect.runPromise(ReadToken.fromApp(await Effect.runPromise(scriptedApp(github, await appKey())), github))
    expect(await Effect.runPromise(token)).toEqual(Option.none())
    github.installed = true
    expect(value(await Effect.runPromise(token))).toBe("ghs_scripted_1")
  })
})

describe("ReadToken.fromConfig", () => {
  const read = async (config: Record<string, string>) => {
    const github = scriptedGitHub("acme", "widgets")
    const token = await Effect.runPromise(
      ReadToken.fromConfig.pipe(
        Effect.flatMap((made) => made),
        Effect.provide(github.layer),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
      ),
    )
    return { token: value(token), calls: github.calls.length }
  }

  test("the App's token for GITHUB_REPOSITORY when the App is configured and GITHUB_TOKEN isn't", async () => {
    // Before, no GITHUB_TOKEN meant anonymous: 60 calls an hour shared with every Worker on Cloudflare's addresses.
    const app = {
      GITHUB_APP_ID: APP_ID,
      GITHUB_APP_PRIVATE_KEY: Redacted.value(await appKey()),
      GITHUB_API_URL: SCRIPTED_API,
      GITHUB_REPOSITORY: "acme/widgets",
    }
    expect(await read(app)).toEqual({ token: "ghs_scripted_1", calls: 2 })
    expect(await read({ ...app, GITHUB_TOKEN: "   " })).toEqual({ token: "ghs_scripted_1", calls: 2 })
    // GITHUB_TOKEN, when set, wins, and GitHub isn't asked.
    expect(await read({ ...app, GITHUB_TOKEN: "ghp_bot" })).toEqual({ token: "ghp_bot", calls: 0 })
  })

  test("neither, an App key that doesn't import, or an App configuration that doesn't read: anonymous", async () => {
    expect(await read({})).toEqual({ token: undefined, calls: 0 })
    expect(await read({ GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: "not a key", GITHUB_API_URL: SCRIPTED_API }))
      .toEqual({ token: undefined, calls: 0 })
    expect(await read({ GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: "not a key", GITHUB_API_URL: "not a url" }))
      .toEqual({ token: undefined, calls: 0 })
  })
})
