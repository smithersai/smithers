/** Exact native observations scoped to one authorized control root.
 * @since 1.0.0
 */

import { PersistenceError } from "@smthrs/control/ControlError"
import type { ExecutionBatch } from "@smthrs/control/ControlSchema"
import type * as Snapshot from "@smthrs/engine-store/ExecutionSnapshot"
import * as ExecutionSnapshot from "@smthrs/engine-store/ExecutionSnapshot"
import { ExecutionFact, Redaction } from "@smthrs/journal"
import { Effect, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"

/** One transaction holds the batch and all ancestry reads at the same source revision.
 * @since 1.0.0
 * @private
 */
export const makeFromSql = () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const read = make(yield* ExecutionSnapshot.make())
    return (input: { readonly runId: string; readonly executionIds: ReadonlyArray<string> }) =>
      ExecutionSnapshot.withReadTransaction(sql, read(input)).pipe(Effect.mapError((cause) =>
        cause instanceof PersistenceError ? cause : new PersistenceError({
          operation: "NativeExecutionRead",
          message: "Cannot observe native executions",
          cause
        })
      ))
  })

/** Parent links are immutable. Bound every ancestry walk and refuse incomplete/cyclic evidence.
 * @since 1.0.0
 * @private
 */
export const make = (snapshots: Pick<Snapshot.Service, "read">) =>
(
  input: { readonly runId: string; readonly executionIds: ReadonlyArray<string> }
): Effect.Effect<ExecutionBatch, PersistenceError> =>
  Effect.gen(function*() {
    const batch = yield* snapshots.read(input.executionIds)
    const known = new Map(batch.snapshots.map((row) => [row.runId, row]))
    const read = (id: string) =>
      Effect.gen(function*() {
        const cached = known.get(id)
        if (cached !== undefined) return cached
        const ancestor = yield* snapshots.read([id])
        if (ancestor.source !== batch.source || ancestor.revision !== batch.revision) {
          return yield* new PersistenceError({
            operation: "NativeExecutionRead",
            message: "Native execution source changed during ancestry observation",
            cause: undefined
          })
        }
        const row = ancestor.snapshots[0]!
        known.set(id, row)
        return row
      })
    const belongs = (initial: Snapshot.Snapshot) =>
      Effect.gen(function*() {
        let current = initial
        const visited = new Set<string>()
        for (let depth = 0; depth < 128; depth++) {
          if (current.runId === input.runId) {
            return current._tag === "Observed" || visited.size === 0
              ? "inside" as const :
              "ancestry-unavailable" as const
          }
          if (visited.has(current.runId) || current._tag !== "Observed") return "ancestry-unavailable" as const
          visited.add(current.runId)
          if (current.parentRunId !== null) {
            current = yield* read(current.parentRunId)
            continue
          }
          // A parentless trampoline round names its original execution as its
          // lineage root. Verify that root row instead of trusting the name.
          if (current.lineageId === input.runId && current.roundOrdinal > 0) {
            const root = yield* read(input.runId)
            return root._tag === "Observed" && root.lineageId === input.runId
              ? "inside" as const :
              "ancestry-unavailable" as const
          }
          return "outside-run" as const
        }
        return "ancestry-unavailable" as const
      })
    const observations = yield* Effect.forEach(batch.snapshots, (row) =>
      Effect.gen(function*() {
        const scope = yield* belongs(row)
        if (scope !== "inside") {
          return {
            _tag: "Unavailable" as const,
            executionId: row.runId,
            reason: scope
          }
        }
        if (row._tag === "Missing") {
          return {
            _tag: "Missing" as const,
            executionId: row.runId,
            source: row.source,
            revision: row.revision,
            deleted: row.deleted
          }
        }
        const observation = yield* Schema.decodeUnknownEffect(ExecutionFact.Observation)({
          executionId: row.runId,
          flowName: row.flowName,
          status: row.status,
          createdAtMs: row.createdAtMs,
          startedAtMs: row.startedAtMs,
          finishedAtMs: row.finishedAtMs,
          parentRunId: row.parentRunId,
          lineageId: row.lineageId,
          roundOrdinal: row.roundOrdinal,
          cancelRequestedAtMs: row.cancellation.requestedAtMs,
          waiting: row.waiting === null ? null : {
            ...row.waiting,
            ...(row.waiting.request === undefined ? {} : { request: Redaction.redact(row.waiting.request) })
          }
        })
        return {
          _tag: "Observed" as const,
          executionId: row.runId,
          source: row.source,
          revision: row.revision,
          observation
        }
      }))
    return { source: batch.source, revision: batch.revision, snapshots: observations }
  }).pipe(Effect.mapError((cause) =>
    cause instanceof PersistenceError ? cause : new PersistenceError({
      operation: "NativeExecutionRead",
      message: "Cannot observe native executions",
      cause
    })
  ))

/** Resolve immutable native ancestry without reading state or result payloads.
 * All branches must resolve to one visible control root; cycles, missing rows,
 * ambiguity and traversal exhaustion refuse correlation. No authority is granted.
 * @category queries
 * @since 1.0.0
 */
export const controlRunId = (
  executionId: string,
  isControlRun: (id: string) => Effect.Effect<boolean, unknown>
) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    return yield* ExecutionSnapshot.withReadTransaction(
      sql,
      Effect.gen(function*() {
        const roots = new Set<string>()
        const resolved = new Set<string>()
        const visiting = new Set<string>()
        let count = 0
        const visit = (id: string): Effect.Effect<boolean, unknown> =>
          Effect.gen(function*() {
            if (visiting.has(id)) return false
            if (resolved.has(id)) return true
            if (++count > 128) return false
            if (yield* isControlRun(id)) {
              roots.add(id)
              resolved.add(id)
              return roots.size === 1
            }
            const rows = yield* sql<{ parent: string | null; lineage: string | null; round: number }>`
        SELECT parent_run_id AS parent, lineage_id AS lineage, round_ordinal AS round
        FROM flows_runs WHERE run_id = ${id}
      `
            const row = rows[0]
            if (row === undefined) return false
            const edges = yield* sql<{ parent: string }>`
        SELECT parent_id AS parent FROM flows_run_parents WHERE child_id = ${id} LIMIT 129
      `
            if (edges.length > 128) return false
            const parents = new Set(edges.map((edge) => edge.parent))
            if (row.parent !== null) parents.add(row.parent)
            if (parents.size === 0 && row.round > 0 && row.lineage !== null && row.lineage !== id) {
              parents.add(row.lineage)
            }
            if (parents.size === 0) return false
            visiting.add(id)
            for (const parent of parents) if (!(yield* visit(parent))) return false
            visiting.delete(id)
            resolved.add(id)
            return true
          })
        return (yield* visit(executionId)) && roots.size === 1 ? [...roots][0] : undefined
      })
    )
  }).pipe(Effect.mapError((cause) =>
    cause instanceof PersistenceError ? cause : new PersistenceError({
      operation: "resolve control run",
      message: "Cannot resolve native execution ancestry",
      cause
    })
  ))
