/** Runs one build of the real health host against a shared durable engine. */
import { NodeCrypto } from "@effect/platform-node"
import { Control, Health } from "@smthrs/control"
import * as TestControl from "@smthrs/control/test/TestControl"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { EngineStore, StepBoundary } from "@smthrs/engine-store"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { FlowRuntime } from "@smthrs/flow"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import { RunStore } from "@smthrs/run-store"
import { Cause, Context, Deferred, Effect, Layer, Logger } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { pathToFileURL } from "node:url"

const [filename, modulePath, advanceMs = "0"] = process.argv.slice(2)
if (filename === undefined || modulePath === undefined) throw new Error("Expected database and health host module")
const HealthHost: typeof import("../../src/internal/HealthHost.ts") = await import(pathToFileURL(modulePath).href)
const engine = EngineStore.layer({ owner: { hostId: "health-build" }, journalSource: "health-build" }).pipe(
  Layer.provideMerge(TestStores.layerAt(filename)),
  Layer.provide(StepBoundary.layerUnsupported),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provide(NodeJj.layerAt(process.cwd()))
)
const result = await Effect.runPromise(
  Effect.gen(function*() {
    const services = yield* Layer.build(engine)
    const control = yield* Control.Control
    const observed = yield* Deferred.make<string>()
    yield* Effect.forkScoped(
      HealthHost.watch(Health.makeRegistry()).pipe(
        Effect.provideService(FlowRuntime.FlowRuntime, Context.get(services, FlowRuntime.FlowRuntime)),
        Effect.provideService(Control.Control, {
          ...control,
          list: (request) =>
            control.list(request).pipe(Effect.tap(() =>
              request._tag === "runs" && request.filters?.status === "parked"
                ? Deferred.succeed(observed, "scanned")
                : Effect.void
            ))
        }),
        Effect.onError((cause) => Deferred.succeed(observed, Cause.pretty(cause)))
      )
    )
    yield* TestDatabase.until(
      Deferred.isDone(observed).pipe(Effect.tap((done) => done ? Effect.void : TestClock.adjust(5_000)))
    )
    const outcome = yield* Deferred.await(observed)
    const sql = Context.get(services, SqlClient)
    const roots = sql<{ readonly runId: string }>`SELECT run_id AS "runId" FROM flows_runs
      WHERE json_extract(state_json, '$.flowName') LIKE 'smithers/health/Discovery%' AND round_ordinal = 0
      ORDER BY run_id`
    if (outcome === "scanned") {
      const runs = Context.get(services, RunStore.RunStore)
      // The fallback also lets the regression run against the unversioned host.
      const parked = runs.lineage(HealthHost.executionId ?? "smithers-health-discovery").pipe(
        Effect.map((lineage) => lineage.some((run) => run.status === "suspended"))
      )
      yield* TestDatabase.until(parked)
      if (Number(advanceMs) > 0) {
        yield* TestClock.adjust(Number(advanceMs))
        yield* TestDatabase.until(parked)
      }
    }
    return { outcome, roots: (yield* roots).map((row) => row.runId) }
  }).pipe(
    Effect.provide(Layer.mergeAll(TestControl.layer(), NodeCrypto.layer)),
    Effect.provide(Logger.layer([])),
    Effect.provide(TestClock.layer()),
    Effect.scoped
  )
)
console.log(JSON.stringify(result))
