// How the GitHub flows read a failed call (worker/github/Calls.ts): a lost write's answer, a wait GitHub asked for, a
// refusal with its status, and anything that isn't one of `@smthrs/integrations`' failures.
import { Core } from "@smthrs/integrations"
import { describe, expect, test } from "vitest"
import { classify, MAX_WAIT_MILLIS, statusOf } from "./Calls.ts"

const failure = (details: Record<string, unknown>) =>
  new Core.IntegrationError.IntegrationError("delivery-failed", "GitHub request failed", details)

describe("classify", () => {
  test("a lost write's answer is unknown; a refusal carries GitHub's status", () => {
    expect(classify(failure({ outcomeUnknown: true, retryable: false }))).toEqual({ kind: "unknown" })
    expect(classify(failure({ status: 422, retryable: false }))).toEqual({ kind: "refused", status: 422 })
  })

  test("a retryable failure waits what GitHub asked: Retry-After, or the proxy's retry instant", () => {
    expect(classify(failure({ retryable: true, retryAfterMillis: 2_000 }))).toEqual({ kind: "retry", retryAfterMillis: 2_000 })
    expect(classify(failure({ retryable: true }))).toEqual({ kind: "retry" })
    const later = classify(failure({ rateLimited: true, retryAt: new Date(Date.now() + 60_000).toISOString() }))
    expect(later.kind === "retry" && later.retryAfterMillis).toBeGreaterThan(50_000)
    expect(classify(failure({ rateLimited: true, retryAt: new Date(Date.now() - 1_000).toISOString() }))).toEqual({
      kind: "retry",
    })
  })

  // Codex review of c4a86962: a proxy's far-future retry instant waits no longer than any header's wait, 60 s.
  test("the proxy's retry instant is capped as a header's wait is", () => {
    const far = classify(failure({ rateLimited: true, retryAt: new Date(Date.now() + 6 * 3_600_000).toISOString() }))
    expect(MAX_WAIT_MILLIS).toBe(60_000)
    expect(far).toEqual({ kind: "retry", retryAfterMillis: MAX_WAIT_MILLIS })
  })

  test("a failure without a status, or not GitHub's, is tried again", () => {
    expect(classify(failure({ retryable: false }))).toEqual({ kind: "retry" })
    expect(classify(new Error("a bug"))).toEqual({ kind: "retry" })
    expect(classify(new Core.IntegrationError.IntegrationError("decode-failed", "bad shape"))).toEqual({ kind: "retry" })
  })
})

describe("statusOf", () => {
  test("GitHub's status when it answered one", () => {
    expect(statusOf(failure({ status: 404 }))).toBe(404)
    expect(statusOf(failure({}))).toBeUndefined()
    expect(statusOf(new Error("a bug"))).toBeUndefined()
  })
})
