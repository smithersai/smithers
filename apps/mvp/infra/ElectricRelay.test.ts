// The Electric gateway answers an overloaded Durable Object 503 with retry-after and records every request it relays
// (infra/ElectricRelay.ts), over calls that answer, or fail the way Cloudflare's runtime fails a call into the object.
import { Cause, Effect, Fiber, Logger, Metric } from "effect"
import { HttpServerResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "vitest"
import { failures, isOverloaded, isTransient, relay, RETRY_AFTER_SECONDS } from "./ElectricRelay.ts"

type Record = ReturnType<typeof Logger.formatStructured.log>

/** Runs `effect` on the test clock, collecting its log lines. */
const run = async <A, E>(effect: Effect.Effect<A, E>) => {
  const log: Array<Record> = []
  const exit = await Effect.runPromiseExit(effect.pipe(
    Effect.provide(TestClock.layer()),
    Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((options) => void log.push(Logger.formatStructured.log(options)))])),
  ))
  return { exit, log }
}

/** The error workerd rejects a call into an overloaded Durable Object with. */
const overloaded = () =>
  Object.assign(new Error("Durable Object is overloaded. Requests queued for too long."), { overloaded: true, retryable: false })

/**
 * The error workerd rejects a call into the object with when its connection to the object drops mid-call, as when the
 * object's host restarts or moves it; Cloudflare marks it `retryable` (Durable Objects: Error handling).
 */
const lost = () => Object.assign(new Error("Network connection lost."), { retryable: true })

/** A call into the object that takes `ms` of the test clock, then dies with `defect`, as a rejected stub fetch does. */
const dying = (ms: number, defect: unknown) => Effect.andThen(TestClock.adjust(`${ms} millis`), Effect.die(defect))

describe("relay", () => {
  test("every transport outcome carries a validated proxy correlation without request content", async () => {
    const correlationId = "0123456789abcdef"
    for (const call of [
      Effect.succeed(HttpServerResponse.empty({ status: 503 })),
      dying(1, overloaded()),
      dying(1, new TypeError("private-detail")),
    ]) {
      const { log } = await run(relay(call, false, correlationId))
      expect(log).toHaveLength(1)
      expect(log[0]!.annotations.correlationId).toBe(correlationId)
      expect(JSON.stringify(log)).not.toContain("private-detail")
    }
    for (const invalid of [undefined, "private-customer-content", "0123456789abcdef-private", "0123456789ABCDEF"]) {
      const { log } = await run(relay(Effect.succeed(HttpServerResponse.empty()), false, invalid))
      expect(log[0]!.annotations.correlationId).toBe("unavailable")
      expect(JSON.stringify(log)).not.toContain("private-customer-content")
    }
  })

  test("the object's answer is the gateway's, recorded with its status, liveness and duration", async () => {
    const answer = HttpServerResponse.text("[]", { status: 200 })
    const { exit, log } = await run(relay(Effect.andThen(TestClock.adjust("20000 millis"), Effect.succeed(answer)), true))
    expect(exit).toMatchObject({ _tag: "Success", value: answer })
    expect(log).toMatchObject([{
      message: "electric.gateway.request",
      level: "INFO",
      annotations: { live: true, status: 200, outcome: "answered", durationMs: 20_000 },
    }])
  })

  test("an overloaded object is answered 503 with retry-after and no-store, and recorded as overloaded", async () => {
    const { exit, log } = await run(relay(dying(4_000, overloaded()), false))
    expect(exit._tag).toBe("Success")
    const response = exit._tag === "Success" ? exit.value : undefined
    expect(response?.status).toBe(503)
    expect(response?.headers).toMatchObject({ "retry-after": String(RETRY_AFTER_SECONDS), "cache-control": "no-store" })
    expect(log).toMatchObject([{
      message: "electric.gateway.request",
      level: "WARN",
      annotations: { live: false, status: 503, outcome: "overloaded", durationMs: 4_000, errorTag: "Error" },
    }])
    expect(JSON.stringify(log)).not.toContain("queued")
  })

  test("a call Cloudflare marks retryable is answered 503 with retry-after and no-store, and recorded as transient", async () => {
    // smithers.sh, 2026-11-02 10:00:07Z: 17 held live shape requests from two colos ended at once, the object recording
    // each as `clientDisconnected` and ChatApi each gateway answer as a 500; 12:49:58Z and 13:35:11Z did the same to 1
    // and 2 (docs/infrastructure.md#electric).
    const { exit, log } = await run(relay(dying(3_000, lost()), true, "0123456789abcdef"))
    expect(exit._tag).toBe("Success")
    const response = exit._tag === "Success" ? exit.value : undefined
    expect(response?.status).toBe(503)
    expect(response?.headers).toMatchObject({ "retry-after": String(RETRY_AFTER_SECONDS), "cache-control": "no-store" })
    expect(log).toMatchObject([{
      message: "electric.gateway.request",
      level: "WARN",
      annotations: { live: true, status: 503, outcome: "transient", durationMs: 3_000, errorTag: "Error" },
    }])
    expect(JSON.stringify(log)).not.toContain("connection lost")
  })

  test("any other failure fails the request as before, recorded as failed with its tag and never its message", async () => {
    class RpcCallError extends Error {
      readonly _tag = "RpcCallError"
    }
    for (const [call, tag] of [
      [dying(10, new TypeError("Network connection lost to 10.0.0.1")), "TypeError"],
      [dying(10, Object.assign(new Error("10.0.0.1"), { retryable: false })), "Error"],
      [Effect.fail(new RpcCallError("fetch 10.0.0.1")), "RpcCallError"],
    ] as const) {
      const { exit, log } = await run(relay(call, true))
      expect(exit._tag).toBe("Failure")
      expect(log).toMatchObject([{
        message: "electric.gateway.request",
        level: "ERROR",
        annotations: { live: true, status: 500, outcome: "failed", errorTag: tag },
      }])
      expect(JSON.stringify(log)).not.toContain("10.0.0.1")
    }
  })
})

describe("isOverloaded", () => {
  test("only an error Cloudflare marks overloaded counts, never one that merely says so", () => {
    expect(isOverloaded(overloaded())).toBe(true)
    expect(isOverloaded(new Error("Durable Object is overloaded. Requests queued for too long."))).toBe(false)
    expect(isOverloaded(Object.assign(new Error("reset"), { overloaded: false, retryable: true }))).toBe(false)
    expect(isOverloaded("overloaded")).toBe(false)
    expect(isOverloaded(null)).toBe(false)
  })
})

describe("isTransient", () => {
  test("only an error Cloudflare marks retryable and not overloaded counts, never one that merely says so", () => {
    expect(isTransient(lost())).toBe(true)
    expect(isTransient(Object.assign(new Error("reset"), { overloaded: false, retryable: true }))).toBe(true)
    expect(isTransient(overloaded())).toBe(false)
    expect(isTransient(Object.assign(new Error("x"), { overloaded: true, retryable: true }))).toBe(false)
    expect(isTransient(new Error("Network connection lost."))).toBe(false)
    expect(isTransient(Object.assign(new Error("x"), { retryable: "true" }))).toBe(false)
    expect(isTransient("retryable")).toBe(false)
    expect(isTransient(null)).toBe(false)
  })
})

describe("the failure record", () => {
  /** How many failures `failures` has counted with these attributes. */
  const counted = (attributes: { readonly [name: string]: string }) =>
    Effect.runSync(Metric.value(Metric.withAttributes(failures, attributes))).count

  test("each failed call is one record and one count: class, flags, message category, elapsed time and shape", async () => {
    const reset = Object.assign(new Error("Durable Object reset because its code was updated."), { retryable: true })
    const remote = Object.assign(new Error("secret-detail thrown by the object's own code"), { remote: true })
    for (const [defect, outcome, category, retryable, isOverloadedFlag, isRemote, status] of [
      [lost(), "transient", "connection-lost", true, false, false, 503],
      [reset, "transient", "reset", true, false, false, 503],
      [overloaded(), "overloaded", "overloaded", false, true, false, 503],
      [remote, "failed", "other", false, false, true, 500],
      [new TypeError("secret-detail 10.0.0.1"), "failed", "other", false, false, false, 500],
    ] as const) {
      const attributes = {
        outcome,
        errorClass: defect.constructor.name,
        category,
        retryable: String(retryable),
        overloaded: String(isOverloadedFlag),
        remote: String(isRemote),
        table: "views",
      }
      const before = counted(attributes)
      const { log } = await run(relay(dying(2_500, defect), true, "0123456789abcdef", "views"))
      expect(log).toMatchObject([{
        message: "electric.gateway.request",
        annotations: { status, outcome, durationMs: 2_500, errorTag: defect.constructor.name, category, retryable, overloaded: isOverloadedFlag, remote: isRemote, table: "views" },
      }])
      expect(counted(attributes)).toBe(before + 1)
      expect(JSON.stringify(log)).not.toMatch(/secret-detail|10\.0\.0\.1|code was updated|connection lost/)
    }
  })

  test("a call its own caller abandoned is recorded aborted, not failed, and counts no failure", async () => {
    const { exit, log } = await run(relay(Effect.andThen(TestClock.adjust("700 millis"), Effect.interrupt), true, undefined, "views"))
    expect(exit._tag).toBe("Failure")
    expect(log).toMatchObject([{ level: "INFO", annotations: { status: 499, outcome: "aborted", durationMs: 700, table: "views" } }])
  })

  test("a caller that abandons the call from outside is recorded aborted once, with how long it waited", async () => {
    const { exit, log } = await run(Effect.gen(function* () {
      const relayed = yield* Effect.forkChild(relay(Effect.andThen(Effect.sleep("20 seconds"), Effect.succeed(HttpServerResponse.empty())), true, undefined, "views"))
      yield* TestClock.adjust("1500 millis")
      yield* Fiber.interrupt(relayed)
    }))
    expect(exit._tag).toBe("Success")
    expect(log).toMatchObject([{ level: "INFO", annotations: { status: 499, outcome: "aborted", durationMs: 1_500, table: "views" } }])
  })

  test("a caller's interruption whose cleanup dies is one failed record and one count, not silence", async () => {
    const defect = Object.assign(new Error("cleanup"), { retryable: false })
    const attributes = {
      outcome: "failed", errorClass: "Error", category: "other", retryable: "false", overloaded: "false", remote: "false",
      table: "cleanup",
    }
    const before = counted(attributes)
    const { exit, log } = await run(Effect.gen(function* () {
      const relayed = yield* Effect.forkChild(relay(Effect.never.pipe(Effect.ensuring(Effect.die(defect))), true, undefined, "cleanup"))
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.interrupt(relayed)
    }))
    expect(exit._tag).toBe("Success")
    expect(log).toMatchObject([{ level: "ERROR", annotations: { status: 500, outcome: "failed", durationMs: 2_000, table: "cleanup" } }])
    expect(counted(attributes)).toBe(before + 1)
  })

  test("a cause that failed and was interrupted is the failure's record, not a cancellation", async () => {
    for (const [defect, outcome, status] of [[lost(), "transient", 503], [new TypeError("x"), "failed", 500]] as const) {
      const { log } = await run(relay(Effect.failCause(Cause.combine(Cause.die(defect), Cause.interrupt())), true, undefined, "views"))
      expect(log).toMatchObject([{ annotations: { outcome, status } }])
    }
  })

  test("a class label is a known class or unknown, never a tag built from content, in the log and the metric", async () => {
    const tagged = Object.assign(new Error("x"), { _tag: "private-user@example.test", retryable: true })
    const attributes = {
      outcome: "transient", errorClass: "unknown", category: "other", retryable: "true", overloaded: "false", remote: "false",
      table: "views",
    }
    const before = counted(attributes)
    const { log } = await run(relay(dying(10, tagged), true, undefined, "views"))
    expect(log).toMatchObject([{ annotations: { errorTag: "unknown", outcome: "transient" } }])
    expect(JSON.stringify(log)).not.toContain("example.test")
    expect(counted(attributes)).toBe(before + 1)
    const labels = Effect.runSync(Metric.snapshot).filter((each) => each.id === "electric_gateway_failures")
    expect(JSON.stringify(labels)).not.toContain("example.test")
  })

  test("any thrown value is described without throwing, and the call fails with its own cause", async () => {
    const hostile = new Proxy({}, { get: () => { throw new Error("getter") }, getPrototypeOf: () => { throw new Error("proto") } })
    for (const defect of [Object.create(null), hostile, 42, "text", undefined]) {
      const { exit, log } = await run(relay(dying(10, defect), false, undefined, "views"))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.squash(exit.cause)).toBe(defect)
      expect(log).toMatchObject([{ annotations: { outcome: "failed", status: 500, errorTag: "unknown", category: "other" } }])
    }
  })

  test("an answered call keeps its record and counts no failure", async () => {
    const { log } = await run(relay(Effect.succeed(HttpServerResponse.empty({ status: 200 })), false, undefined, "views"))
    expect(log).toMatchObject([{ annotations: { outcome: "answered", table: "views" } }])
    expect(log[0]!.annotations).not.toHaveProperty("category")
  })
})
