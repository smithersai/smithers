import { describe, expect, it } from "vitest"
import { compareVersions, verifyHost } from "../examples/check-runtime.vibe"
import { digestNpmrc } from "../examples/digest-npmrc.vibe"

describe("examples/check-runtime", () => {
  it("compares versions and refuses an unsupported operator", () => {
    expect(compareVersions()).toEqual({
      atLeast: true,
      exact: true,
      below: false,
      caret: "unsupported_requirement"
    })
  })

  it("verifies a satisfying host and reports the refusal for an older one", async () => {
    expect(await verifyHost("26.10.0")).toBe("26.10.0")
    expect(await verifyHost("24.9.0")).toBe("unsatisfied")
  })
})

describe("examples/digest-npmrc", () => {
  it("digests a placeholder credential and refuses a literal one", async () => {
    const placeholder = await digestNpmrc("//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n")
    expect(placeholder).toMatch(/^[0-9a-f]{64}$/)
    expect(await digestNpmrc("//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n")).toBe(placeholder)
    expect(await digestNpmrc("//registry.npmjs.org/:_authToken=npm_literal0123456789\n")).toBe(
      "unsafe_configuration"
    )
  })
})
