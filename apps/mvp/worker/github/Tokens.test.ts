// What an installation token's failure says (worker/github/Tokens.vibe): GitHub's status, the wait it named in full or
// by its headers, a rate limit, and a refusal kept apart from a limit; a Postgres failure is unavailable with no status.
import { Core, type GitHub } from "@smthrs/integrations"
import { Effect, Option, Redacted } from "effect"
import { describe, expect, test } from "vitest"
import { testFile } from "../test/harness.ts"
import { repositoryOf } from "./Config.vibe"
import { make, type TokenUnavailable } from "./Tokens.vibe"

const runtime = testFile("github_tokens")

const failure = (details: Record<string, unknown>) =>
  new Core.IntegrationError.IntegrationError("delivery-failed", "GitHub refused the token", details)

/** An App that finds installation `installationId` and fails every mint with `minted`'s error. */
const app = (minted: Core.IntegrationError.IntegrationError, installationId = 7): GitHub.AppAuth.AppAuth => ({
  jwt: Effect.succeed(Redacted.make("jwt")),
  installation: () => Effect.succeed({ id: installationId }),
  installationToken: () => Effect.fail(minted),
})

const refused = (repo: string, minted: Core.IntegrationError.IntegrationError, installationId?: number) =>
  runtime.runPromise(Effect.flip(make({ app: app(minted, installationId), keys: Option.none(), refresh: () => Effect.void })
    .forInstallation(repositoryOf(repo), "write")))

const fields = (error: TokenUnavailable) => ({
  reason: error.reason,
  retryAfterMillis: error.retryAfterMillis,
  rateLimited: error.rateLimited,
  upstreamStatus: error.upstreamStatus,
  fullWaitMillis: error.fullWaitMillis,
  headerLimited: error.headerLimited,
})

describe("forInstallation's failures", () => {
  test("a rate limit names its capped retry, its full wait, and that GitHub's headers named it", async () => {
    const error = await refused("acme/limited", failure({
      status: 403, rateLimited: true, retryable: true, retryAfterMillis: 1_000, retryAfterUncappedMillis: 90_000,
    }))
    expect(fields(error)).toEqual({
      reason: "unavailable", retryAfterMillis: 1_000, rateLimited: true, upstreamStatus: 403, fullWaitMillis: 90_000,
      headerLimited: true,
    })
  })

  test("a 403 whose headers say the limit is spent is still a refusal, with the wait until the limit resets", async () => {
    const error = await refused("acme/spent", failure({
      status: 403, retryable: false, ratelimitRemaining: "0", rateLimitResetAt: Date.now() + 120_000,
    }))
    expect(fields(error)).toMatchObject({ reason: "not_allowed", upstreamStatus: 403, headerLimited: true, rateLimited: undefined })
    expect(error.fullWaitMillis).toBeGreaterThan(100_000)
  })

  test("a spent limit with no reset names no wait", async () => {
    const error = await refused("acme/noreset", failure({ status: 403, retryable: false, ratelimitRemaining: "0" }))
    expect(fields(error)).toEqual({
      reason: "not_allowed", retryAfterMillis: undefined, rateLimited: undefined, upstreamStatus: 403,
      fullWaitMillis: undefined, headerLimited: true,
    })
  })

  test("a 429 whose reset has passed is a rate limit with no wait to name", async () => {
    const error = await refused("acme/passed", failure({ status: 429, rateLimited: true, rateLimitResetAt: Date.now() - 1_000 }))
    expect(fields(error)).toEqual({
      reason: "unavailable", retryAfterMillis: undefined, rateLimited: true, upstreamStatus: 429, fullWaitMillis: undefined,
      headerLimited: undefined,
    })
  })

  test("a plain 403 is a refusal and names no limit", async () => {
    const error = await refused("acme/plain", failure({ status: 403, retryable: false }))
    expect(fields(error)).toEqual({
      reason: "not_allowed", retryAfterMillis: undefined, rateLimited: undefined, upstreamStatus: 403,
      fullWaitMillis: undefined, headerLimited: undefined,
    })
  })

  test("GitHub failing to answer is unavailable, with its status", async () => {
    const error = await refused("acme/down", failure({ status: 502, retryable: true }))
    expect(fields(error)).toEqual({
      reason: "unavailable", retryAfterMillis: undefined, rateLimited: undefined, upstreamStatus: 502,
      fullWaitMillis: undefined, headerLimited: undefined,
    })
  })

  test("Postgres refusing to remember the installation is unavailable, with no GitHub status", async () => {
    // An installation id past bigint: GitHub's answer reaches Postgres, which refuses it.
    const error = await refused("acme/overflow", failure({ status: 500 }), 2 ** 70)
    expect(fields(error)).toEqual({
      reason: "unavailable", retryAfterMillis: undefined, rateLimited: undefined, upstreamStatus: undefined,
      fullWaitMillis: undefined, headerLimited: undefined,
    })
  })
})
