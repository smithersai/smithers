import { type Model, ModelError } from "@smthrs/model"
import { describe, expect, test } from "vitest"
import { final, finalFailure } from "./ModelRefusal.ts"

describe("terminal model refusals", () => {
  test.each(["quota_exceeded", "out_of_credit", "provider_internal", "rate_limited"] as const)("HTTP 402 %s is terminal even with cooldown hints", (code) => {
    const error = final(new ModelError.ModelError({
      code, message: "private detail", httpStatus: 402, retryAfterMillis: 60_000,
      resetAtEpochMillis: 90_000, quotaScope: "model",
    }))
    expect(error.code).toBe(code === "quota_exceeded" ? code : "out_of_credit")
    expect([error.retryAfterMillis, error.resetAtEpochMillis, error.quotaScope]).toEqual([undefined, undefined, undefined])
    expect(ModelError.isTerminalRefusal(error)).toBe(true)
  })

  test("a non-model failure passes unchanged", () => {
    const denied = { _tag: "PermissionDenied" } as unknown as Model.ModelFailure
    expect(finalFailure(denied)).toBe(denied)
  })
})
