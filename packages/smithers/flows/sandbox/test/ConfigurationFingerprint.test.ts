import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { configurationFingerprint } from "../src/internal/configurationFingerprint.vibe"

describe("configurationFingerprint", () => {
  it.effect("compares configuration values independently of object insertion order", () =>
    Effect.gen(function*() {
      const first = yield* configurationFingerprint({
        owner: "one",
        env: { A: "a", B: "b" },
        args: ["x", "y"],
        empty: null
      })
      const second = yield* configurationFingerprint({
        empty: null,
        args: ["x", "y"],
        env: { B: "b", A: "a" },
        owner: "one"
      })
      expect(first).toBe(second)
      expect(first).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,61}[A-Za-z0-9]$/)
      for (
        const configuration of [
          { owner: "two", env: { A: "a", B: "b" }, args: ["x", "y"], empty: null },
          { owner: "one", env: { A: "changed", B: "b" }, args: ["x", "y"], empty: null },
          { owner: "one", env: { A: "a", B: "b" }, args: ["y", "x"], empty: null }
        ]
      ) expect(yield* configurationFingerprint(configuration)).not.toBe(first)
    }))

  it.effect("fails closed when the configuration cannot be serialized", () =>
    Effect.gen(function*() {
      expect(yield* Effect.flip(configurationFingerprint({ invalid: 1n }))).toMatchObject({ code: "unavailable" })
    }))
})
