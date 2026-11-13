// Measures the real supervisor while its health fiber is still running.
// Only the health interval uses virtual time; socket probes, their deadlines,
// readiness and process cleanup all use the real clock and real fixture server.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as ServiceSupervisor from "../../../src/ServiceSupervisor.ts"

const mode = process.argv[2]
const port = Number(process.argv[3])
const serverPath = process.argv[4]
const gc = globalThis.gc
if (
  (mode !== "healthy" && mode !== "misses") || !Number.isInteger(port) || serverPath === undefined || gc === undefined
) {
  throw new Error("usage: health-memory-driver.ts <healthy|misses> <port> <server.mjs>")
}

const intervalMs = 3_600_000
const program = Effect.gen(function*() {
  const live = yield* Clock.Clock
  const finished = yield* Deferred.make<void>()
  let probes = 0
  let before = 0
  let after = 0
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => live.currentTimeMillisUnsafe(),
    currentTimeMillis: live.currentTimeMillis,
    currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
    currentTimeNanos: live.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: live.monotonicTimeNanos,
    sleep: (duration) => {
      if (Duration.toMillis(duration) !== intervalMs) return live.sleep(duration)
      return Effect.suspend(() => {
        // Each new interval follows one completed probe, except the first.
        const completed = probes++
        if (completed === 2_500 || completed === 22_500) {
          gc()
          const heap = process.memoryUsage().heapUsed
          if (completed === 2_500) before = heap
          else {
            after = heap
            return Deferred.succeed(finished, undefined).pipe(Effect.andThen(Effect.never))
          }
        }
        return Effect.yieldNow
      })
    }
  }

  const status = yield* Effect.scoped(Effect.gen(function*() {
    const supervisor = yield* ServiceSupervisor.make
    const handle = yield* supervisor.acquire({
      key: "//fixtures:health-memory",
      cwd: process.cwd(),
      argv: [process.execPath, serverPath, "--port", String(port)],
      readiness: { http: `http://127.0.0.1:${port}/health`, timeout: "30s" },
      health: { interval: "1h", failures: 1_000_000 },
      stop: { signal: "SIGTERM", grace: "100ms" }
    })
    return yield* handle.whileHealthy(Effect.gen(function*() {
      if (mode === "misses") {
        yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/wedge`).then((response) => response.text()))
      }
      yield* Deferred.await(finished)
      return yield* Effect.promise(async () => {
        const response = await fetch(`http://127.0.0.1:${port}/health`)
        await response.text()
        return response.status
      })
    }))
  })).pipe(Effect.provideService(Clock.Clock, clock))
  return { probes: probes - 1, before, after, status }
})

NodeRuntime.runMain(program.pipe(Effect.tap((sample) => Effect.sync(() => console.log(JSON.stringify(sample))))))
