/** One real contender, with a refresh that remains blocked until cancellation. */
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import * as CodexLogin from "../../src/internal/CodexLogin.ts"

const [file] = process.argv.slice(2)
if (file === undefined) throw new Error("expected login file")
const command = Effect.callback<"advance" | "release">((resume) => {
  const received = (value: unknown) => {
    if (value === "advance" || value === "release") {
      process.off("message", received)
      resume(Effect.succeed(value))
    }
  }
  process.on("message", received)
  return Effect.sync(() => {
    process.off("message", received)
  })
})

process.on("message", (message) => {
  if (message !== "begin") return
  void Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      yield* TestClock.setTime(600_000)
      let active = false
      const refresh = Effect.gen(function*() {
        active = true
        return yield* Effect.never
      })
      const fiber = yield* Effect.forkChild(CodexLogin.make({ file, refresh }).auth.sign({}), {
        startImmediately: true
      })
      yield* Effect.yieldNow
      for (;;) {
        process.send!({ active })
        if ((yield* command) === "release") break
        yield* TestClock.adjust("25 millis")
      }
      const cancelled = yield* Effect.forkChild(Fiber.interrupt(fiber), { startImmediately: true })
      yield* TestClock.adjust("61 seconds")
      yield* Fiber.join(cancelled)
      process.send!({ done: true })
    })).pipe(Effect.provide(TestClock.layer()))
  ).catch(() => process.exit(1))
})
process.send!({ ready: true })
