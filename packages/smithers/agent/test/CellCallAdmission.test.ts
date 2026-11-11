import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import * as Cell from "@smthrs/harness/Cell"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as Model from "@smthrs/model/Model"
import { Node } from "@smthrs/plan"
import { Deferred, Effect, Layer, Option, Result, Schema, Scope, Stream } from "effect"
import { expect, it } from "vitest"
import * as FlowEngineLike from "../src/FlowEngineLike.vibe"
import * as Safety from "./Safety.ts"

const flow = Flow.make("agent/test/cell-call-admission", {
  payload: {},
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

it("rejects a mutated host result through the typed failure channel with its cause", async () => {
  const malformed = Object.assign(Cell.CallResult.new({ outcome: "success", value: null }), { code: "timeout" })
  const outcome = await Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const scope = yield* Effect.scope
    const settled = Deferred.makeUnsafe<Result.Result<Cell.CallResult, HarnessError>, unknown>()
    yield* engine.register(flow, () =>
      Effect.gen(function*() {
        const port = yield* FlowEngineLike.make({
          model: Model.make({ stream: () => Stream.empty }),
          route: { prepare: () => Effect.die("no model request expected") },
          layers: ["admission-host"],
          capabilities: {},
          calls: { run: () => Effect.succeed(malformed) }
        })
        return yield* Effect.result(port.call(
          new Cell.Call({
            flowName: "probe",
            input: null,
            capabilities: [],
            effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
            placement: Option.none(),
            identity: new Cell.CallIdentity({
              session: "admission-session",
              frame: 0,
              cell: "cell",
              ordinal: 0,
              declaration: "probe-v1",
              layers: []
            })
          })
        ))
      }).pipe(Effect.exit, Effect.flatMap((exit) => Deferred.done(settled, exit)))).pipe(Scope.provide(scope))
    yield* engine.execute(flow, { executionId: "admission-run", payload: {}, discard: true })
    return yield* Deferred.await(settled)
  }).pipe(
    Effect.provide(Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer, Safety.layer)),
    Effect.scoped,
    Effect.runPromise
  )
  expect(Result.isFailure(outcome)).toBe(true)
  if (Result.isFailure(outcome)) {
    expect(outcome.failure).toBeInstanceOf(HarnessError)
    expect(outcome.failure.code).toBe("engine_failed")
    expect(outcome.failure.cause).toBeDefined()
  }
})
