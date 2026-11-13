/** A sample is valid only while every following reader is still attached. */
import { Effect, Exit, type Fiber } from "effect"

export const requireActiveReaders = (readers: ReadonlyArray<Fiber.Fiber<void, unknown>>) =>
  Effect.gen(function*() {
    for (const reader of readers) {
      const exit = reader.pollUnsafe()
      if (exit === undefined) continue
      if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
      return yield* Effect.fail(new Error("Subscriber closed before memory sampling finished"))
    }
  })
