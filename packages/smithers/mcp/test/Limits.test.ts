import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Limits from "../src/internal/Limits.ts"

describe("Limits", () => {
  it.each([1, 64, Number.MAX_SAFE_INTEGER])("accepts the positive safe integer %s", (value) => {
    expect(Limits.isPositiveInteger(value)).toBe(true)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects %s",
    (value) => {
      expect(Limits.isPositiveInteger(value)).toBe(false)
    }
  )

  it("succeeds when every entry is a positive safe integer", async () => {
    await expect(
      Effect.runPromise(Limits.checkPositiveIntegers("fixture", [["a", 1], ["b", 2]]))
    ).resolves.toBeUndefined()
  })

  it("names the first invalid entry in declaration order", async () => {
    const error = await Effect.runPromise(
      Effect.flip(Limits.checkPositiveIntegers("fixture", [["a", 1], ["b", 0], ["c", -1]]))
    )

    expect(error).toMatchObject({
      code: "protocol_error",
      server: "fixture",
      message: `MCP option "b" must be a positive integer`
    })
  })
})
