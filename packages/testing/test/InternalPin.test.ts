/**
 * Failure construction and bounded waiting for the internal pin vocabulary.
 *
 * A conformance helper must preserve its stable code and typed observations,
 * and a predicate that never settles must fail at the documented bound rather
 * than hanging the suite.
 */
import { Effect } from "effect"
import * as Pin from "../src/internal/Pin.vibe"
import { describe, expect, it } from "../src/Vitest.vibe"

describe("internal pin assertions", () => {
  it.effect("reports assertion failures with and without observations", () =>
    Effect.gen(function*() {
      const observed = yield* Pin.assert("identity/example", false, "values differ", { value: 1 }, { value: 2 }).pipe(
        Effect.flip
      )
      expect(observed).toMatchObject({
        code: "conformance_violation",
        pin: "identity/example",
        message: "values differ",
        expected: { value: 1 },
        actual: { value: 2 }
      })

      const bare = yield* Pin.fail("identity/example", "bare failure").pipe(Effect.flip)
      expect(bare.code).toBe("conformance_violation")
      expect(bare.expected).toBeUndefined()
      expect(bare.actual).toBeUndefined()
    }))

  it.effect("fails typed when the bounded wait is exhausted", () =>
    Effect.gen(function*() {
      const error = yield* Pin.waitUntil("race/example", () => false, "the race stayed pending").pipe(Effect.flip)
      expect(error).toMatchObject({
        code: "conformance_violation",
        pin: "race/example",
        message: "the race stayed pending",
        expected: "settlement within one second of live time",
        actual: "still pending"
      })
    }))

  it.effect("returns the first value observed by a bounded poll", () =>
    Effect.gen(function*() {
      let attempts = 0
      const value = yield* Pin.pollUntil(
        "race/example",
        () => ++attempts === 3 ? "settled" : undefined,
        "the value stayed pending"
      )

      expect(value).toBe("settled")
      expect(attempts).toBe(3)
    }))
})
