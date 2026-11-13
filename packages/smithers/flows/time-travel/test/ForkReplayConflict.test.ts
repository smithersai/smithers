/** Real fork records must converge with the terminal record emitted on replay. */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { EngineStore, StepBoundary } from "@smthrs/engine-store"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import { Journal } from "@smthrs/journal"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { Effect, Layer, Option, Schema } from "effect"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"

const Once = Action.make("ReplayConflict/Once", {
  payload: {},
  success: Schema.String,
  tier: "sealed",
  implementationVersion: "replay-conflict-v1",
  idempotencyKey: "replay-conflict-v1"
})
const ReplayFlow = Flow.make("ReplayConflict/Flow", {
  payload: {},
  success: Schema.String,
  body: (payload) => Once.call(payload)
})

describe("terminal replay convergence over real SQL forks", () => {
  for (const depth of [1, 2]) {
    it.effect(
      depth === 1
        ? "replays through a terminal record a retained fork copied from its parent"
        : "replays through a fork of a fork",
      () =>
        Effect.gen(function*() {
          let executions = 0
          const engine = yield* EngineStore.make({
            owner: { hostId: "replay-conflict" },
            journalSource: "replay-conflict"
          })
          const wiring = Layer.mergeAll(
            Once.toLayer(() =>
              Effect.sync(() => {
                executions++
                return "durable-success"
              }), { implementationVersion: "replay-conflict-v1" }),
            Interpreter.layer(ReplayFlow)
          ).pipe(
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
          )
          const execute = (executionId: string) => ReplayFlow.execute({}, { executionId }).pipe(Effect.provide(wiring))

          const parentRunId = "replay-conflict-parent"
          expect(yield* execute(parentRunId)).toBe("durable-success")
          expect(executions).toBe(1)
          const journal = yield* Journal.Journal
          yield* journal.flush
          const history = yield* journal.entries({ runId: parentRunId as never, limit: 100 })
          const terminal = history.entries.find((entry) => entry.eventType === "flows.engine.attempt-finished")!
          expect(terminal).toBeDefined()
          const { stepKeyDigest, attempt } = terminal.payload as {
            readonly stepKeyDigest: string
            readonly attempt: number
          }
          const store = yield* SqlTimeTravelStore.make
          const attempts = yield* AttemptStore.AttemptStore
          const runs = yield* RunStore.RunStore
          let runId = parentRunId

          for (let generation = 0; generation < depth; generation++) {
            const fork = yield* store.createFork(runId, {
              lineageId: FlowEngine.Lineage.root(parentRunId),
              seq: terminal.seq
            })
            expect((yield* runs.get(fork.runId)).parentRunId).toBe(runId)
            const copied = yield* attempts.get({ runId: fork.runId, stepKeyDigest, attempt })
            expect(Option.isSome(copied) && copied.value.state).toBe("succeeded")
            const childHistory = yield* journal.entries({ runId: fork.runId as never, limit: 100 })
            const copiedTerminal = childHistory.entries.find((entry) =>
              entry.sourceId === terminal.sourceId && entry.sourceSeq === terminal.sourceSeq
            )
            expect(copiedTerminal).toMatchObject({
              payload: terminal.payload,
              meta: terminal.meta
            })
            expect(childHistory.entries.find((entry) => entry.eventType === "flows.time-travel.fork-created"))
              .toMatchObject({
                payload: { childRunId: fork.runId, parentRunId: runId, forkJournalOffset: terminal.seq }
              })
            runId = fork.runId
          }

          expect(yield* execute(runId)).toBe("durable-success")
          expect(executions).toBe(1)
          expect((yield* runs.get(runId)).status).toBe("completed")
          yield* journal.flush
          const replayedHistory = yield* journal.entries({ runId: runId as never, limit: 100 })
          expect(
            replayedHistory.entries.filter((entry) =>
              entry.sourceId === terminal.sourceId && entry.sourceSeq === terminal.sourceSeq
            )
          )
            .toHaveLength(1)
        }).pipe(
          Effect.provide(StepBoundary.layerUnsupported),
          Effect.provide(NodeJj.layer),
          Effect.provide(TestStores.layerAt(":memory:")),
          Effect.scoped,
          Effect.provide(NodeCrypto.layer)
        )
    )
  }
})
