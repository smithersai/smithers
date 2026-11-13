import { Effect, Fiber, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { requireActiveReaders } from "./subscriberActivity.ts"

describe("subscriber activity during sampling", () => {
  it.each([false, true])(
    "refuses a reader that delivered the entire workload then ended, failure=%s",
    async (failed) => {
      let seen = 0
      const history = Stream.fromIterable(Array.from({ length: 500 }, (_, index) => index))
        .pipe(Stream.tap(() =>
          Effect.sync(() => {
            seen += 1
          })
        ))
      const stream = failed ? Stream.concat(history, Stream.fail(new Error("stream failed after signal 500"))) : history
      await Effect.runPromise(Effect.gen(function*() {
        const reader = yield* Effect.forkChild(Stream.runDrain(stream))
        yield* Fiber.await(reader)
        expect(seen).toBe(500)
        const error = yield* Effect.flip(requireActiveReaders([reader]))
        expect(String(error)).toContain(failed ? "stream failed" : "Subscriber closed")
      }))
    }
  )

  it("keeps live readers attached for every sample and rejects them after interruption", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const readers = yield* Effect.forEach([0, 1, 2, 3, 4], () => Effect.forkChild(Effect.never))
      for (let sample = 0; sample < 4; sample++) yield* requireActiveReaders(readers)
      yield* Effect.forEach(readers, Fiber.interrupt)
      expect((yield* Effect.exit(requireActiveReaders(readers)))._tag).toBe("Failure")
    }))
  })
})
