import { describe, expect, it } from "vitest"
import { personalModelTestDiagnostic } from "./personal-model-result"

describe("personal model setup diagnostics", () => {
  it.each([
    ["quota_exceeded", 429, "quota used up; HTTP 429"],
    ["out_of_credit", 402, "out of credit; HTTP 402"],
    ["authentication", 401, "key refused; HTTP 401"],
    ["transport", null, "unreachable"],
    ["call_timeout", null, "timed out"],
  ])("distinguishes %s without the provider's message", (code, status, expected) => {
    expect(personalModelTestDiagnostic({ ok: false, code, status, message: "private-provider-response" })).toBe(expected)
  })

  it("never echoes unknown codes, hosts, messages or string statuses", () => {
    const secret = "private-provider-response"
    expect(personalModelTestDiagnostic({ code: secret, status: secret, host: secret, message: secret })).toBe("failed")
    expect(personalModelTestDiagnostic({ code: "__proto__", status: 503 })).toBe("failed; HTTP 503")
  })

  it.each([undefined, null, "private-provider-response", false, 429, [], {}])("handles malformed results (%j)", (result) => {
    expect(personalModelTestDiagnostic(result)).toBe("failed")
  })

  it.each([undefined, null, "429", NaN, Infinity, 99, 600, 429.5])("omits invalid HTTP statuses (%s)", (status) => {
    expect(personalModelTestDiagnostic({ code: "quota_exceeded", status })).toBe("quota used up")
  })

  it.each([100, 599])("keeps valid HTTP status boundaries (%i)", (status) => {
    expect(personalModelTestDiagnostic({ status })).toBe(`failed; HTTP ${status}`)
  })
})
