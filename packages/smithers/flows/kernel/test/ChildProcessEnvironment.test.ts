import { describe, expect, it, vi } from "vitest"
import * as ChildProcessEnvironment from "../src/ChildProcessEnvironment.vibe"

describe("ChildProcessEnvironment", () => {
  const credentialNames = [
    "AUTHORIZATION",
    "APIKEY",
    "API_KEY",
    "X-API-KEY",
    "ACCESSTOKEN",
    "ACCESS-TOKEN",
    "REFRESHTOKEN",
    "IDTOKEN",
    "AUTHTOKEN",
    "APITOKEN",
    "SESSIONTOKEN",
    "BEARER",
    "TOKEN",
    "MY_TOKEN",
    "MY-TOKEN",
    "SECRET",
    "CREDENTIAL",
    "PASSWORD",
    "PASSPHRASE",
    "PASSWD",
    "SIGNATURE",
    "X-AMZ-SIGNATURE",
    "COOKIE",
    "SET-COOKIE",
    "CHATGPT_ACCOUNT_ID",
    "authorization",
    "KEY",
    "KEY_ID",
    "PRIVATE_KEY",
    "AWS_ACCESS_KEY_ID",
    "SSH_KEY",
    "GPG_KEY",
    "ENCRYPTION_KEY",
    "MASTER_KEY",
    "PRIVATE-KEY",
    "AWS-ACCESS-KEY-ID",
    "PAT",
    "GITHUB_PAT",
    "GITHUB-PAT",
    "github_pat"
  ]

  it.each(credentialNames)("classifies %s as a credential name", (name) => {
    expect(ChildProcessEnvironment.isCredentialName(name)).toBe(true)
  })

  it.each([
    "TOKEN_COUNT",
    "MAX_TOKENS",
    "TOKENIZER",
    "AUTHOR",
    "KEYBOARD",
    "MONKEY",
    "KEY_COUNT",
    "KEY_IDS",
    "PAT_COUNT",
    "PATTERN",
    "COMPAT"
  ])("keeps %s an ordinary diagnostic name", (name) => {
    expect(ChildProcessEnvironment.isCredentialName(name)).toBe(false)
  })

  it.each(credentialNames)("withholds credential-shaped locale name LC_%s", (name) => {
    expect(ChildProcessEnvironment.make({ [`LC_${name}`]: "ambient-secret" })).toEqual({})
  })

  it.each([
    "PRIVATE_KEY",
    "AWS_ACCESS_KEY_ID",
    "SSH_KEY",
    "GPG_KEY",
    "ENCRYPTION_KEY",
    "MASTER_KEY",
    "GITHUB_PAT"
  ])("withholds ambient %s even if the bootstrap allowlist admits it", (name) => {
    // Simulate a future inheritedNames expansion at its private Set lookup.
    const inherited = vi.spyOn(Set.prototype, "has").mockReturnValue(true)
    let environment: Record<string, string>
    try {
      environment = ChildProcessEnvironment.make({ [name]: "ambient-secret" })
    } finally {
      inherited.mockRestore()
    }
    expect(environment).toEqual({})
  })

  it("inherits lowercase bootstrap and locale names", () => {
    expect(ChildProcessEnvironment.make({ path: "/bin", lc_messages: "C" }))
      .toEqual({ path: "/bin", lc_messages: "C" })
  })

  it("lets a lowercase declaration replace an inherited uppercase name", () => {
    expect(ChildProcessEnvironment.make({ PATH: "/bin" }, { path: "/usr/bin" }))
      .toEqual({ path: "/usr/bin" })
  })

  it("lets a lowercase undefined declaration remove an inherited uppercase name", () => {
    expect(ChildProcessEnvironment.make({ PATH: "/bin", LANG: "C" }, { lang: undefined }))
      .toEqual({ PATH: "/bin" })
  })

  it("selects bootstrap and locale names without ambient credentials", () => {
    const environment = ChildProcessEnvironment.make({
      PATH: "/bin",
      HOME: "/home/runner",
      LC_MESSAGES: "C",
      LC_API_KEY: "ambient-sensitive-locale",
      ANTHROPIC_API_KEY: "ambient-anthropic",
      OPENAI_API_KEY: "ambient-openai",
      GH_TOKEN: "ambient-github",
      ORDINARY_AMBIENT: "hidden"
    }, {
      ORDINARY_DECLARED: "visible",
      EXPLICIT_API_KEY: "declared-secret"
    })

    expect(environment).toEqual({
      PATH: "/bin",
      HOME: "/home/runner",
      LC_MESSAGES: "C",
      ORDINARY_DECLARED: "visible",
      EXPLICIT_API_KEY: "declared-secret"
    })
    expect(Object.getPrototypeOf(environment)).toBeNull()
  })

  it("lets an undefined declaration remove an inherited name", () => {
    expect(ChildProcessEnvironment.make({ PATH: "/bin", LANG: "C" }, { LANG: undefined }))
      .toEqual({ PATH: "/bin" })
  })
})
