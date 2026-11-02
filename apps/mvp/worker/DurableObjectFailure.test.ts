// A Durable Object failure is described by a known class, Cloudflare's flags and a message category, never its text,
// and describing any thrown value never throws (worker/DurableObjectFailure.ts).
import { Cause, Effect, Fiber, Logger, Metric } from "effect"
import { TestClock } from "effect/testing"
import { describe as group, expect, test } from "vitest"
import { categoryOf, classOf, describe, failures, KNOWN_CLASSES, recorded } from "./DurableObjectFailure.ts"

/** What workerd rejects I/O with in an instance Cloudflare has replaced (smithers.sh, 2026-11-02 13:32:41Z). */
export const inactive = () =>
  Object.assign(
    new Error("Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request."),
    { retryable: true },
  )

/** Values a handler can throw that break naive property reads. */
export const hostileValues = (): ReadonlyArray<unknown> => [
  Object.create(null),
  new Proxy({}, {
    get: () => {
      throw new Error("getter")
    },
    getPrototypeOf: () => {
      throw new Error("prototype")
    },
  }),
  Object.defineProperty(new Error("x"), "message", {
    get: () => {
      throw new Error("message")
    },
  }),
  42,
  "text",
  undefined,
  null,
]

group("categoryOf", () => {
  test("names Cloudflare's Durable Object failures by a fixed category, never by their text", () => {
    expect(categoryOf(new Error("Network connection lost."))).toBe("connection-lost")
    expect(categoryOf(new Error("Durable Object reset because its code was updated."))).toBe("reset")
    expect(categoryOf(inactive())).toBe("instance-inactive")
    expect(categoryOf(new Error("Durable Object is overloaded. Requests queued for too long."))).toBe("overloaded")
    expect(categoryOf(new Error("Durable Object's isolate exceeded its memory limit and was reset."))).toBe("memory-limit")
    expect(categoryOf(new Error("Durable Object exceeded its CPU time limit and was reset."))).toBe("cpu-limit")
    expect(categoryOf(new Error("Durable Object storage operation exceeded timeout which caused object to be reset."))).toBe(
      "storage-timeout",
    )
    expect(categoryOf(new Error("internal error; reference = abc123"))).toBe("internal")
    expect(categoryOf(new Error("person@example.com"))).toBe("other")
    expect(categoryOf("Network connection lost.")).toBe("other")
  })
})

group("classOf", () => {
  test("names a known class or tag, and anything else, a tag built from content included, unknown", () => {
    expect(classOf(new TypeError("x"))).toBe("TypeError")
    expect(classOf({ _tag: "RpcCallError" })).toBe("RpcCallError")
    expect(classOf(Object.assign(new Error("x"), { _tag: "private-user@example.test" }))).toBe("unknown")
    expect(classOf(new (class PersonAlice extends Error {})("x"))).toBe("unknown")
    expect([...KNOWN_CLASSES].every((name) => /^[A-Za-z]+$/.test(name))).toBe(true)
  })
})

group("describe", () => {
  test("any thrown value is described without throwing", () => {
    // The Error whose message getter throws is still an Error; every other value has no known class.
    for (const [n, value] of hostileValues().entries()) {
      expect(describe(value)).toEqual({
        errorTag: n === 2 ? "Error" : "unknown",
        category: "other",
        retryable: false,
        overloaded: false,
        remote: false,
      })
    }
    expect(describe(inactive())).toEqual({
      errorTag: "Error",
      category: "instance-inactive",
      retryable: true,
      overloaded: false,
      remote: false,
    })
  })
})

type Line = ReturnType<typeof Logger.formatStructured.log>

const run = async <A, E>(effect: Effect.Effect<A, E>) => {
  const log: Array<Line> = []
  const exit = await Effect.runPromiseExit(effect.pipe(
    Effect.provide(TestClock.layer()),
    Effect.provideService(
      Logger.CurrentLoggers,
      new Set([Logger.make((options) => void log.push(Logger.formatStructured.log(options)))]),
    ),
  ))
  return { exit, log }
}

const counted = (attributes: { readonly [name: string]: string }) =>
  Effect.runSync(Metric.value(Metric.withAttributes(failures, attributes))).count

const alarm = recorded("FlowExecution", "alarm")

group("recorded", () => {
  test("a handler that dies is logged and counted once by class, flags and category, and dies with its own cause", async () => {
    const defect = inactive()
    const attributes = {
      object: "FlowExecution",
      handler: "alarm",
      errorClass: "Error",
      category: "instance-inactive",
      retryable: "true",
      overloaded: "false",
      remote: "false",
    }
    const before = counted(attributes)
    const { exit, log } = await run(alarm(Effect.andThen(TestClock.adjust("62000 millis"), Effect.die(defect))))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(Cause.squash(exit.cause)).toBe(defect)
    expect(log).toMatchObject([{
      message: "durable_object.handler.failed",
      level: "WARN",
      annotations: {
        object: "FlowExecution",
        handler: "alarm",
        errorTag: "Error",
        category: "instance-inactive",
        retryable: true,
        overloaded: false,
        remote: false,
        durationMs: 62_000,
      },
    }])
    expect(JSON.stringify(log)).not.toContain("Connection closed")
    expect(counted(attributes)).toBe(before + 1)
  })

  test("any thrown value keeps its own cause, with exactly one record and one count", async () => {
    for (const value of hostileValues()) {
      const attributes = {
        object: "FlowExecution",
        handler: "alarm",
        errorClass: "unknown",
        category: "other",
        retryable: "false",
        overloaded: "false",
        remote: "false",
      }
      const unknownBefore = counted(attributes)
      const errorBefore = counted({ ...attributes, errorClass: "Error" })
      const { exit, log } = await run(alarm(Effect.die(value)))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.squash(exit.cause)).toBe(value)
      expect(log).toHaveLength(1)
      expect(log[0]).toMatchObject({ message: "durable_object.handler.failed", level: "ERROR" })
      expect(counted(attributes) - unknownBefore + counted({ ...attributes, errorClass: "Error" }) - errorBefore).toBe(1)
    }
  })

  test("a tag built from content is labelled unknown in the log and the metric", async () => {
    const { log } = await run(alarm(Effect.die(Object.assign(new Error("x"), { _tag: "private-user@example.test" }))))
    expect(log).toMatchObject([{ annotations: { errorTag: "unknown" } }])
    const snapshot = Effect.runSync(Metric.snapshot).filter((each) => each.id === "durable_object_handler_failures")
    expect(JSON.stringify([log, snapshot])).not.toContain("example.test")
  })

  test("a handler interrupted from outside whose cleanup dies is one record and one count", async () => {
    const attributes = {
      object: "FlowExecution",
      handler: "cleanup",
      errorClass: "Error",
      category: "other",
      retryable: "false",
      overloaded: "false",
      remote: "false",
    }
    const before = counted(attributes)
    const { exit, log } = await run(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        recorded("FlowExecution", "cleanup")(Effect.never.pipe(Effect.ensuring(Effect.die(new Error("cleanup"))))),
      )
      yield* TestClock.adjust("3 seconds")
      yield* Fiber.interrupt(fiber)
    }))
    expect(exit._tag).toBe("Success")
    expect(log).toMatchObject([{
      message: "durable_object.handler.failed",
      level: "ERROR",
      annotations: { handler: "cleanup", errorTag: "Error", durationMs: 3_000 },
    }])
    expect(counted(attributes)).toBe(before + 1)
  })

  test("success and interruption record nothing", async () => {
    expect((await run(alarm(Effect.succeed(1)))).log).toEqual([])
    expect((await run(alarm(Effect.interrupt))).log).toEqual([])
    const outside = await run(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(alarm(Effect.never))
      yield* Fiber.interrupt(fiber)
    }))
    expect(outside.log).toEqual([])
  })
})
