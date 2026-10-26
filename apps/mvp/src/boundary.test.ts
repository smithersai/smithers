import { Data, Effect, Fiber, Logger, References } from "effect"
import { describe, expect, it } from "vitest"
import { runners } from "./boundary"

class Refused extends Data.TaggedError("Refused")<{}> {}

/** Runners over an empty context whose logger records every line's message, level and annotations. */
const recording = () => {
  const lines: Array<{ readonly message: unknown; readonly level: string; readonly annotations: unknown }> = []
  const logger = Logger.make(({ message, logLevel, fiber }) =>
    void lines.push({
      message: (message as ReadonlyArray<unknown>)[0],
      level: logLevel,
      annotations: fiber.getRef(References.CurrentLogAnnotations),
    })
  )
  const context = Effect.runSync(Effect.context<never>().pipe(Effect.provide(Logger.layer([logger]))))
  return { lines, run: runners(context, "chat") }
}

describe("runners", () => {
  it("returns what each runner's Effect gives, and logs nothing for it", async () => {
    const { lines, run } = recording()
    expect(run.runSync(Effect.succeed(1))).toBe(1)
    await expect(run.runPromise(Effect.succeed(2))).resolves.toBe(2)
    expect(await Effect.runPromise(Fiber.join(run.runFork(Effect.succeed(3))))).toBe(3)
    expect(lines).toEqual([])
  })

  it("logs a defect at every boundary by the feature and the defect's name, never its message", async () => {
    const { lines, run } = recording()
    expect(() => run.runSync(Effect.die(new TypeError("someone's words")))).toThrow()
    await expect(run.runPromise(Effect.die(new RangeError("someone's words")))).rejects.toBeDefined()
    await Effect.runPromise(Fiber.await(run.runFork(Effect.die(new SyntaxError("someone's words")))))
    expect(lines).toEqual([
      { message: "app.unhandled", level: "Error", annotations: { feature: "chat", boundary: "sync", kind: "defect", "error.type": "TypeError" } },
      { message: "app.unhandled", level: "Error", annotations: { feature: "chat", boundary: "promise", kind: "defect", "error.type": "RangeError" } },
      { message: "app.unhandled", level: "Error", annotations: { feature: "chat", boundary: "fork", kind: "defect", "error.type": "SyntaxError" } },
    ])
    expect(JSON.stringify(lines)).not.toContain("someone's words")
  })

  it("passes the run's options: a signal that aborts interrupts the promise, and its interruption isn't logged", async () => {
    const { lines, run } = recording()
    const controller = new AbortController()
    const waiting = run.runPromise(Effect.never, { signal: controller.signal })
    controller.abort()
    await expect(waiting).rejects.toBeDefined()
    const forked = run.runFork(Effect.never, { signal: AbortSignal.abort() })
    await Effect.runPromise(Fiber.await(forked))
    expect(lines).toEqual([])
  })

  it("logs a forked Effect's failure, which nobody awaits, but leaves a sync or promise failure to its caller", async () => {
    const { lines, run } = recording()
    expect(() => run.runSync(Effect.fail(new Refused()))).toThrow()
    await expect(run.runPromise(Effect.fail(new Refused()))).rejects.toBeDefined()
    await Effect.runPromise(Fiber.await(run.runFork(Effect.fail(new Refused()))))
    await Effect.runPromise(Fiber.await(run.runFork(Effect.interrupt)))
    expect(lines).toEqual([
      { message: "app.unhandled", level: "Error", annotations: { feature: "chat", boundary: "fork", kind: "failure", "error.type": "Refused" } },
    ])
  })
})
