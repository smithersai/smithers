import { RetryPolicy } from "@smthrs/flow"
import { ModelError } from "@smthrs/model"
import { expect, test } from "vitest"
import { MODEL_RETRY } from "./steps"

test("quota and credit end on attempt one, while plain rate limits retain durable backoff", () => {
  for (const code of ModelError.ModelErrorCode.literals) {
    const error = new ModelError.ModelError({ code, message: "private detail", retryAfterMillis: 60_000 })
    expect(RetryPolicy.isNonRetryable(MODEL_RETRY, error)).toBe(code === "quota_exceeded" || code === "out_of_credit")
  }
  const decision = RetryPolicy.decide(MODEL_RETRY, {
    attempt: 1, random: 0.5,
    error: new ModelError.ModelError({ code: "rate_limited", httpStatus: 429, message: "wait" }),
  })
  expect(decision).toMatchObject({ _tag: "RetryAfter" })
})
