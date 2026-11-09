import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { NodeRuntime } from "@smthrs/platform-node"
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import * as ScoreStore from "../src/ScoreStore.ts"
import * as Scoring from "../src/Scoring.vibe"
import * as SqlScoreStore from "../src/SqlScoreStore.vibe"

const Grade = Action.make("scorers-test/Grade", {
  payload: {},
  success: Schema.Void,
  implementationVersion: "grade/v1",
  idempotencyKey: "grade-job"
})
const GradeFlow = Flow.make("scorers-test/GradeFlow", {
  payload: {},
  success: Schema.Void,
  body: Node.capture({ action: Grade.name }, () => Grade.call({}))
})

it("resumes an accepted scoring job after runtime disposal and records it exactly once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-scoring-"))
  const filename = join(directory, "engine.sqlite")
  const started = Deferred.makeUnsafe<void>()
  let interrupted = true
  let completed = 0
  const implementation = Grade.toLayer(() =>
    Effect.gen(function*() {
      yield* Scoring.runBatch([{
        identity: Scoring.jobIdentity(["execution", "grade-job"]),
        observation: { targetStepKey: "target", scorerKey: "scorer" },
        at: 1,
        score: Effect.gen(function*() {
          yield* Deferred.succeed(started, undefined)
          if (interrupted) return yield* Effect.never
          completed += 1
          return { score: 1 }
        })
      }])
    }), { implementationVersion: "grade/v1" }).pipe(
      Layer.provide(SqlScoreStore.layer)
    )
  const host = () =>
    NodeRuntime.layerHost({
      filename,
      workspaceRoot: directory,
      owner: { hostId: "scorers-recovery" }
    }, Interpreter.layerWithImplementations(GradeFlow, implementation))
  const before = ManagedRuntime.make(host())
  try {
    const execution = before.runFork(GradeFlow.execute({}, { executionId: "score-run" }))
    await Effect.runPromise(Deferred.await(started))
    await before.dispose()
    await Effect.runPromise(Fiber.await(execution))
    interrupted = false
    const after = ManagedRuntime.make(host())
    try {
      await after.runPromise(GradeFlow.execute({}, { executionId: "score-run" }))
      await after.runPromise(GradeFlow.execute({}, { executionId: "score-run" }))
      const observations = await Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* ScoreStore.ScoreStore
          return yield* store.observations("target", "scorer")
        }).pipe(
          Effect.provide(SqlScoreStore.layer),
          Effect.provide(DurableWriter.layer().pipe(Layer.provideMerge(NodeDatabase.layer({ filename })))),
          Effect.scoped
        )
      )
      expect(observations).toHaveLength(1)
      expect(observations[0]).toMatchObject({ kind: "score", score: 1 })
      expect(completed).toBe(1)
    } finally {
      await after.dispose()
    }
  } finally {
    await before.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
