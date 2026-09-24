/**
 * A driver that claims a run in its own process and is then SIGKILLed.
 *
 * `HardKillReclaim` and `LeaseLiveness` write the abandoned row themselves —
 * a raw `INSERT`, or a `claimAndOwn` under an owner that never existed. Both
 * describe the state a hard kill leaves; neither produces it. This fixture
 * does: a real `EngineStore` claims a real run, starts running a real flow,
 * and the case that spawned it kills the process outright. Nothing releases
 * the claim, because nothing gets to run — which is the whole point of
 * SIGKILL and the reason `releaseOwned` cannot stand in for it.
 *
 * Composed with NO `isAlive`, so the reclaim it sets up has to be reached by
 * the engine's own default liveness rather than by anything a host supplies.
 */
import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { DurableEngineState, EngineStore, StepBoundary } from "@smthrs/engine-store"
import { SqlJournal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Migrations from "../../src/Migrations.ts"
import * as OwnerIdentity from "../../src/OwnerIdentity.ts"
import { withCrypto } from "../Sha256.ts"
import { ReclaimFlow } from "./LeaseReclaimFlow.ts"

const filename = process.argv[2]
const executionId = process.argv[3]

if (filename === undefined || executionId === undefined) {
  throw new Error("usage: lease-reclaim-child.ts <filename> <execution-id>")
}

const jj = Jj.make({
  snapshot: () =>
    Effect.succeed({ commitId: "lease-reclaim-child" as never, changeId: "lease-reclaim-child" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const database = Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
const sqlServices = Layer.provideMerge(
  Layer.mergeAll(
    AttemptStore.layer,
    CacheStore.layer,
    RunStore.layer,
    DurableEngineState.layer,
    SqlJournal.layer({ capacity: 64, overflow: "reject" })
  ),
  Layer.provideMerge(Migrations.layer, database)
)
const requirements = Layer.mergeAll(
  sqlServices,
  StepBoundary.layerTest(),
  OwnerIdentity.layer,
  Layer.succeed(Jj.Jj, jj)
)

await Effect.runPromise(
  withCrypto(
    Effect.scoped(
      Effect.gen(function*() {
        const engine = yield* EngineStore.make({
          owner: { hostId: "lease-reclaim-child" },
          journalSource: "lease-reclaim-child"
          // Deliberately no `isAlive`.
        })
        // The marker is written from INSIDE the body, so the parent kills a
        // process whose run row is already `running` under this owner with a
        // live heartbeat. A marker written before `execute` would race the
        // claim, and `execute` itself never answers for a body that neither
        // settles nor parks.
        yield* engine.register(ReclaimFlow, () =>
          Effect.sync(() => {
            process.stdout.write(`${JSON.stringify({ status: "running", pid: process.pid })}\n`)
          }).pipe(Effect.andThen(Effect.never)))
        yield* engine.execute(ReclaimFlow, { executionId, payload: {}, discard: true })
        return yield* Effect.never
      }).pipe(Effect.provide(requirements))
    )
  )
)
