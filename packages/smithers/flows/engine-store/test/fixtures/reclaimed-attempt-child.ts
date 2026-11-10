/**
 * Runs the launch demo's flow until its `Test` step is in flight, then waits
 * to be SIGKILLed.
 *
 * The marker is written from inside the `Test` body, so the parent kills a
 * process whose `Plan` step has finished and published to the shared cache,
 * whose `Test` attempt row is `running`, and whose run row is `running` under
 * this owner with a live heartbeat. That is what the launch demo leaves when
 * a crash lands during its test step, and nothing in-process can produce it:
 * closing a scope releases the run instead.
 *
 * Composed with NO `isAlive`, like `lease-reclaim-child.ts`.
 */
import * as Effect from "effect/Effect"
import * as EngineStore from "../../src/EngineStore.ts"
import * as StepBoundary from "../../src/StepBoundary.vibe"
import * as TestStores from "../../src/test/TestStores.ts"
import { withCrypto } from "../Sha256.ts"
import * as ReclaimedAttemptFlow from "./ReclaimedAttemptFlow.ts"

const filename = process.argv[2]
const executionId = process.argv[3]
const issue = process.argv[4]

if (filename === undefined || executionId === undefined || issue === undefined) {
  throw new Error("usage: reclaimed-attempt-child.ts <filename> <execution-id> <issue>")
}

await Effect.runPromise(
  withCrypto(
    Effect.scoped(
      Effect.gen(function*() {
        const engine = yield* EngineStore.make({
          owner: { hostId: ReclaimedAttemptFlow.hostId },
          journalSource: "reclaimed-attempt-child"
        })
        const layer = ReclaimedAttemptFlow.layer(engine, {
          plan: (planned) => Effect.succeed(`plan for ${planned}`),
          test: () =>
            Effect.sync(() => {
              process.stdout.write(`${JSON.stringify({ status: "testing", pid: process.pid })}\n`)
            }).pipe(Effect.andThen(Effect.never))
        })
        return yield* Effect.gen(function*() {
          yield* ReclaimedAttemptFlow.Fix.execute({ issue }, { executionId, discard: true })
          return yield* Effect.never
        }).pipe(Effect.provide(layer))
      }).pipe(
        Effect.provide(ReclaimedAttemptFlow.jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(TestStores.layerAt(filename))
      )
    )
  )
)
