/**
 * A retained machine provider for tests: sticky `DirectorySandbox` sessions
 * under one host directory, running real processes through a contained
 * spawner, as an `HttpSandbox.serve` service holds machines.
 */
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as ProcessReaper from "@smthrs/platform-node/ProcessReaper"
import * as DirectorySandbox from "@smthrs/sandbox/DirectorySandbox"
import { Effect, FileSystem, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { layerNonInteractiveNodeServices } from "../../src/engine.ts"

const contained = Layer.provideMerge(
  ProcessReaper.layerSpawner({ graceMs: 80 }).pipe(
    Layer.provide(ProcessLedger.layerMemory({ hostId: "build-cli-tests", ownerPid: process.pid }))
  ),
  layerNonInteractiveNodeServices
)

/** Machines that are directories under `root`, kept running until their session is destroyed. */
export const directoryMachines = (root: string): Promise<ReturnType<typeof DirectorySandbox.make>> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner
      return DirectorySandbox.make({ fs, spawner, root, persistence: "sticky" })
    }).pipe(Effect.provide(contained))
  )
