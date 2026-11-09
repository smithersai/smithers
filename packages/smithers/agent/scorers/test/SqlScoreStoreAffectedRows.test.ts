import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/sql/SqlClient"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as ScoreStore from "../src/ScoreStore.vibe"
import * as SqlScoreStore from "../src/SqlScoreStore.vibe"

const injected = vi.hoisted(() => ({ affectedRows: undefined as number | undefined }))

vi.mock("@smthrs/database/DurableWriter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@smthrs/database/DurableWriter")>()
  const Effect = await import("effect/Effect")
  return {
    ...actual,
    affectedRows: (result: unknown) =>
      injected.affectedRows === undefined
        ? actual.affectedRows(result)
        : Effect.succeed(injected.affectedRows)
  }
})

const layer = SqlScoreStore.layer.pipe(Layer.provideMerge(TestDatabase.layer))

afterEach(() => {
  injected.affectedRows = undefined
})

describe("SqlScoreStore affected-row invariant", () => {
  it("rolls back when a single-row claim reports more than one affected row", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* ScoreStore.ScoreStore
        const sql = yield* SqlClient.SqlClient
        injected.affectedRows = 2
        const failure = yield* Effect.flip(
          store.recordOnce("impossible-count", {
            kind: "score",
            targetStepKey: "step",
            scorerKey: "scorer",
            score: 1,
            at: 1
          })
        )
        injected.affectedRows = undefined
        const jobs = yield* sql<{ readonly count: number }>`
          SELECT count(*) AS count FROM flows_score_jobs WHERE identity = 'impossible-count'
        `
        const scores = yield* sql<{ readonly count: number }>`
          SELECT count(*) AS count FROM flows_scores WHERE target_step_key = 'step'
        `
        return { failure, jobs: Number(jobs[0]?.count), scores: Number(scores[0]?.count) }
      }).pipe(Effect.provide(layer))
    )

    expect(result.failure).toMatchObject({
      code: "store",
      message: "Could not atomically record scorer job (database: unknown)"
    })
    expect(result.jobs).toBe(0)
    expect(result.scores).toBe(0)
  })
})
