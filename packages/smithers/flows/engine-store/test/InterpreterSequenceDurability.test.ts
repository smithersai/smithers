import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import { Effect, Exit, Layer, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { runPromise } from "./Sha256.ts"

const First = Action.make("durable-sequence/First", { payload: {}, success: Schema.Number, error: Schema.String })
const Later = Action.make("durable-sequence/Later", { payload: {}, success: Schema.String })
const Inline = Flow.make("durable-sequence/Inline", { payload: {}, success: Schema.String, body: () => Later.call({}) })
const Pipeline = Flow.make("durable-sequence/Pipeline", {
  payload: {},
  success: Schema.Struct({ later: Schema.String }),
  error: Schema.String,
  body: () => First.call({}).pipe(Node.andThen(Node.all({ later: Inline.call({}).pipe(Node.map((value) => value)) })))
})
const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "test", changeId: "test" }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

for (const fail of [false, true]) {
  it(`durably respects a nested explicit sequence and replays its ${fail ? "failure" : "success"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-interpreter-sequence-"))
    const events: Array<string> = []
    try {
      for (const phase of ["initial", "reopened"]) {
        const result = await runPromise(
          Effect.scoped(Effect.gen(function*() {
            const engine = yield* EngineStore.make({
              owner: { hostId: `sequence-${phase}` },
              journalSource: "sequence-test",
              isAlive: () => Effect.succeed(false)
            })
            const layer = Layer.mergeAll(
              First.toLayer(() =>
                Effect.gen(function*() {
                  events.push("first:start")
                  for (let turn = 0; turn < 8; turn++) yield* Effect.yieldNow
                  events.push(fail ? "first:failed" : "first:done")
                  if (fail) return yield* Effect.fail("upstream failed")
                  return 1
                })
              ),
              Later.toLayer(() =>
                Effect.sync(() => {
                  events.push("later")
                  return "done"
                })
              ),
              Interpreter.layer(Pipeline)
            ).pipe(
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
            )
            const exit = yield* Pipeline.execute({}, { executionId: "sequence-run" }).pipe(
              Effect.provide(layer),
              Effect.exit
            )
            const runs = yield* RunStore.RunStore
            const row = yield* runs.get("sequence-run")
            const sql = yield* SqlClient.SqlClient
            const attempts = yield* sql<
              { count: number }
            >`SELECT count(*) AS count FROM flows_attempts WHERE run_id = 'sequence-run'`
            return { exit, status: row.status, attempts: attempts[0]!.count }
          })).pipe(
            Effect.provide(jj),
            Effect.provide(StepBoundary.layerTest()),
            Effect.provide(TestStores.layerAt(join(root, "state.sqlite")))
          )
        )
        expect(result.status).toBe(fail ? "failed" : "completed")
        expect(Exit.isFailure(result.exit)).toBe(fail)
        expect(result.attempts).toBe(fail ? 1 : 2)
        expect(events).toEqual(fail ? ["first:start", "first:failed"] : ["first:start", "first:done", "later"])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
