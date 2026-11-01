// Electric's container stays running between visits, and each request the gateway's object forwards is recorded
// (infra/ElectricAwake.ts), over a host that records the object's calls to the container in order.
import { Deferred, Effect, Fiber, Logger, Metric } from "effect"
import { HttpServerResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "vitest"
import {
  directOr,
  forward,
  type Host,
  isLive,
  logged,
  makeAwake,
  makeInFlight,
  RETRY_AFTER_SECONDS,
  serveObject,
  type Woken,
} from "./ElectricAwake.ts"

/** Cloudflare's bound on `setInactivityTimeout`: greater than 0 and at most 6 hours, or the call rejects. */
const PLATFORM_MAX_MS = 21_600_000

/** A container that is `running` or not, recording each call the object makes to it. */
const host = (running = true) => {
  const calls: Array<string> = []
  const state = { running }
  const self: Host = {
    running: Effect.sync(() => state.running),
    start: Effect.sync(() => {
      calls.push("start")
      state.running = true
    }),
    setInactivityTimeout: (ms) => Effect.sync(() => void calls.push(`hold ${ms}`)),
  }
  return { calls, state, self }
}

type Record = ReturnType<typeof Logger.formatStructured.log>

/** `effect` with its log lines collected into `log`. */
const collecting = <A, E>(effect: Effect.Effect<A, E>, log: Array<Record>) =>
  effect.pipe(
    Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((options) => void log.push(Logger.formatStructured.log(options)))])),
  )

/** Runs `effect` synchronously, collecting its log lines. */
const runLogged = <A, E>(effect: Effect.Effect<A, E>) => {
  const log: Array<Record> = []
  return { exit: Effect.runSyncExit(collecting(effect, log)), log }
}

describe("makeAwake", () => {
  test("a running container is held on the object's first request only, not on every request", () => {
    const { calls, self } = host()
    const wake = makeAwake(self)
    const woken = Effect.runSync(Effect.all([wake, wake, wake]))
    expect(calls).toEqual([`hold ${PLATFORM_MAX_MS}`])
    expect(woken).toEqual([{ started: false, held: true }, { started: false, held: false }, { started: false, held: false }])
  })

  test("a stopped container is started, then held through the longest idle time Cloudflare allows", () => {
    const { calls, self } = host(false)
    expect(Effect.runSync(makeAwake(self))).toEqual({ started: true, held: true })
    expect(calls).toEqual(["start", `hold ${PLATFORM_MAX_MS}`])
  })

  test("a container that stopped after it was held is started and held again", () => {
    const { calls, state, self } = host()
    const wake = makeAwake(self)
    Effect.runSync(wake)
    state.running = false
    expect(Effect.runSync(wake)).toEqual({ started: true, held: true })
    Effect.runSync(wake)
    expect(calls).toEqual([`hold ${PLATFORM_MAX_MS}`, "start", `hold ${PLATFORM_MAX_MS}`])
  })

  test("a new object instance holds again, since a restarted object starts without a timeout", () => {
    const { calls, self } = host()
    Effect.runSync(makeAwake(self))
    Effect.runSync(makeAwake(self))
    expect(calls).toEqual([`hold ${PLATFORM_MAX_MS}`, `hold ${PLATFORM_MAX_MS}`])
  })

  test("a hold Cloudflare refuses is logged, lets the request through, and is tried again on the next request", () => {
    const { calls, self } = host()
    let refusals = 1
    const refusing: Host = {
      ...self,
      setInactivityTimeout: (ms) =>
        refusals-- > 0 ? Effect.fail(new TypeError("timeout out of range")) : self.setInactivityTimeout(ms),
    }
    const wake = makeAwake(refusing)
    const first = runLogged(wake)
    expect(first.exit).toMatchObject({ _tag: "Success", value: { started: false, held: false } })
    expect(first.log).toMatchObject([{ message: "electric.hold", level: "WARN", annotations: { error: "TypeError: timeout out of range" } }])
    expect(Effect.runSync(wake)).toEqual({ started: false, held: true })
    expect(calls).toEqual([`hold ${PLATFORM_MAX_MS}`])
  })

  test("a container that fails to start isn't held, the request fails, and the next request starts it", () => {
    const { calls, self } = host(false)
    let failures = 1
    const failing: Host = { ...self, start: Effect.suspend(() => failures-- > 0 ? Effect.fail(new Error("no container instance")) : self.start) }
    const wake = makeAwake(failing)
    expect(Effect.runSyncExit(wake)._tag).toBe("Failure")
    expect(calls).toEqual([])
    expect(Effect.runSync(wake)).toEqual({ started: true, held: true })
    expect(calls).toEqual(["start", `hold ${PLATFORM_MAX_MS}`])
  })

  test("requests that arrive while the first hold is in flight don't hold again", async () => {
    const { calls, self } = host()
    const released = Effect.runSync(Deferred.make<void>())
    const slow: Host = { ...self, setInactivityTimeout: (ms) => Effect.andThen(Deferred.await(released), self.setInactivityTimeout(ms)) }
    const wake = makeAwake(slow)
    const woken = await Effect.runPromise(Effect.gen(function* () {
      const first = yield* Effect.forkChild(wake)
      yield* Effect.yieldNow
      const others = yield* Effect.all([wake, wake])
      yield* Deferred.succeed(released, undefined)
      return [yield* Fiber.join(first), ...others]
    }))
    expect(calls).toEqual([`hold ${PLATFORM_MAX_MS}`])
    expect(woken.map((w) => w.held)).toEqual([true, false, false])
  })
})

describe("isLive", () => {
  test("a live request is one with live=true; any other value, or none, is not", () => {
    expect(isLive("http://electric/v1/shape?offset=1_0&handle=h&live=true")).toBe(true)
    expect(isLive("/v1/shape?offset=1_0&live=true")).toBe(true)
    expect(isLive("http://electric/v1/shape?offset=1_0&live=false")).toBe(false)
    expect(isLive("http://electric/v1/shape?offset=-1")).toBe(false)
  })
})

describe("forward", () => {
  const woken: Woken = { started: false, held: true }
  /** An Effect that takes `ms` of the test clock, then succeeds with `value`. */
  const taking = <A>(ms: number, value: A) => Effect.andThen(TestClock.adjust(`${ms} millis`), Effect.succeed(value))
  /** Runs `effect` on the test clock, collecting its log lines. */
  const run = async <A, E>(effect: Effect.Effect<A, E>) => {
    const log: Array<Record> = []
    return { exit: await Effect.runPromiseExit(collecting(effect.pipe(Effect.provide(TestClock.layer())), log)), log }
  }

  test("records how long waking and then Electric's headers took, Electric's status, and what waking did", async () => {
    const { exit, log } = await run(forward(taking(2_000, woken), taking(3_000, { status: 200 }), true, makeInFlight()))
    expect(exit).toMatchObject({ _tag: "Success", value: { status: 200 } })
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      message: "electric.object.request",
      level: "INFO",
      annotations: { live: true, inFlight: 1, outcome: "answered", status: 200, awakeMs: 2_000, headersMs: 3_000, started: false, held: true },
    })
  })

  test("a refusal from Electric is recorded with its status like any answer", async () => {
    const { log } = await run(forward(Effect.succeed({ started: true, held: true }), Effect.succeed({ status: 400 }), false, makeInFlight()))
    expect(log[0]!.annotations).toMatchObject({ live: false, status: 400, awakeMs: 0, headersMs: 0, started: true })
  })

  test("waking that fails records the stage and the error's tag, and the request is never sent", async () => {
    let sent = false
    class NoContainerInstanceError extends Error {
      readonly _tag = "NoContainerInstanceError"
    }
    const { exit, log } = await run(forward(
      Effect.andThen(TestClock.adjust("1500 millis"), Effect.fail(new NoContainerInstanceError("instance at 10.0.0.1"))),
      Effect.sync(() => {
        sent = true
        return { status: 200 }
      }),
      false,
      makeInFlight(),
    ))
    expect(exit._tag).toBe("Failure")
    expect(sent).toBe(false)
    expect(log).toMatchObject([{
      message: "electric.object.request",
      level: "WARN",
      annotations: { live: false, outcome: "unavailable", status: 503, stage: "awake", error: "NoContainerInstanceError", durationMs: 1_500 },
    }])
    expect(JSON.stringify(log)).not.toContain("10.0.0.1")
  })

  test("a request Electric's port fails records the electric stage with the error's class, or its type", async () => {
    for (const [error, name] of [[new RangeError("port 3000 at 10.0.0.1"), "RangeError"], ["closed", "string"]] as const) {
      const { exit, log } = await run(forward(Effect.succeed(woken), Effect.fail(error), true, makeInFlight()))
      expect(exit._tag).toBe("Failure")
      expect(log[0]!.annotations).toMatchObject({ live: true, outcome: "unavailable", status: 503, stage: "electric", error: name })
      expect(JSON.stringify(log)).not.toContain("10.0.0.1")
    }
  })
  test("records how many requests the object was forwarding when one arrived, and counts each out when it ends", async () => {
    const inFlight = makeInFlight()
    const released = Effect.runSync(Deferred.make<void>())
    const held = forward(Effect.succeed(woken), Effect.as(Deferred.await(released), { status: 200 }), true, inFlight)
    const { log } = await run(Effect.gen(function* () {
      const first = yield* Effect.forkChild(held)
      const second = yield* Effect.forkChild(held)
      yield* Effect.yieldNow
      expect(inFlight.current).toBe(2)
      yield* Effect.exit(forward(Effect.succeed(woken), Effect.fail(new RangeError("refused")), false, inFlight))
      expect(inFlight.current).toBe(2)
      yield* Deferred.succeed(released, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
    }))
    expect(inFlight.current).toBe(0)
    expect(log.map((record) => [record.annotations.outcome, record.annotations.inFlight])).toEqual([
      ["unavailable", 3],
      ["answered", 1],
      ["answered", 2],
    ])
  })
})

describe("directOr", () => {
  test("Electric's answer the direct way is the answer, and the waited way is never tried", () => {
    let waited = false
    const { exit, log } = runLogged(directOr(Effect.succeed("direct"), Effect.sync(() => {
      waited = true
      return "waited"
    })))
    expect(exit).toMatchObject({ _tag: "Success", value: "direct" })
    expect(waited).toBe(false)
    expect(log).toEqual([])
  })

  test("a direct send that fails, as one to a container still starting does, is logged and sent the waited way", () => {
    class UnknownError extends Error {
      readonly _tag = "UnknownError"
    }
    const { exit, log } = runLogged(directOr(Effect.fail(new UnknownError("connect 10.0.0.1:3000 refused")), Effect.succeed("waited")))
    expect(exit).toMatchObject({ _tag: "Success", value: "waited" })
    expect(log).toMatchObject([{ message: "electric.object.port", level: "WARN", annotations: { error: "UnknownError" } }])
    expect(JSON.stringify(log)).not.toContain("10.0.0.1")
  })

  test("when the waited way fails too, its failure is the request's", () => {
    const { exit } = runLogged(directOr(Effect.fail("refused"), Effect.fail("not ready")))
    expect(exit).toMatchObject({ _tag: "Failure" })
    expect(JSON.stringify(exit)).toContain("not ready")
  })
})

describe("logged", () => {
  test("each record reaches Workers Logs whole: one JSON line carrying every field, not a line per field", async () => {
    const lines: Array<unknown> = []
    const log = console.log
    console.log = (...args: Array<unknown>) => void lines.push(args.length === 1 ? args[0] : args)
    try {
      await Effect.runPromise(logged(forward(Effect.succeed({ started: false, held: true }), Effect.succeed({ status: 200 }), false, makeInFlight())))
    } finally {
      console.log = log
    }
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      message: "electric.object.request",
      level: "INFO",
      annotations: { live: false, outcome: "answered", status: 200, awakeMs: expect.any(Number), headersMs: expect.any(Number), started: false, held: true },
    })
  })
})

test("container starts record time and instance identity only after success", async () => {
  const { recordStart, containerStarts } = await import("./ElectricAwake.ts")
  const before = Effect.runSync(Metric.value(containerStarts))
  const good = runLogged(recordStart(Effect.succeed("started"), "instance-one"))
  expect(good.exit).toMatchObject({ _tag: "Success", value: "started" })
  expect(good.log).toHaveLength(1)
  expect(good.log[0]).toMatchObject({ message: "electric.container.start", level: "INFO" })
  expect(Object.keys(good.log[0].annotations).sort()).toEqual(["instanceId", "startedAt"])
  expect(good.log[0].annotations.instanceId).toBe("instance-one")
  expect(good.log[0].annotations.startedAt).toEqual(expect.any(Number))
  const bad = runLogged(recordStart(Effect.fail(new Error("injected fault")), "instance-two"))
  expect(bad.exit._tag).toBe("Failure")
  expect(bad.log).toEqual([])
  const after = Effect.runSync(Metric.value(containerStarts))
  expect(after.count - before.count).toBe(1)
})

describe("serveObject", () => {
  // Cloudflare replaces Electric's container when ElectricRuntime deploys a new version, and its host may restart it:
  // every request in flight then fails at the port with ContainerCrashedError ("Container exited while waiting for
  // port 3000", cause "Network connection lost") or ContainerNotRunningError. On smithers.sh on 2026-11-01 at
  // 05:48:26 UTC, the deploy of version 5873fd91 failed 27 held live requests that way, and the object answered each
  // 500, which reached every open page as a failed shape request (shape-500 report).
  class ContainerCrashedError extends Error {
    readonly _tag = "ContainerCrashedError"
  }
  class ContainerNotRunningError extends Error {
    readonly _tag = "ContainerNotRunningError"
  }
  const url = "http://electric-gateway/v1/shape?table=items&offset=1_0&handle=h&live=true"
  const answered = HttpServerResponse.text("[]", { status: 200 })
  /** The object's handler over `self`, whose port answers with `port`, both ways. */
  const serving = (self: Host, port: Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>, requestId?: string) =>
    serveObject({ wake: makeAwake(self), direct: port, waited: port, url, requestId, inFlight: makeInFlight() })

  test("Electric's answer passes through, and its record carries the proxy's correlation id", () => {
    const { exit, log } = runLogged(serving(host().self, Effect.succeed(answered), "0123456789abcdef"))
    expect(exit).toMatchObject({ _tag: "Success", value: answered })
    expect(log.at(-1)).toMatchObject({
      message: "electric.object.request",
      annotations: { correlationId: "0123456789abcdef", outcome: "answered", status: 200, live: true },
    })
  })

  test("a container that exits mid-request is answered 503 with retry-after and no-store, never 500", () => {
    for (const fault of [new ContainerCrashedError("Network connection lost to 10.0.0.1"), new ContainerNotRunningError("call start()")]) {
      const { exit, log } = runLogged(serving(host().self, Effect.fail(fault), "0123456789abcdef"))
      expect(exit._tag).toBe("Success")
      const response = exit._tag === "Success" ? exit.value : undefined
      expect(response?.status).toBe(503)
      expect(response?.headers).toMatchObject({ "retry-after": String(RETRY_AFTER_SECONDS), "cache-control": "no-store" })
      expect(log.at(-1)).toMatchObject({
        message: "electric.object.request",
        level: "WARN",
        annotations: { correlationId: "0123456789abcdef", outcome: "unavailable", status: 503, stage: "electric", error: fault._tag },
      })
      expect(JSON.stringify(log)).not.toContain("10.0.0.1")
    }
  })

  test("a container Cloudflare can't provide is answered 503 too, at the awake stage", () => {
    const { self } = host(false)
    const refusing: Host = { ...self, start: Effect.fail(new Error("There is no container instance that can be provided")) }
    const { exit, log } = runLogged(serving(refusing, Effect.succeed(answered)))
    expect(exit._tag === "Success" ? exit.value.status : undefined).toBe(503)
    expect(log.at(-1)!.annotations).toMatchObject({ correlationId: "unavailable", outcome: "unavailable", status: 503, stage: "awake" })
  })

  test("a correlation id that isn't the proxy's generated span id is never logged", () => {
    for (const invalid of ["private-customer-content", "0123456789ABCDEF", undefined]) {
      const { log } = runLogged(serving(host().self, Effect.succeed(answered), invalid))
      expect(log.at(-1)!.annotations.correlationId).toBe("unavailable")
      expect(JSON.stringify(log)).not.toContain("private-customer-content")
    }
  })
})
