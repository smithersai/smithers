import { Collection } from "@smthrs/effect-tanstack-db"
import { Deferred, Effect, Fiber, Logger, Metric } from "effect"
import { expect, test, vi } from "vitest"
import { IssuesStore } from "./features/issues/store"
import { initialSnapshots, observeInitialApplied } from "./shapeApplied"
import { openTestApp } from "./test/chatApi"

for (const fault of ["none", "held receipt", "load failure"] as const) test(`initial applied observation: ${fault}`, async () => {
  const app = openTestApp()
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const registry: Metric.MetricRegistry = new Map()
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
    Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make(line => void logs.push(Logger.formatStructured.log(line)))])),
    Effect.provideService(Metric.MetricRegistry, registry),
  )
  const gate = await Effect.runPromise(Deferred.make<void>())
  let entered = false
  try {
    const real = await app.runPromise(Effect.service(IssuesStore))
    const faulty = fault === "none" ? real : {
      ...real,
      writes: {
        ...real.writes,
        preload: fault === "load failure" ? Effect.fail(new Collection.LoadFailed({ cause: new Error("private sentinel") })) : real.writes.preload,
        currentApplied: real.writes.currentApplied.pipe(Effect.tap(() => Effect.sync(() => { entered = true })), Effect.andThen(Deferred.await(gate))),
      },
    }
    const observation = Effect.flatMap(IssuesStore, store => observeInitialApplied(store.writes, "github-writes", "*"))
      .pipe(Effect.provideService(IssuesStore, faulty), provide)
    if (fault === "held receipt") {
      const fiber = Effect.runFork(observation)
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 10_000 })
      expect(logs).toEqual([])
      await Effect.runPromise(Deferred.succeed(gate, undefined))
      await Effect.runPromise(Fiber.join(fiber))
    } else await Effect.runPromise(observation)
    const count = await Effect.runPromise(provide(Metric.value(Metric.withAttributes(initialSnapshots, { source: "github-writes" }))))
    expect(count.count).toBe(fault === "load failure" ? 0 : 1)
    expect(logs.map(line => ({ message: line.message, annotations: line.annotations }))).toEqual(fault === "load failure" ? [] : [
      { message: "shape.initial.applied", annotations: { source: "github-writes", repository: "*" } },
    ])
    expect(JSON.stringify(logs)).not.toContain("private sentinel")
  } finally {
    await Effect.runPromise(Deferred.succeed(gate, undefined))
    await app.dispose()
  }
})
