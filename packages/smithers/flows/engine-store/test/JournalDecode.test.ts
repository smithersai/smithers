/** Corrupt persisted envelopes fail the caller immediately, with safe host diagnostics. */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, Interpreter, JournalDecode } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Layer, Logger, Metric, References, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"
const flow = Flow.make("journal-decode/flow", { payload: {}, success: Schema.Null, body: () => Node.succeed(null) })
const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.die("unexpected workspace snapshot"),
    restore: () => Effect.die("unexpected workspace restore"),
    diff: () => Effect.die("unexpected workspace diff"),
    workspaceAdd: () => Effect.die("unexpected workspace add"),
    workspaceForget: () => Effect.die("unexpected workspace forget"),
    status: () => Effect.die("unexpected workspace status")
  })
)
describe("undecodable persisted run state", () => {
  it.live.each(["state", "outcome"] as const)(
    "fails %s decoding fast, counts it, and logs only step and host identity",
    (boundary) =>
      withCrypto(Effect.scoped(
        Effect.gen(function*() {
          const diagnostics: Array<Readonly<Record<string, unknown>>> = []
          const capture = Logger.make((options) => {
            diagnostics.push(options.fiber.getRef(References.CurrentLogAnnotations))
          })
          const engine = yield* EngineStore.make({ owner: { hostId: "decode-object" }, journalSource: "decode" })
          yield* Effect.gen(function*() {
            yield* engine.execute(flow, { executionId: "decode-run", payload: {} })
            const sql = yield* SqlClient.SqlClient
            const original = yield* sql<
              { state_json: string }
            >`SELECT state_json FROM flows_runs WHERE run_id = 'decode-run'`
            const state = boundary === "state"
              ? { version: 999, private: "stored-secret" }
              : {
                ...JSON.parse(original[0]!.state_json),
                result: { _tag: "Complete", exit: { _tag: "Success", value: "stored-secret" } }
              }
            yield* sql`UPDATE flows_runs SET state_json = ${JSON.stringify(state)} WHERE run_id = 'decode-run'`
            const stepTag = boundary === "state" ? "@smthrs/engine-store/run-state" : flow._tag
            const metric = Metric.withAttributes(JournalDecode.failures, { stepTag, boundary })
            const before = (yield* Metric.value(metric)).count
            const operation = Effect.gen(function*() {
              if (boundary === "state") return yield* engine.execute(flow, { executionId: "decode-run", payload: {} })
              return yield* engine.poll(flow, "decode-run")
            })
            const result = yield* Effect.exit(operation.pipe(Effect.timeout("1 second")))
            expect(Exit.isFailure(result) && Cause.squash(result.cause)).toMatchObject({
              _tag: "JournalDecodeError",
              stepTag,
              objectId: "decode-object",
              codeVersion: "old-build"
            })
            expect((yield* Metric.value(metric)).count - before).toBe(1)
            expect(diagnostics).toContainEqual(
              expect.objectContaining({
                stepTag,
                objectId: "decode-object",
                codeVersion: "old-build"
              })
            )
            expect(JSON.stringify(diagnostics)).not.toContain("stored-secret")
          }).pipe(
            Effect.provide(
              Interpreter.layer(flow).pipe(
                Layer.provide(Action.layerImplementations),
                Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
              )
            ),
            Effect.provide(Logger.layer([capture])),
            Effect.provideService(JournalDecode.Identity, { objectId: "decode-object", codeVersion: "old-build" })
          )
        }).pipe(
          Effect.provide(TestStores.layerAt(":memory:")),
          Effect.provide(StepBoundary.layerUnsupported),
          Effect.provide(jj)
        )
      ))
  )
})
