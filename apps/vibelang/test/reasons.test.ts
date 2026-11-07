import { ModelError } from "@smthrs/model"
import { describe, expect, test } from "vitest"
import { REASONS, reasonOf } from "../worker/Reply.vibe"

const failure = (code: ModelError.ModelError["code"]) =>
  new ModelError.ModelError({ code, message: "a provider's own words, which a person never reads" })

describe("the reason a person reads for a provider error", () => {
  test("a provider out of credit or over its quota is the provider's billing, not the deployment's daily budget", () => {
    // Production, 2026-11-07: Cerebras answered 402 payment_required and every reply read "daily budget is spent".
    expect(reasonOf(failure("out_of_credit"))).toBe(REASONS.credit)
    expect(reasonOf(failure("quota_exceeded"))).toBe(REASONS.credit)
    expect(REASONS.credit).not.toBe(REASONS.budget)
  })

  test("a refusal reads as a refusal and anything else as the model being unavailable", () => {
    expect(reasonOf(failure("content_policy"))).toBe(REASONS.refused)
    expect(reasonOf(failure("rate_limited"))).toBe(REASONS.unavailable)
  })
})
