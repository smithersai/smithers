import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Fiber, Logger, References, Tracer } from "effect"
import { TestClock } from "effect/testing"
import { ProviderError } from "../src/RemoteChildProcessSpawner/index.ts"
import * as SandboxHealth from "../src/SandboxHealth/index.ts"

const healthyProvider: SandboxHealth.PingProvider = {
  ping: Effect.void
}

const deadProvider: SandboxHealth.PingProvider = {
  // A dead sandbox never answers: the ping hangs forever.
  ping: Effect.never
}

const refusingProvider: SandboxHealth.PingProvider = {
  ping: Effect.fail(
    new ProviderError({ code: "unavailable", message: "session is gone" })
  )
}

describe("SandboxHealth.probe", () => {
  it.effect("reports Healthy when the provider ping answers within the deadline", () =>
    Effect.gen(function*() {
      const state = yield* (
        SandboxHealth.probe(healthyProvider, { deadline: "1 second" })
      )
      expect(state._tag).toBe("Healthy")
    }))

  it.effect("maps a ping that never answers to Unhealthy(sandbox, unresponsive) at the configured deadline", () =>
    Effect.gen(function*() {
      const state = yield* (
        Effect.gen(function*() {
          const probe = yield* SandboxHealth.probe(deadProvider, { deadline: "50 millis" }).pipe(Effect.forkChild)
          yield* TestClock.adjust("49 millis")
          const beforeDeadline = probe.pollUnsafe()
          yield* TestClock.adjust("1 milli")
          const atDeadline = yield* Fiber.join(probe)
          return { beforeDeadline, atDeadline }
        }).pipe(Effect.provide(TestClock.layer()))
      )
      expect(state.beforeDeadline).toBeUndefined()
      expect(state.atDeadline._tag).toBe("Unhealthy")
      if (state.atDeadline._tag === "Unhealthy") {
        expect(state.atDeadline.component).toBe("sandbox")
        expect(state.atDeadline.reason).toBe("unresponsive")
      }
    }))

  it.effect("pins the default deadline: a 4.999s ping is healthy while a hanging ping times out at 5s", () =>
    Effect.gen(function*() {
      const states = yield* (
        Effect.gen(function*() {
          const justInTime = yield* SandboxHealth.probe({ ping: Effect.sleep("4999 millis") }).pipe(Effect.forkChild)
          const hanging = yield* SandboxHealth.probe(deadProvider).pipe(Effect.forkChild)
          yield* TestClock.adjust("4999 millis")
          const healthy = yield* Fiber.join(justInTime)
          const stillPending = hanging.pollUnsafe()
          yield* TestClock.adjust("1 milli")
          const unresponsive = yield* Fiber.join(hanging)
          return { healthy, stillPending, unresponsive }
        }).pipe(Effect.provide(TestClock.layer()))
      )

      expect(states.healthy._tag).toBe("Healthy")
      expect(states.stillPending).toBeUndefined()
      expect(states.unresponsive._tag).toBe("Unhealthy")
      if (states.unresponsive._tag === "Unhealthy") {
        expect(states.unresponsive.reason).toBe("unresponsive")
      }
    }))

  it.effect("maps a failed ping to Unhealthy(sandbox, ping_failed) carrying the provider message", () =>
    Effect.gen(function*() {
      const state = yield* (SandboxHealth.probe(refusingProvider))
      expect(state._tag).toBe("Unhealthy")
      if (state._tag === "Unhealthy") {
        expect(state.component).toBe("sandbox")
        expect(state.reason).toBe("ping_failed")
        expect(state.message).toBe("session is gone")
      }
    }))

  it("opens one SandboxHealth.probe span annotated with the outcome", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })

    await Effect.runPromise(
      Effect.gen(function*() {
        yield* SandboxHealth.probe(healthyProvider, { deadline: "1 second" })
        yield* SandboxHealth.probe(refusingProvider)
      }).pipe(Effect.provideService(Tracer.Tracer, tracer))
    )

    expect(
      spans.filter((span) => span.name === "SandboxHealth.probe").map((span) => span.attributes.get("outcome"))
    ).toEqual(["healthy", "ping_failed"])
  })
})

/**
 * Runs one probe with the debug level enabled and both standard formatters
 * installed, and returns the verdict beside the rendered log lines. The
 * formatters are the real ones a host installs, so what they print is what a
 * host would see.
 */
const renderProbeLogs = (provider: SandboxHealth.PingProvider) =>
  Effect.gen(function*() {
    const lines: Array<string> = []
    const keep = (line: string) => {
      lines.push(line)
    }
    const state = yield* SandboxHealth.probe(provider).pipe(
      Effect.provide(Logger.layer([Logger.map(Logger.formatJson, keep), Logger.map(Logger.formatLogFmt, keep)])),
      Effect.provideService(References.MinimumLogLevel, "Debug")
    )
    return { state, lines }
  })

describe("SandboxHealth.probe logging", () => {
  it("does not redact a custom provider message", async () => {
    const message = "caller supplied token=CUSTOM_PROVIDER_CANARY"
    const { lines, state } = await Effect.runPromise(renderProbeLogs({
      ping: Effect.fail(new ProviderError({ code: "unavailable", message }))
    }))
    expect(state._tag).toBe("Unhealthy")
    if (state._tag === "Unhealthy") expect(state.message).toBe(message)
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(line).toContain(message)
  })

  it("logs the provider code and message and never the failure cause", async () => {
    const records: Array<{ cause: Cause.Cause<unknown>; message: unknown }> = []
    const capture = Logger.make((options) => {
      records.push({ cause: options.cause, message: options.message })
    })

    await Effect.runPromise(
      SandboxHealth.probe(refusingProvider).pipe(
        Effect.provide(Logger.layer([capture])),
        Effect.provideService(References.MinimumLogLevel, "Debug")
      )
    )

    expect(records.map((record) => record.cause.reasons)).toEqual([[]])
    expect(records.map((record) => record.message)).toEqual([
      ["sandbox ping failed", { code: "unavailable", message: "session is gone" }]
    ])
  })

  it("does not disclose a raw provider cause through the standard formatters", async () => {
    const error = new ProviderError({
      code: "unavailable",
      message: "session is gone",
      cause: {
        headers: { authorization: "Bearer sk-live-SECRET" },
        proxy: "http://user:hunter2@proxy.internal"
      }
    })
    // The control: the formatters print a cause through Cause.pretty, which
    // does render the attached vendor error, so the assertions below are not
    // satisfied by a formatter that never looked.
    expect(Cause.pretty(Cause.fail(error))).toContain("sk-live-SECRET")

    const { lines, state } = await Effect.runPromise(renderProbeLogs({ ping: Effect.fail(error) }))

    expect(state._tag).toBe("Unhealthy")
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(line).toContain("sandbox ping failed")
      expect(line).toContain("unavailable")
      expect(line).not.toContain("sk-live-SECRET")
      expect(line).not.toContain("hunter2")
    }
  })

  it("bounds the message it logs and reports at 512 characters, whatever the provider attached", async () => {
    const error = new ProviderError({
      code: "unknown",
      message: "x".repeat(100_000),
      cause: "y".repeat(8 * 1024 * 1024)
    })

    const { lines, state } = await Effect.runPromise(renderProbeLogs({ ping: Effect.fail(error) }))

    expect(state._tag).toBe("Unhealthy")
    if (state._tag === "Unhealthy") {
      expect(state.message).toHaveLength(512 + 3)
      expect(state.message?.endsWith("...")).toBe(true)
    }
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(line.length).toBeLessThan(2048)
  })

  it("cuts above the bound and not at it: 512 characters pass through, 513 are truncated", async () => {
    const reported = async (length: number) => {
      const { state } = await Effect.runPromise(renderProbeLogs({
        ping: Effect.fail(new ProviderError({ code: "unknown", message: "x".repeat(length) }))
      }))
      return state._tag === "Unhealthy" ? state.message : undefined
    }

    expect(await reported(512)).toBe("x".repeat(512))
    expect(await reported(513)).toBe(`${"x".repeat(512)}...`)
  })

  it("collapses control characters so a provider message cannot forge a log line", async () => {
    const error = new ProviderError({
      code: "unknown",
      message: "\u0000gone\r\nlevel=ERROR message=forged\u007f\u001b[31m\n"
    })

    const { lines, state } = await Effect.runPromise(renderProbeLogs({ ping: Effect.fail(error) }))

    expect(state._tag).toBe("Unhealthy")
    if (state._tag === "Unhealthy") expect(state.message).toBe("gone level=ERROR message=forged [31m")
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(line).toContain("gone level=ERROR message=forged [31m")
  })

  it("answers Unhealthy without a defect when the attached cause throws on inspection", async () => {
    const getter = {
      get token(): string {
        throw new Error("boom-getter")
      }
    }
    const proxy = new Proxy({}, {
      get() {
        throw new Error("boom-proxy")
      },
      has() {
        throw new Error("boom-proxy")
      },
      ownKeys() {
        throw new Error("boom-proxy")
      },
      getOwnPropertyDescriptor() {
        throw new Error("boom-proxy")
      }
    })

    for (const cause of [getter, proxy]) {
      const error = new ProviderError({ code: "unknown", message: "adversarial", cause })
      // The control: rendering this cause is exactly what defected before.
      expect(() => Cause.pretty(Cause.fail(error))).toThrow(/boom/)

      const { lines, state } = await Effect.runPromise(renderProbeLogs({ ping: Effect.fail(error) }))

      expect(state._tag).toBe("Unhealthy")
      if (state._tag === "Unhealthy") expect(state.message).toBe("adversarial")
      expect(lines).toHaveLength(2)
      for (const line of lines) expect(line).not.toContain("boom")
    }
  })

  it("hands the raw cause to a host that taps the ping, without it reaching the log", async () => {
    const raw = { token: "sk-live-SECRET" }
    const error = new ProviderError({ code: "unavailable", message: "session is gone", cause: raw })
    const seen: Array<ProviderError> = []
    const tapped: SandboxHealth.PingProvider = {
      ping: Effect.fail(error).pipe(
        Effect.tapError((failure) =>
          Effect.sync(() => {
            seen.push(failure)
          })
        )
      )
    }

    const { lines, state } = await Effect.runPromise(renderProbeLogs(tapped))

    expect(seen.map((failure) => failure.cause)).toEqual([raw])
    expect(state._tag).toBe("Unhealthy")
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(line).not.toContain("sk-live-SECRET")
  })
})

describe("SandboxHealth service", () => {
  it.effect("check probes through the layer-provided service", () =>
    Effect.gen(function*() {
      const state = yield* (
        Effect.gen(function*() {
          const health = yield* SandboxHealth.SandboxHealth
          const check = yield* health.check.pipe(Effect.forkChild)
          yield* TestClock.adjust("50 millis")
          return yield* Fiber.join(check)
        }).pipe(
          Effect.provide(SandboxHealth.layer(deadProvider, { deadline: "50 millis" })),
          Effect.provide(TestClock.layer())
        )
      )
      expect(state._tag).toBe("Unhealthy")
    }))

  it.effect("layerNoop always reports Healthy for hosts without a remote sandbox", () =>
    Effect.gen(function*() {
      const state = yield* (
        Effect.gen(function*() {
          const health = yield* SandboxHealth.SandboxHealth
          return yield* health.check
        }).pipe(Effect.provide(SandboxHealth.layerNoop))
      )
      expect(state._tag).toBe("Healthy")
    }))

  it.effect("make builds a working service without a layer", () =>
    Effect.gen(function*() {
      const service = SandboxHealth.make(healthyProvider)
      const state = yield* (service.check)
      expect(state).toBeInstanceOf(SandboxHealth.Healthy)
    }))

  it.effect("returns a consistent state for sequential checks on one provider", () =>
    Effect.gen(function*() {
      let pings = 0
      const service = SandboxHealth.make({
        ping: Effect.sync(() => {
          pings += 1
        })
      })

      const states = yield* (
        Effect.gen(function*() {
          const first = yield* service.check
          const second = yield* service.check
          return [first, second]
        })
      )

      expect(states.map((state) => state._tag)).toEqual(["Healthy", "Healthy"])
      expect(pings).toBe(2)
    }))
})
