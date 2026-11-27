import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import { testFile } from "../test/harness.ts"
import { mintOneTimeToken, redeemOneTimeToken } from "./OneTimeAuth.vibe"

const runtime = testFile("one_time_auth_integration")

beforeEach(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO people (id, github_id, github_login) VALUES (${"11111111-1111-4111-8111-111111111111"}, ${2001}, ${"roninjin10"}) ON CONFLICT (id) DO NOTHING`
      yield* sql`INSERT INTO people (id, github_id, github_login) VALUES (${"44444444-4444-4444-8444-444444444444"}, ${2002}, ${"contributor-bob"}) ON CONFLICT (id) DO NOTHING`
    }),
  )
})

describe("OneTimeAuth Postgres integration", () => {
  test("mints single-use smot_ token, redeems atomically once into sma_ bearer token, and rejects replays", async () => {
    const minted = await runtime.runPromise(
      mintOneTimeToken({
        origin: "https://smithers.sh",
        owner: "smithersai",
        name: "smithers",
        personId: "11111111-1111-4111-8111-111111111111",
        login: "roninjin10",
        role: "maintainer",
        isDeploymentAdmin: true,
        sandboxAttested: false,
        purpose: "sandbox",
        ttlSeconds: 300,
        label: "ci-sandbox-1",
      }),
    )

    expect(minted.oneTimeToken.startsWith("smot_")).toBe(true)
    expect(minted.executionTrust).toBe("trusted_sandbox")
    expect(minted.shellSnippet).toContain("SMITHERS_ONE_TIME_TOKEN=")

    // Race two concurrent redemptions: strictly ONE succeeds and ONE fails with already_used.
    const [r1, r2] = await Promise.all([
      runtime.runPromise(Effect.result(redeemOneTimeToken({ origin: "https://smithers.sh", token: minted.oneTimeToken }))),
      runtime.runPromise(Effect.result(redeemOneTimeToken({ origin: "https://smithers.sh", token: minted.oneTimeToken }))),
    ])

    const successes = [r1, r2].filter((r) => r._tag === "Success")
    const failures = [r1, r2].filter((r) => r._tag === "Failure")
    expect(successes.length).toBe(1)
    expect(failures.length).toBe(1)

    const redeemed = successes[0]!._tag === "Success" ? successes[0].success : null
    expect(redeemed).not.toBeNull()
    expect(redeemed!.accessToken.startsWith("sma_")).toBe(true)
    expect(redeemed!.executionTrust).toBe("trusted_sandbox")
    expect(redeemed!.gateEligible).toBe(true)
    expect(redeemed!.cacheWriteAllowed).toBe(true)
    expect(redeemed!.mcpUrl).toBe("https://smithers.sh/smithersai/smithers/mcp")

    const err = failures[0]!._tag === "Failure" ? failures[0].failure : null
    expect(err?.code).toBe("token_already_used")

    // Subsequent third replay also fails.
    const replay = await runtime.runPromise(Effect.flip(redeemOneTimeToken({ origin: "https://smithers.sh", token: minted.oneTimeToken })))
    expect(replay.code).toBe("token_already_used")
  })

  test("non-maintainer minting is always attenuated to untrusted_contributor", async () => {
    const minted = await runtime.runPromise(
      mintOneTimeToken({
        origin: "https://smithers.sh",
        owner: "smithersai",
        name: "smithers",
        personId: "44444444-4444-4444-8444-444444444444",
        login: "contributor-bob",
        role: "guest",
        isDeploymentAdmin: false,
        sandboxAttested: false,
        purpose: "agent",
      }),
    )
    expect(minted.executionTrust).toBe("untrusted_contributor")

    const redeemed = await runtime.runPromise(redeemOneTimeToken({ origin: "https://smithers.sh", token: minted.oneTimeToken }))
    expect(redeemed.executionTrust).toBe("untrusted_contributor")
    expect(redeemed.gateEligible).toBe(false)
    expect(redeemed.cacheWriteAllowed).toBe(false)
  })
})
