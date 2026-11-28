/**
 * `SandboxObject.wake`, `rearm` and `run` against container clients that
 * record each call, for order and faults. `ContainerTerminal.workerd.test.ts`
 * wakes a real container, reaches an intercepted host from inside it, and
 * runs a command that writes for its exit code.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Stream from "effect/Stream"
import { TestClock } from "effect/testing"
import { type ContainerTerminal, SandboxObject } from "../src/index.ts"
import * as MemoryContainer from "./fixtures/MemoryContainer.ts"
import * as Telemetry from "./fixtures/Telemetry.ts"

const intercepts = [
  { host: "forge.smithers.internal", fetcher: "forge" },
  { host: "sandbox.smithers.internal:8080", fetcher: "lifecycle" }
]

describe("SandboxObject.wake", () => {
  it.effect("starts a stopped container offline, arms the timeout, then registers every intercept in order", () =>
    Effect.gen(function*() {
      const { calls, machine } = MemoryContainer.machine(false)
      expect(yield* SandboxObject.wake(machine, { intercepts })).toBe("started")
      expect(calls).toEqual([
        { _tag: "start", options: { enableInternet: false } },
        { _tag: "timeout", ms: 30 * 60 * 1000 },
        { _tag: "intercept", host: "forge.smithers.internal", fetcher: "forge" },
        { _tag: "intercept", host: "sandbox.smithers.internal:8080", fetcher: "lifecycle" }
      ])
    }))

  it.effect("starts a stopped container on the instance type it names; a running one keeps its own", () =>
    Effect.gen(function*() {
      const stopped = MemoryContainer.machine(false)
      expect(yield* SandboxObject.wake(stopped.machine, { intercepts: [], instance: "standard-1" })).toBe("started")
      expect(stopped.calls[0]).toEqual({ _tag: "start", options: { enableInternet: false, instance: "standard-1" } })
      const custom = MemoryContainer.machine(false)
      const resources = { vcpu: 2, memoryMib: 4096, diskMb: 8000 }
      yield* SandboxObject.wake(custom.machine, { intercepts: [], instance: resources })
      expect(custom.calls[0]).toEqual({ _tag: "start", options: { enableInternet: false, instance: resources } })
      const running = MemoryContainer.machine(true)
      yield* SandboxObject.wake(running.machine, { intercepts: [], instance: "standard-1" })
      expect(running.calls.map((call) => call._tag)).toEqual(["timeout"])
    }))

  it.live("a start that runs past startTimeoutMs fails StartTimedOut and is counted; a quick one is not bounded", () => {
    const t = Telemetry.make()
    return Effect.gen(function*() {
      const stuck: SandboxObject.Machine<string, MemoryContainer.ContainerFailure> = {
        ...MemoryContainer.machine(false).machine,
        start: () => Effect.never
      }
      const error = yield* Effect.flip(SandboxObject.wake(stuck, { intercepts, startTimeoutMs: 20 }))
      expect(error).toEqual(new SandboxObject.StartTimedOut({ timeoutMs: 20 }))
      const quick = MemoryContainer.machine(false)
      expect(yield* SandboxObject.wake(quick.machine, { intercepts: [], startTimeoutMs: 60_000 })).toBe("started")
      expect(quick.calls.map((call) => call._tag)).toEqual(["start", "timeout"])
    }).pipe(
      t.observed,
      Effect.andThen(Effect.sync(() => {
        expect(t.count(SandboxObject.startTimeouts, {})).toBe(1)
        expect(t.count(SandboxObject.wakes, { outcome: "failed" })).toBe(1)
        expect(Object.fromEntries(t.named("sandbox.wake")[0]!.attributes)).toMatchObject({
          "error.type": "@smthrs/platform-cloudflare/StartTimedOut"
        })
      }))
    )
  })

  it.effect("a running container is not started again; its timeout and intercepts are set again", () =>
    Effect.gen(function*() {
      const { calls, machine } = MemoryContainer.machine(true)
      expect(yield* SandboxObject.wake(machine, { intercepts, inactivityTimeoutMs: 60_000 })).toBe("running")
      expect(calls).toEqual([
        { _tag: "timeout", ms: 60_000 },
        { _tag: "intercept", host: "forge.smithers.internal", fetcher: "forge" },
        { _tag: "intercept", host: "sandbox.smithers.internal:8080", fetcher: "lifecycle" }
      ])
    }))

  it.effect("with an egress, every other HTTP and HTTPS request goes to it, after the hosts' own intercepts", () =>
    Effect.gen(function*() {
      const { calls, machine } = MemoryContainer.machine(true)
      expect(yield* SandboxObject.wake(machine, { intercepts, egress: "egress" })).toBe("running")
      expect(calls).toEqual([
        { _tag: "timeout", ms: 30 * 60 * 1000 },
        { _tag: "intercept", host: "forge.smithers.internal", fetcher: "forge" },
        { _tag: "intercept", host: "sandbox.smithers.internal:8080", fetcher: "lifecycle" },
        { _tag: "interceptAll", fetcher: "egress" },
        { _tag: "interceptHttps", host: "*", fetcher: "egress" }
      ])
    }))

  it.effect.each(["start", "timeout", "intercept", "interceptAll", "interceptHttps"] as const)(
    "a failed %s fails the wake and stops there",
    (fail) =>
      Effect.gen(function*() {
        const { calls, machine } = MemoryContainer.machine(false, fail)
        const error = yield* Effect.flip(SandboxObject.wake(machine, { intercepts, egress: "egress" }))
        expect(error).toBeInstanceOf(MemoryContainer.ContainerFailure)
        expect(calls.at(-1)?._tag).toBe(fail)
        // Nothing after the failed call: a failed intercept stops the hosts' and the egress's that follow it.
        const after = ["start", "timeout", "intercept", "interceptAll", "interceptHttps"].slice(
          ["start", "timeout", "intercept", "interceptAll", "interceptHttps"].indexOf(fail) + 1
        )
        expect(calls.filter((call) => after.includes(call._tag) && call._tag !== "intercept")).toEqual([])
        expect(calls.filter((call) => call._tag === "intercept").length).toBe(
          fail === "intercept" ? 1 : fail === "start" || fail === "timeout" ? 0 : 2
        )
      })
  )

  it.effect("telemetry counts outcomes and records a failure's tag, never its text", () => {
    const t = Telemetry.make()
    return Effect.gen(function*() {
      yield* SandboxObject.wake(MemoryContainer.machine(false).machine, { intercepts })
      yield* SandboxObject.wake(MemoryContainer.machine(true).machine, { intercepts: [], egress: "egress" })
      yield* Effect.exit(SandboxObject.wake(MemoryContainer.machine(false, "start").machine, { intercepts }))
    }).pipe(
      t.observed,
      Effect.andThen(Effect.sync(() => {
        expect(t.count(SandboxObject.wakes, { outcome: "started" })).toBe(1)
        expect(t.count(SandboxObject.wakes, { outcome: "running" })).toBe(1)
        expect(t.count(SandboxObject.wakes, { outcome: "failed" })).toBe(1)
        const spans = t.named("sandbox.wake")
        expect(spans.map((span) => Object.fromEntries(span.attributes))).toEqual([
          { "smithers.sandbox.intercepts": 2, "smithers.sandbox.egress": false, "smithers.sandbox.wake": "started" },
          { "smithers.sandbox.intercepts": 0, "smithers.sandbox.egress": true, "smithers.sandbox.wake": "running" },
          {
            "smithers.sandbox.intercepts": 2,
            "smithers.sandbox.egress": false,
            "smithers.sandbox.wake": "failed",
            "error.type": "ContainerFailure"
          }
        ])
        for (const span of spans) expect(span.status).toMatchObject({ _tag: "Ended", exit: { _tag: "Success" } })
        expect(t.lines("cloudflare.sandbox.wake").map((line) => line.annotations)).toEqual(
          spans.map((span) =>
            expect.objectContaining({
              trace_id: span.traceId,
              span_id: span.spanId,
              outcome: span.attributes.get("smithers.sandbox.wake")
            })
          )
        )
        t.expectNoContent("start broke")
      }))
    )
  })

  it.effect("the log line says how long the wake took, and the span doesn't", () => {
    const t = Telemetry.make()
    const { machine } = MemoryContainer.machine(false)
    const slow = { ...machine, running: Effect.andThen(Effect.sleep("312 seconds"), machine.running) }
    return Effect.gen(function*() {
      const woken = yield* Effect.forkChild(SandboxObject.wake(slow, { intercepts }))
      yield* TestClock.adjust("312 seconds")
      expect(yield* Fiber.join(woken)).toBe("started")
    }).pipe(
      t.observed,
      Effect.andThen(Effect.sync(() => {
        expect(t.lines("cloudflare.sandbox.wake")[0]!.annotations).toMatchObject({
          outcome: "started",
          durationMs: 312_000
        })
        expect(Object.keys(Object.fromEntries(t.named("sandbox.wake")[0]!.attributes))).not.toContain("durationMs")
      }))
    )
  })

  it.effect("a failure with no tag is recorded as unknown, and still returned unchanged", () => {
    const t = Telemetry.make()
    const failing: SandboxObject.Machine<string, string | MemoryContainer.ContainerFailure> = {
      ...MemoryContainer.machine(false).machine,
      running: Effect.fail("no capacity in colo")
    }
    return SandboxObject.wake(failing, { intercepts }).pipe(
      Effect.flip,
      t.observed,
      Effect.map((error) => {
        expect(error).toBe("no capacity in colo")
        expect(Object.fromEntries(t.named("sandbox.wake")[0]!.attributes)).toMatchObject({ "error.type": "unknown" })
        t.expectNoContent("no capacity")
      })
    )
  })
})

describe("SandboxObject.rearm", () => {
  it.effect("re-arms a running container's timeout and starts nothing; a stopped one is left alone", () =>
    Effect.gen(function*() {
      const running = MemoryContainer.machine(true)
      expect(yield* SandboxObject.rearm(running.machine)).toBe("rearmed")
      expect(yield* SandboxObject.rearm(running.machine, 60_000)).toBe("rearmed")
      expect(running.calls).toEqual([{ _tag: "timeout", ms: 30 * 60 * 1000 }, { _tag: "timeout", ms: 60_000 }])
      const stopped = MemoryContainer.machine(false)
      expect(yield* SandboxObject.rearm(stopped.machine)).toBe("stopped")
      expect(stopped.calls).toEqual([])
    }))

  it.effect("a failed timeout fails unchanged; telemetry counts every outcome and records only the tag", () => {
    const t = Telemetry.make()
    return Effect.gen(function*() {
      yield* SandboxObject.rearm(MemoryContainer.machine(true).machine)
      yield* SandboxObject.rearm(MemoryContainer.machine(false).machine)
      const error = yield* Effect.flip(SandboxObject.rearm(MemoryContainer.machine(true, "timeout").machine))
      expect(error).toBeInstanceOf(MemoryContainer.ContainerFailure)
    }).pipe(
      t.observed,
      Effect.andThen(Effect.sync(() => {
        expect(t.count(SandboxObject.rearms, { outcome: "rearmed" })).toBe(1)
        expect(t.count(SandboxObject.rearms, { outcome: "stopped" })).toBe(1)
        expect(t.count(SandboxObject.rearms, { outcome: "failed" })).toBe(1)
        expect(t.named("sandbox.rearm").map((span) => Object.fromEntries(span.attributes))).toEqual([
          { "smithers.sandbox.inactivity_timeout_ms": 1_800_000, "smithers.sandbox.rearm": "rearmed" },
          { "smithers.sandbox.inactivity_timeout_ms": 1_800_000, "smithers.sandbox.rearm": "stopped" },
          {
            "smithers.sandbox.inactivity_timeout_ms": 1_800_000,
            "smithers.sandbox.rearm": "failed",
            "error.type": "ContainerFailure"
          }
        ])
        expect(t.lines("cloudflare.sandbox.rearm").map((line) => line.annotations.outcome)).toEqual([
          "rearmed",
          "stopped",
          "failed"
        ])
        t.expectNoContent("timeout broke")
      }))
    )
  })
})

describe("SandboxObject.run", () => {
  /**
   * A container whose exec pipes hold no bytes, as workerd's: a command that writes to a piped stream nobody reads
   * never exits; one whose streams are ignored exits with `code`.
   */
  const unbuffered = (code: number) => {
    const execs: Array<{ readonly argv: ReadonlyArray<string>; readonly options: unknown }> = []
    let released = 0
    const container: ContainerTerminal.Container = {
      exec: (argv, options = {}) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            execs.push({ argv, options })
            const blocked = options.stdout !== "ignore" || options.stderr !== "ignore"
            return {
              stdin: undefined,
              stdout: undefined,
              exitCode: blocked ? Effect.never : Effect.succeed(code),
              kill: () => Effect.void,
              resize: () => Effect.void
            }
          }),
          () => Effect.sync(() => void released++)
        )
    }
    return { container, execs, released: () => released }
  }

  it.live("answers the exit code of a command that writes, its output ignored, and releases the process", () =>
    Effect.gen(function*() {
      const box = unbuffered(3)
      const code = yield* SandboxObject.run(box.container, ["useradd", "p1"], { user: "0:0", env: { HOME: "/root" } })
        .pipe(Effect.timeout("2 seconds"))
      expect(code).toBe(3)
      expect(box.execs).toEqual([{
        argv: ["useradd", "p1"],
        options: { user: "0:0", env: { HOME: "/root" }, stdout: "ignore", stderr: "ignore" }
      }])
      expect(box.released()).toBe(1)
      // With no user or variables, the image's own apply.
      yield* SandboxObject.run(box.container, ["true"])
      expect(box.execs[1]!.options).toEqual({ stdout: "ignore", stderr: "ignore" })
    }))
})

describe("SandboxObject.runWithStderr", () => {
  const bytes = (text: string) => new TextEncoder().encode(text)

  it.live("drains stderr concurrently so an unbuffered pipe finishes without blocking, and keeps bounded output out of telemetry", () => {
    const t = Telemetry.make()
    const execs: Array<{ readonly argv: ReadonlyArray<string>; readonly options: unknown }> = []
    let released = 0
    return Effect.gen(function*() {
      const drained = yield* Deferred.make<void>()
      const container: SandboxObject.StderrContainer = {
        exec: (argv, options) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              execs.push({ argv, options })
              return {
                stderr: Stream.fromIterable([bytes("error: secret-sentinel\n")]).pipe(
                  Stream.onEnd(Deferred.succeed(drained, undefined).pipe(Effect.asVoid))
                ),
                // Only resolves once stderr has been completely drained, proving no deadlock.
                exitCode: Deferred.await(drained).pipe(Effect.as(75))
              }
            }),
            () => Effect.sync(() => void released++)
          )
      }
      const ran = yield* SandboxObject.runWithStderr(container, ["sh", "-c", "git fetch"], {
        user: "1000:2000",
        env: { HOME: "/home/smithers" }
      }).pipe(Effect.timeout("2 seconds"))
      expect(ran).toEqual({ exitCode: 75, stderr: "error: secret-sentinel\n", truncated: false })
      expect(execs).toEqual([{
        argv: ["sh", "-c", "git fetch"],
        options: { user: "1000:2000", env: { HOME: "/home/smithers" }, stdout: "ignore", stderr: "pipe" }
      }])
      expect(released).toBe(1)
    }).pipe(
      t.observed,
      Effect.andThen(Effect.sync(() => {
        t.expectNoContent("secret-sentinel")
      }))
    )
  })

  it.live("retains head and tail when stderr exceeds maxStderrBytes while draining every chunk", () =>
    Effect.gen(function*() {
      let chunksDrained = 0
      const makeBox = (chunks: ReadonlyArray<Uint8Array>, code: number): SandboxObject.StderrContainer => ({
        exec: () =>
          Effect.succeed({
            stderr: Stream.fromIterable(chunks).pipe(Stream.tap(() => Effect.sync(() => void chunksDrained++))),
            exitCode: Effect.succeed(code)
          })
      })
      // Multi-chunk overflow crossing both headCap and tail ring wraparound.
      const large = makeBox([
        bytes("HEAD-START-"),
        bytes("x".repeat(4000)),
        bytes("y".repeat(6000)),
        bytes("z".repeat(4000)),
        bytes("-TAIL-END")
      ], 75)
      const bounded = yield* SandboxObject.runWithStderr(large, ["git"], { maxStderrBytes: 64 })
      expect(bounded.exitCode).toBe(75)
      expect(bounded.truncated).toBe(true)
      expect(bounded.stderr.startsWith("HEAD-START-")).toBe(true)
      expect(bounded.stderr.endsWith("-TAIL-END")).toBe(true)
      expect(chunksDrained).toBe(5)

      // Single chunk larger than maxStderrBytes.
      const single = makeBox([bytes("0123456789" + "m".repeat(200) + "ABCDEFGHIJ")], 75)
      const singleRes = yield* SandboxObject.runWithStderr(single, ["git"], { maxStderrBytes: 10 })
      expect(singleRes).toEqual({ exitCode: 75, stderr: "01234\nFGHIJ", truncated: true })

      // Overflow after partial fill past headCap exercises ring wraparound on prior buffered tail bytes.
      const partial = makeBox([bytes("01234567"), bytes("89AB")], 75)
      const partialRes = yield* SandboxObject.runWithStderr(partial, ["git"], { maxStderrBytes: 10 })
      expect(partialRes).toEqual({ exitCode: 75, stderr: "01234\n789AB", truncated: true })

      // Exact boundary is not truncated.
      const exact = makeBox([bytes("01234"), bytes("56789")], 0)
      expect(yield* SandboxObject.runWithStderr(exact, ["git"], { maxStderrBytes: 10 })).toEqual({
        exitCode: 0,
        stderr: "0123456789",
        truncated: false
      })

      // Zero cap drains everything and reports truncation only when non-empty bytes arrived.
      expect(yield* SandboxObject.runWithStderr(makeBox([bytes("abc")], 75), ["git"], { maxStderrBytes: 0 })).toEqual({
        exitCode: 75,
        stderr: "",
        truncated: true
      })
      expect(yield* SandboxObject.runWithStderr(makeBox([new Uint8Array(0)], 0), ["git"], { maxStderrBytes: 0 }))
        .toEqual({ exitCode: 0, stderr: "", truncated: false })
    }))

  it.live("handles missing stderr, preserves partial stderr on stream error, propagates exit failure, and rejects invalid limits", () =>
    Effect.gen(function*() {
      const noStderr: SandboxObject.StderrContainer = {
        exec: () => Effect.succeed({ stderr: undefined, exitCode: Effect.succeed(70) })
      }
      expect(yield* SandboxObject.runWithStderr(noStderr, ["git"])).toEqual({
        exitCode: 70,
        stderr: "",
        truncated: false
      })

      const streamError: SandboxObject.StderrContainer<MemoryContainer.ContainerFailure> = {
        exec: () =>
          Effect.succeed({
            stderr: Stream.concat(
              Stream.make(bytes("error: RPC failed; HTTP 502\n")),
              Stream.fail(new MemoryContainer.ContainerFailure({ message: "pipe closed" }))
            ),
            exitCode: Effect.succeed(75)
          })
      }
      expect(yield* SandboxObject.runWithStderr(streamError, ["git"])).toEqual({
        exitCode: 75,
        stderr: "error: RPC failed; HTTP 502\n",
        truncated: true
      })

      const exitError: SandboxObject.StderrContainer<MemoryContainer.ContainerFailure> = {
        exec: () =>
          Effect.succeed({
            stderr: Stream.empty,
            exitCode: Effect.fail(new MemoryContainer.ContainerFailure({ message: "container gone" }))
          })
      }
      expect(yield* Effect.flip(SandboxObject.runWithStderr(exitError, ["git"]))).toBeInstanceOf(
        MemoryContainer.ContainerFailure
      )

      for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const exit = yield* Effect.exit(SandboxObject.runWithStderr(noStderr, ["git"], { maxStderrBytes: bad }))
        expect(Exit.isFailure(exit)).toBe(true)
      }
    }))
})
