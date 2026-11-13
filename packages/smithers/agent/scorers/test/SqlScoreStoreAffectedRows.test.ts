import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as ScoreStore from "../src/ScoreStore.ts"
import * as SqlScoreStore from "../src/SqlScoreStore.ts"

describe("SqlScoreStore affected-row invariant", () => {
  it("rolls back a contradictory driver count and permits a later retry", async () => {
    let corruptClaim = true
    let claims = 0
    // Execute every statement and transaction on the real database. Only the
    // claim's raw driver receipt is faulty; the writer and row-count decoder
    // remain the production services.
    const faultyClient = Layer.effect(
      SqlClient.SqlClient,
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        return new Proxy(sql, {
          apply(target, receiver, args) {
            const statement = Reflect.apply(target, receiver, args)
            if (!String(args[0]).includes("INSERT INTO flows_score_jobs")) return statement
            return new Proxy(statement, {
              get(target, key, receiver) {
                if (key !== "raw") return Reflect.get(target, key, receiver)
                return target.raw.pipe(Effect.map((result: unknown) => {
                  claims += 1
                  return corruptClaim ? { changes: 2, rowCount: 2 } : result
                }))
              }
            })
          }
        })
      })
    )
    const layer = SqlScoreStore.layer.pipe(
      Layer.provide(faultyClient),
      Layer.provideMerge(TestDatabase.layer)
    )
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* ScoreStore.ScoreStore
        const sql = yield* SqlClient.SqlClient
        const observation: ScoreStore.Observation = {
          kind: "score",
          targetStepKey: "step",
          scorerKey: "scorer",
          score: 1,
          at: 1
        }
        const failure = yield* Effect.flip(store.recordOnce("impossible-count", observation))
        const jobs = yield* sql<{ readonly count: number }>`
          SELECT count(*) AS count FROM flows_score_jobs WHERE identity = 'impossible-count'
        `
        const scores = yield* store.observations("step")
        corruptClaim = false
        const retried = yield* store.recordOnce("impossible-count", observation)
        const duplicate = yield* store.recordOnce("impossible-count", observation)
        const retained = yield* store.observations("step")
        return { failure, jobs: Number(jobs[0]?.count), scores, retried, duplicate, retained }
      }).pipe(Effect.provide(layer))
    )

    expect(claims).toBe(3)
    expect(result.failure).toMatchObject({
      code: "store",
      message: "Could not atomically record scorer job (database: unknown)",
      cause: { code: "unknown", cause: { operation: "claim scorer job", affectedRows: 2 } }
    })
    expect(result.jobs).toBe(0)
    expect(result.scores).toEqual([])
    expect(result.retried).toBe(true)
    expect(result.duplicate).toBe(false)
    expect(result.retained).toMatchObject([{ kind: "score", score: 1, at: 1 }])
  })
})
