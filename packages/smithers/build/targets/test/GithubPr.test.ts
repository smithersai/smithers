/**
 * `S.Github.Pr` refusal paths: the target never reaches its outward action
 * without the declared token secret and a satisfied approval. Values are a
 * transport concern. No transport exists yet, so the package planner refuses
 * the rule before this gate runs.
 */
import { describe, expect, it } from "vitest"
import * as GithubTarget from "../src/GithubTarget.ts"
import { HttpSecret, Secret } from "../src/Secret.ts"
import type * as Target from "../src/Target.ts"

const withToken = (approval?: "required"): Target.AnyTarget =>
  GithubTarget.Pr({
    gates: [],
    secrets: [HttpSecret(Secret("GITHUB_TOKEN"), ["https://api.github.com"])],
    ...(approval === undefined ? {} : { approval })
  })

describe("refusePr", () => {
  it("rejects an unbound secret source at the target boundary", () => {
    expect(() => GithubTarget.Pr({ gates: [], secrets: [Secret("GITHUB_TOKEN") as never] }))
      .toThrow(/declaration is invalid/)
  })

  it("refuses a declaration that never names the GITHUB_TOKEN secret", () => {
    const pr = GithubTarget.Pr({
      gates: [],
      secrets: [HttpSecret(Secret("OTHER_TOKEN"), ["https://api.github.com"])]
    })
    const refusal = GithubTarget.refusePr(pr, { approvalGranted: true })
    expect(refusal).toBeDefined()
    expect(refusal!.code).toBe("missing_token_secret")
    expect(refusal!.message).toContain("GITHUB_TOKEN")
  })

  it("refuses a declaration with no secrets at all", () => {
    const pr = GithubTarget.Pr({ gates: [] })
    const refusal = GithubTarget.refusePr(pr, { approvalGranted: true })
    expect(refusal!.code).toBe("missing_token_secret")
  })

  it("refuses approval:\"required\" without a granted approval", () => {
    const refusal = GithubTarget.refusePr(withToken("required"), { approvalGranted: false })
    expect(refusal!.code).toBe("approval_unsatisfied")
  })

  it("passes a satisfied invocation through with no refusal", () => {
    expect(GithubTarget.refusePr(withToken("required"), { approvalGranted: true })).toBeUndefined()
    expect(GithubTarget.refusePr(withToken(), { approvalGranted: false })).toBeUndefined()
  })

  it("never leaks the token value into the refusal text", () => {
    const refusal = GithubTarget.refusePr(withToken("required"), { approvalGranted: false })
    expect(refusal!.message).not.toContain("ghp_supersecret")
  })
})

describe("isPrRefused", () => {
  it("guards reject non-refusal values", () => {
    expect(GithubTarget.isPrRefused(new Error("plain"))).toBe(false)
    expect(GithubTarget.isPrRefused(undefined)).toBe(false)
  })
})
