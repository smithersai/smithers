import { expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Flow } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const flow = Flow.make("DiagnosticReplay/Flow", {
  payload: {},
  success: Schema.String,
  error: Schema.String,
  body: opaqueHandlerBody
})
const refusedWorkspace = () => Effect.die(new Error("diagnostic replay must not touch a workspace"))
const jj = Jj.make({
  snapshot: refusedWorkspace,
  restore: refusedWorkspace,
  diff: refusedWorkspace,
  workspaceAdd: refusedWorkspace,
  workspaceForget: refusedWorkspace,
  status: refusedWorkspace
})
const makeEngine = EngineStore.make({ owner: { hostId: "diagnostic-replay" }, journalSource: "diagnostic-replay" })

it.live("restores the execution coordinate omitted by a legacy primary failure", () =>
  withCrypto(Effect.scoped(
    Effect.gen(function*() {
      const engine = yield* makeEngine
      yield* engine.register(flow, () => Effect.fail("refused"))
      const runId = "legacy-diagnostic"
      const first = yield* engine.execute(flow, { executionId: runId, payload: {} }).pipe(Effect.exit)
      expect(Exit.isFailure(first)).toBe(true)
      const runs = yield* RunStore.RunStore
      const row = yield* runs.get(runId)
      expect(row.status).toBe("failed")
      const state = JSON.parse(row.stateJson)
      expect(state.failure.executionId).toBe(runId)
      delete state.failure.executionId
      delete state.failureSites
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE flows_runs SET state_json = ${JSON.stringify(state)} WHERE run_id = ${runId}`
      const reopened = yield* makeEngine
      yield* reopened.register(flow, () => Effect.die("replay must not dispatch"))
      const replay = yield* reopened.execute(flow, { executionId: runId, payload: {} }).pipe(Effect.exit)
      expect(Exit.isFailure(replay)).toBe(true)
      if (Exit.isFailure(replay)) {
        expect(Cause.squash(replay.cause)).toBe("refused")
        expect(Context.getOrUndefined(Cause.reasonAnnotations(replay.cause.reasons[0]!), FlowEngine.FailureSite))
          .toMatchObject({ executionId: runId })
      }
    }).pipe(
      Effect.provideService(Jj.Jj, jj),
      Effect.provideService(DurableEngineState.DurableEngineState, DurableEngineState.makeMemory()),
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.matrixLayer())
    )
  )))
