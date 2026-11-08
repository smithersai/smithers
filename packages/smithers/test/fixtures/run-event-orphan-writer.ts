/** Commits an engine result, retaining an unfinished control writer until SIGKILL. */
import { NodeCrypto } from "@effect/platform-node"
import { ControlRuntime, SqlControlRuntime } from "@smthrs/control"
import { Journal, JournalEvent, SqlJournal } from "@smthrs/journal"
import { RunStore } from "@smthrs/run-store"
import { Clock, Context, Effect, Layer } from "effect"
import { hostname } from "node:os"
import { join } from "node:path"
import * as ControlDatabase from "../../src/internal/ControlDatabase.ts"

const directory = process.argv[2]!
const owner = { hostId: hostname(), pid: process.pid, nonce: "orphaned-control-writer" }
const database = ControlDatabase.layer(join(directory, "control.sqlite"))
const stores = Layer.mergeAll(SqlJournal.layer({ capacity: 1024, overflow: "reject" }), RunStore.layer).pipe(
  Layer.provideMerge(database),
  Layer.orDie
)
const runtime = SqlControlRuntime.layer({ owner }).pipe(
  Layer.provideMerge(stores),
  Layer.provide(NodeCrypto.layer),
  Layer.orDie
)
// The parent owns this pipe. Keep the committed writer alive until the test
// kills it; an unresolved Promise alone is not a Node event-loop handle.
process.stdin.resume()
await Effect.runPromise(
  Effect.gen(function*() {
    const control = yield* ControlRuntime.ControlRuntime
    const journal = yield* Journal.Journal
    const engine = Context.get(
      yield* Layer.build(Layer.fresh(RunStore.layer.pipe(
        Layer.provide(ControlDatabase.layer(join(directory, "engine.sqlite")))
      ))),
      RunStore.RunStore
    )
    const runs: Array<{ runId: string; status: "completed" | "failed" | "cancelled"; parked: boolean }> = []
    for (const status of ["completed", "failed", "cancelled"] as const) {
      for (const parked of [false, true]) {
        const { card } = yield* control.plan({ flowId: "system/test", input: {} })
        const token = yield* control.lookupApproval(card.approval.target)
        yield* control.resolveApproval(token, "approved", yield* control.stampPrincipal())
        const launch = yield* control.launch(card.planId, card.digest, card.envelope)
        if (launch._tag !== "Started") return yield* Effect.die("expected writer admission")
        const runId = launch.run.runId
        if (parked) yield* control.writeStatus(runId, yield* control.claimFence(runId), "parked")
        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make(runId),
            sourceId: JournalEvent.SourceId.make("crashing-writer"),
            sourceSeq: JournalEvent.SourceSeq.make(0),
            eventType: `fixture.${status}`,
            payload: { status }
          })
        )
        yield* engine.create(runId, JSON.stringify({ version: 1, flowName: "system/test", payload: {} }))
        const row = yield* engine.get(runId)
        const claimed = yield* engine.claimAndOwn(
          runId,
          {
            status: row.status,
            owner: row.owner,
            heartbeatAtMs: row.heartbeatAtMs
          },
          owner,
          yield* Clock.currentTimeMillis
        )
        if (claimed._tag !== "Activated") return yield* Effect.die("expected engine ownership")
        const committed = yield* engine.transitionOwned(runId, owner, status)
        if (committed._tag !== "Transitioned") return yield* Effect.die("expected terminal engine commit")
        runs.push({ runId, status, parked })
      }
    }
    yield* Effect.sync(() => process.stdout.write(`ORPHAN_READY ${JSON.stringify(runs)}\n`))
    return yield* Effect.never
  }).pipe(Effect.provide(runtime), Effect.scoped)
)
