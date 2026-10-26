// The Electric gateway answers an overloaded Durable Object 503 with retry-after and records every request it relays
// (infra/ElectricRelay.ts), over calls that answer, or fail the way Cloudflare's runtime fails a call into the object.
import { Effect, Logger } from "effect"
import { HttpServerResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "vitest"
import { isOverloaded, relay, RETRY_AFTER_SECONDS } from "./ElectricRelay.ts"

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

/** A call into the object that takes `ms` of the test clock, then dies with `defect`, as a rejected stub fetch does. */
const dying = (ms: number, defect: unknown) => Effect.andThen(TestClock.adjust(`${ms} millis`), Effect.die(defect))

describe("relay", () => {
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

  test("any other failure fails the request as before, recorded as failed with its tag and never its message", async () => {
    class RpcCallError extends Error {
      readonly _tag = "RpcCallError"
    }
    for (const [call, tag] of [
      [dying(10, new TypeError("Network connection lost to 10.0.0.1")), "TypeError"],
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
