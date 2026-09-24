/**
 * `S.Github.Pr` declaration boundary. Its refusal gate is the shared
 * `Outward.refuse`, covered in Outward.test.ts; no transport exists yet, so
 * the package planner refuses the rule before that gate runs.
 */
import { describe, expect, it } from "vitest"
import * as GithubTarget from "../src/GithubTarget.ts"
import { HttpSecret, Secret } from "../src/Secret.ts"

describe("Github.Pr", () => {
  it("rejects an unbound secret source at the target boundary", () => {
    expect(() => GithubTarget.Pr({ gates: [], secrets: [Secret("GITHUB_TOKEN") as never] }))
      .toThrow(/declaration is invalid/)
  })

  it("keeps a declared token and approval on its attrs", () => {
    const attrs = GithubTarget.prAttrsOf(GithubTarget.Pr({
      gates: [],
      secrets: [HttpSecret(Secret("GITHUB_TOKEN"), ["https://api.github.com"])],
      approval: "required"
    }))
    expect(attrs.secrets?.map((credential) => credential.secret.env)).toEqual(["GITHUB_TOKEN"])
    expect(attrs.approval).toBe("required")
  })
})
