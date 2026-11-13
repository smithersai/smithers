import { Effect, Layer, Result } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Budget from "../src/Budget.ts"

describe("budget configuration", () => {
  const invalid = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]
  for (const value of invalid) {
    it(`rejects an invalid token ceiling (${value}) during construction`, async () => {
      const result = await Effect.runPromise(Effect.result(Budget.make({ tokens: { max: value } })))
      expect(Result.isFailure(result)).toBe(true)
    })
    it(`rejects an invalid latency ceiling (${value}) during layer acquisition`, async () => {
      const result = await Effect.runPromise(Effect.result(Effect.scoped(
        Layer.build(Budget.layer({ latency: { maxMillis: value } }))
      )))
      expect(Result.isFailure(result)).toBe(true)
    })
  }

  for (const field of ["maxRuns", "recoveryEntries"] as const) {
    for (const value of [...invalid, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      it(`rejects ${field}=${value} instead of silently clamping or disabling its bound`, async () => {
        const result = await Effect.runPromise(Effect.result(Budget.make({}, { [field]: value })))
        expect(Result.isFailure(result)).toBe(true)
      })
    }
  }

  for (const value of [0.5, Number.MAX_SAFE_INTEGER + 1]) {
    it(`requires token counts to be safe integers (${value})`, async () => {
      const result = await Effect.runPromise(Effect.result(Budget.make({ tokens: { max: value } })))
      expect(Result.isFailure(result)).toBe(true)
    })
  }

  for (const field of ["tokens", "latency"] as const) {
    it(`rejects an unknown ${field} exceeded policy from a JavaScript caller`, async () => {
      const policy = (field === "tokens"
        ? { tokens: { max: 1, onExceeded: "ignore" } }
        : { latency: { maxMillis: 1, onExceeded: "ignore" } }) as unknown as Budget.Policy
      const result = await Effect.runPromise(Effect.result(Budget.make(policy)))
      expect(Result.isFailure(result)).toBe(true)
    })
  }

  for (const scope of ["tokens", "latency", "usd"] as const) {
    for (const method of ["check", "reserve", "admitReading"] as const) {
      for (const onExceeded of ["fail", "skip-remaining", "warn"] as const) {
        it(`enforces a zero ${scope} ceiling for ${method} with ${onExceeded}`, async () => {
          await Effect.runPromise(
            Effect.gen(function*() {
              const policy: Budget.Policy = scope === "latency"
                ? { latency: { maxMillis: 0, onExceeded } }
                : scope === "tokens"
                ? { tokens: { max: 0, onExceeded } }
                : { usd: { max: 0, onExceeded } }
              const budget = yield* Budget.make(policy)
              const verdict = yield* Effect.scoped(budget[method]("first"))
              expect(verdict).toMatchObject({
                _tag: onExceeded === "warn" ? "warn" : "refuse",
                exceeded: { scope, max: 0, used: 0, onExceeded }
              })
            }).pipe(Effect.provide(TestClock.layer()))
          )
        })
      }
    }
  }

  it("accepts fractional milliseconds and an empty reporting policy", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      yield* Budget.make({ latency: { maxMillis: 0.5 } }, { maxRuns: 1, recoveryEntries: 1 })
      const reporting = yield* Budget.make({})
      expect((yield* Effect.scoped(reporting.reserve("first")))._tag).toBe("proceed")
    }))
  })

  it("captures validated policy values instead of retaining mutable caller objects", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const policy = { tokens: { max: 1_000, onExceeded: "fail" as Budget.OnExceeded } }
      const budget = yield* Budget.make(policy)
      policy.tokens.max = Number.NaN
      policy.tokens.onExceeded = "warn"
      yield* budget.record("paid", { totalTokens: 600 })
      expect((yield* Effect.scoped(budget.reserve("next")))._tag).toBe("refuse")
    }))
  })

  it("reports a typed, actionable configuration error", async () => {
    const result = await Effect.runPromise(Effect.result(Budget.make({}, { maxRuns: 0 })))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(Budget.ConfigurationError)
      expect(result.failure.message).toContain("maxRuns")
    }
  })

  it("rejects misspelled fields instead of silently removing the intended ceiling", async () => {
    for (const policy of [{ token: { max: 10 } }, { tokens: { max: 10, onExceed: "fail" } }]) {
      const result = await Effect.runPromise(Effect.result(Budget.make(policy as Budget.Policy)))
      expect(Result.isFailure(result)).toBe(true)
    }
    const result = await Effect.runPromise(Effect.result(Budget.make({}, { maxRun: 1 } as Budget.Options)))
    expect(Result.isFailure(result)).toBe(true)
  })
})
