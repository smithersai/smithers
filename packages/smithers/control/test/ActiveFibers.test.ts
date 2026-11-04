import { Effect, Fiber } from "effect"
import { describe, expect, it } from "vitest"
import * as ActiveFibers from "../src/internal/activeFibers.vibe"

describe("active fiber ownership", () => {
  it("returns to baseline after success, failure, and cancellation", async () => {
    const fibers = new Map<string, Fiber.Fiber<unknown, unknown>>()
    for (let index = 0; index < 1000; index++) {
      const fiber = Effect.runFork(index % 2 === 0 ? Effect.void : Effect.fail("expected failure"))
      ActiveFibers.register(fibers, String(index), fiber)
      await Effect.runPromise(Fiber.await(fiber))
    }
    const interrupted = Effect.runFork(Effect.never)
    ActiveFibers.register(fibers, "interrupted", interrupted)
    await Effect.runPromise(Fiber.interrupt(interrupted))
    expect(fibers.size).toBe(0)
  })

  it("keeps a replacement registered when its predecessor completes", async () => {
    const fibers = new Map<string, Fiber.Fiber<unknown, unknown>>()
    const old = Effect.runFork(Effect.never)
    const replacement = Effect.runFork(Effect.never)
    ActiveFibers.register(fibers, "run", old)
    ActiveFibers.register(fibers, "run", replacement)
    await Effect.runPromise(Fiber.interrupt(old))
    expect(fibers.get("run")).toBe(replacement)
    await Effect.runPromise(Fiber.interrupt(replacement))
    expect(fibers.size).toBe(0)
  })
})
