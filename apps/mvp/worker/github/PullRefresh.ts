import { Cause, Clock, type Duration, Effect, type Layer, Metric, Option, Ref } from "effect"
import { SqlClient } from "effect/sql"
import { applyExecutionId, itemId, reconcileBucketStart } from "../../src/features/issues/contract.ts"
import { FlowStarter } from "../Flows.ts"
import { codeOf } from "../ErrorCode.ts"
import { Apply } from "./Apply.ts"
import type { Repository } from "./Config.ts"

export const refreshes = Metric.counter("smithers_pull_refresh_starts", { incremental: true })
export const receipts = Metric.counter("smithers_pull_absence_receipts", { incremental: true })

/** A detail read recovers its subject through the existing durable reader, once per five-minute bucket. */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, configured: boolean, within: Duration.Input) => Effect.gen(function* () {
  const admitted = yield* Ref.make<ReadonlyMap<string, number>>(new Map())
  const start = (repository: Repository, number: number) => Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const key = itemId(repository.id, number)
    if (configured) {
      const bucket = reconcileBucketStart(now)
      if ((yield* Ref.get(admitted)).get(key) !== bucket) {
        const deliveryId = `pull-refresh:${key}:${bucket}`
        const started = yield* (yield* FlowStarter).start(Apply, {
          executionId: applyExecutionId(deliveryId),
          payload: { deliveryId, repo: `${repository.owner}/${repository.name}`, number, event: "pull_request" },
        }).pipe(Effect.timeoutOption(within), Effect.result)
        const outcome = started._tag === "Failure" ? "not_started" : Option.isNone(started.success) ? "timed_out" : "started"
        if (outcome === "started") yield* Ref.update(admitted, (rows) => new Map(rows).set(key, bucket))
        yield* Metric.update(Metric.withAttributes(refreshes, { outcome }), 1)
        yield* Effect.logInfo("pull.refresh.start").pipe(Effect.annotateLogs({ repoId: repository.id, number, outcome,
          ...(started._tag === "Failure" ? { errorCode: codeOf(started.failure) } : {}),
        }))
      }
    }
  }).pipe(Effect.withSpan("pull.refresh.start"))
  const receipt = (repository: Repository, number: number) => Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const key = itemId(repository.id, number)
    const missing = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql`
        SELECT item_id FROM github_projection_fences f
        WHERE f.item_id = ${key} AND f.gone_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM items i WHERE i.id = f.item_id AND i.deleted_at IS NULL AND i.fetched_at > f.gone_at)`
      return rows.length > 0
    }).pipe(Effect.provide(database), Effect.catchCause((cause) => Effect.gen(function* () {
      yield* Effect.logWarning("pull.refresh.receipt").pipe(Effect.annotateLogs({ repoId: repository.id, number, outcome: "unavailable", errorCode: codeOf(Cause.squash(cause)) }))
      return false
    })))
    yield* Metric.update(Metric.withAttributes(receipts, { outcome: missing ? "missing" : "unproven" }), 1)
    yield* Effect.annotateCurrentSpan({ repoId: repository.id, number, missing })
    yield* Effect.logInfo("pull.refresh.receipt").pipe(Effect.annotateLogs({ repoId: repository.id, number, missing }))
    return JSON.stringify({ number, checkedAt: now, missing })
  }).pipe(Effect.withSpan("pull.refresh.receipt"))
  return { start, receipt }
})
