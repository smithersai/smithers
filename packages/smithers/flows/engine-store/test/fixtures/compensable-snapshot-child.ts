/**
 * Runs `CompensableSnapshotRestart`'s flow until its compensable attempt 1 is
 * executing, then waits to be SIGKILLed.
 *
 * The marker is written from inside the action body, after the engine took
 * the attempt's `SnapshotBoundary` handle and persisted it in the attempt row.
 * The parent kills a process whose run row is `running` under this owner with
 * a live heartbeat and whose attempt row is `running`: what a crash leaves,
 * and what nothing in-process can produce, since closing a scope releases the
 * run instead.
 *
 * Composed with NO `isAlive`, like `reclaimed-attempt-child.ts`.
 */
import { FlowEngine } from "@smthrs/engine"
import { Jj } from "@smthrs/kernel"
import * as Effect from "effect/Effect"
import * as EngineStore from "../../src/EngineStore.ts"
import * as StepBoundary from "../../src/StepBoundary.ts"
import * as TestStores from "../../src/test/TestStores.ts"
import { withCrypto } from "../Sha256.ts"
import * as CompensableSnapshotFlow from "./CompensableSnapshotFlow.ts"

const filename = process.argv[2]
const executionId = process.argv[3]

if (filename === undefined || executionId === undefined) {
  throw new Error("usage: compensable-snapshot-child.ts <filename> <execution-id>")
}

const events: Array<string> = []

await Effect.runPromise(
  withCrypto(
    Effect.scoped(
      Effect.gen(function*() {
        const engine = yield* EngineStore.make({
          owner: { hostId: CompensableSnapshotFlow.hostId },
          journalSource: "compensable-snapshot-child"
        })
        const action = CompensableSnapshotFlow.scriptedAction(
          `${executionId}-action`,
          ["hang"],
          { count: 0 },
          Effect.sync(() => {
            process.stdout.write(`${JSON.stringify({ status: "attempting", pid: process.pid, events })}\n`)
          }).pipe(Effect.andThen(Effect.never))
        )
        yield* engine.register(CompensableSnapshotFlow.RestartFlow, () => action)
        yield* engine.execute(CompensableSnapshotFlow.RestartFlow, { executionId, payload: {}, discard: true })
        return yield* Effect.never
      }).pipe(
        Effect.provideService(FlowEngine.SnapshotBoundary, CompensableSnapshotFlow.recordingBoundary(events)),
        Effect.provideService(Jj.Jj, CompensableSnapshotFlow.jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(TestStores.layerAt(filename))
      )
    )
  )
)
