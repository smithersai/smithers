/**
 * Real-backend contract test for the GitHub adapter.
 *
 * Runs against api.github.com with the token in `GITHUB_TOKEN`. There is no
 * fixture server here on purpose: the fixture suites prove the client's
 * behavior, and this suite proves the wire contract it assumes is still the
 * one GitHub serves. Skipped, with the credential named, when the token is
 * absent.
 *
 * A read-only token is enough. Nothing here writes.
 */
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { gitHubClient } from "./Http.ts"

const token = process.env["GITHUB_TOKEN"] ?? process.env["SMITHERS_GITHUB_TOKEN"]

// GitHub App installation tokens (ghs_ prefix) cannot call /user at all: the
// API answers 403 "Resource not accessible by integration" by contract, not by
// misconfiguration. Only the viewer case needs a user token; every other case
// here exercises endpoints an installation token may call.
const installationToken = token !== undefined && token.startsWith("ghs_")

// Skipped without a credential: set GITHUB_TOKEN (or SMITHERS_GITHUB_TOKEN) to
// a token with public read access to run it.
describe.skipIf(token === undefined)("GitHub live contract (GITHUB_TOKEN)", () => {
  const client = gitHubClient({ token })

  it.skipIf(installationToken)("authenticates and returns the viewer", async () => {
    const viewer = await Effect.runPromise(
      client.request("GET", "/user", undefined, { schema: Schema.Struct({ login: Schema.String }) })
    )
    expect(typeof viewer.login).toBe("string")
  }, 30_000)

  it("reports the rate-limit headers the retry policy reads", async () => {
    const RateLimit = Schema.Struct({
      resources: Schema.Struct({
        core: Schema.Struct({ limit: Schema.Number, remaining: Schema.Number, reset: Schema.Number })
      })
    })
    const limits = await Effect.runPromise(
      client.request("GET", "/rate_limit", undefined, { schema: RateLimit })
    )
    const core = limits.resources.core
    expect(typeof core.limit).toBe("number")
    expect(typeof core.remaining).toBe("number")
    expect(typeof core.reset).toBe("number")
  }, 30_000)

  it("paginates a real Link header", async () => {
    const page = await Effect.runPromise(
      client.paginate("/repos/microsoft/TypeScript/issues", { perPage: 5, maxPages: 2 })
    )
    expect(page.items.length).toBeGreaterThan(5)
    // Two pages of five out of a repository with thousands of issues: the cap
    // is what stopped the walk, and the client says so.
    expect(page.truncated).toBe(true)
  }, 60_000)

  it("classifies a real 404 as a non-retryable delivery failure", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(client.request("GET", "/repos/smithersai/this-repository-does-not-exist-9f2a"))
    )
    expect(failure.reason).toBe("delivery-failed")
    expect(failure.details).toMatchObject({ status: 404, retryable: false })
    if (token !== undefined) expect(JSON.stringify(failure.details)).not.toContain(token)
  }, 30_000)
})
