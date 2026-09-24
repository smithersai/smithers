import * as ContainedSpawner from "@smthrs/kernel/ContainedSpawner"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import { Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { expect, it, vi } from "vitest"

it("installs the prepared Windows owner adapter with a contained spawner", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" })
    vi.resetModules()
    const ProcessReaper = await import("../src/ProcessReaper.ts")
    // Building the factory must not probe or signal an operating-system PID.
    // The complete protocol and job lifecycle are exercised in their suites.
    const ledger = await Effect.runPromise(ProcessLedger.makeMemory({ hostId: "windows", ownerPid: process.pid }))
    await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        expect(ContainedSpawner.isContained(spawner)).toBe(true)
        expect(yield* ledger.live).toEqual([])
      }).pipe(
        Effect.provide(ProcessReaper.layerSpawner({ graceMs: 42 })),
        Effect.provide(Layer.succeed(ProcessLedger.ProcessLedger)(ledger)),
        Effect.scoped
      )
    )
  } finally {
    Object.defineProperty(process, "platform", platform)
    vi.resetModules()
  }
})
