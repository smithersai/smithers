/**
 * Canonicalization failures cross the RPC boundary as `InvalidInput`. The
 * stable path and reason are useful to an operator; the rejected value is not.
 */
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { InvalidInput } from "../src/ControlError.vibe"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import { durable } from "./DurableStack.ts"
import { memoryRuntime } from "./TestStack.ts"

const marker = "SECRET-MARKER-".repeat(80_000)

const rejectedInput = () => ({
  payload: {
    get rejected(): never {
      throw new Error(marker)
    }
  }
})

const attempt = Effect.gen(function*() {
  const runtime = yield* ControlRuntime
  return yield* Effect.flip(runtime.plan({ flowId: "system/test", input: rejectedInput() }))
})

const assertSanitized = (error: unknown): void => {
  expect(error).toBeInstanceOf(InvalidInput)
  const issue = (error as InvalidInput).issue
  expect(issue).not.toContain("SECRET-MARKER-")
  expect(issue.length).toBeLessThanOrEqual(512)
  expect(issue).toContain("$.input.payload.rejected")
}

describe("canonical input failure rendering", () => {
  it("sanitizes a rejected value in the memory runtime", async () => {
    const error = await Effect.runPromise(
      attempt.pipe(Effect.provide(memoryRuntime()), Effect.scoped, Effect.orDie)
    )

    assertSanitized(error)
  })

  it("sanitizes a rejected value in the SQL runtime", async () => {
    const error = await Effect.runPromise(
      attempt.pipe(Effect.provide(durable()), Effect.scoped, Effect.orDie)
    )

    assertSanitized(error)
  })
})
