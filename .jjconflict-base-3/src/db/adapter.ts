import { and, desc, eq, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Effect, Metric } from "effect";
import { fromPromise, fromSync } from "../effect/interop";
import { runPromise } from "../effect/runtime";
import { dbQueryDuration } from "../effect/metrics";
import type { SmithersError } from "../utils/errors";
import {
  smithersRuns,
  smithersNodes,
  smithersAttempts,
  smithersFrames,
  smithersApprovals,
  smithersCache,
  smithersToolCalls,
  smithersEvents,
  smithersRalph,
  smithersCron,
  smithersScorers,
  smithersVectors,
} from "./internal-schema";
import { withSqliteWriteRetryEffect } from "./write-retry";

export class SmithersDb {
  constructor(private db: BunSQLiteDatabase<any>) {}

  rawQueryEffect(queryString: string) {
    return this.readEffect(`raw query ${queryString.slice(0, 20)}`, () => {
      const client = (this.db as any).session.client;
      const stmt = client.query(queryString);
      return Promise.resolve(stmt.all());
    });
  }

  rawQuery(queryString: string) {
    return runPromise(this.rawQueryEffect(queryString));
  }

  private readEffect<A>(
    label: string,
    operation: () => PromiseLike<A>,
  ): Effect.Effect<A, SmithersError> {
    return Effect.gen(function* () {
      const start = performance.now();
      const result = yield* fromPromise(label, operation, {
        code: "DB_QUERY_FAILED",
        details: { operation: label },
      });
      yield* Metric.update(dbQueryDuration, performance.now() - start);
      return result;
    }).pipe(
      Effect.annotateLogs({ dbOperation: label }),
      Effect.withLogSpan(`db:${label}`),
    );
  }

  private writeEffect<A>(
    label: string,
    operation: () => PromiseLike<A>,
  ): Effect.Effect<A, SmithersError> {
    return Effect.gen(function* () {
      const start = performance.now();
      const result = yield* withSqliteWriteRetryEffect(
        () =>
          fromPromise(label, operation, {
            code: "DB_WRITE_FAILED",
            details: { operation: label },
          }),
        { label },
      );
      yield* Metric.update(dbQueryDuration, performance.now() - start);
      return result;
    }).pipe(
      Effect.annotateLogs({ dbOperation: label }),
      Effect.withLogSpan(`db:${label}`),
    );
  }

  insertRunEffect(row: any) {
    return this.writeEffect("insert run", () =>
      this.db.insert(smithersRuns).values(row).onConflictDoNothing(),
    );
  }

  insertRun(row: any) {
    return runPromise(this.insertRunEffect(row));
  }

  updateRunEffect(runId: string, patch: any) {
    return this.writeEffect(`update run ${runId}`, () =>
      this.db
        .update(smithersRuns)
        .set(patch)
        .where(eq(smithersRuns.runId, runId)),
    );
  }

  updateRun(runId: string, patch: any) {
    return runPromise(this.updateRunEffect(runId, patch));
  }

  heartbeatRunEffect(
    runId: string,
    runtimeOwnerId: string,
    heartbeatAtMs: number,
  ) {
    return this.writeEffect(`heartbeat run ${runId}`, () =>
      this.db
        .update(smithersRuns)
        .set({ heartbeatAtMs })
        .where(
          and(
            eq(smithersRuns.runId, runId),
            eq(smithersRuns.runtimeOwnerId, runtimeOwnerId),
          ),
        ),
    );
  }

  heartbeatRun(runId: string, runtimeOwnerId: string, heartbeatAtMs: number) {
    return runPromise(
      this.heartbeatRunEffect(runId, runtimeOwnerId, heartbeatAtMs),
    );
  }

  requestRunCancelEffect(runId: string, cancelRequestedAtMs: number) {
    return this.writeEffect(`cancel run ${runId}`, () =>
      this.db
        .update(smithersRuns)
        .set({ cancelRequestedAtMs })
        .where(eq(smithersRuns.runId, runId)),
    );
  }

  requestRunCancel(runId: string, cancelRequestedAtMs: number) {
    return runPromise(this.requestRunCancelEffect(runId, cancelRequestedAtMs));
  }

  requestRunHijackEffect(
    runId: string,
    hijackRequestedAtMs: number,
    hijackTarget?: string | null,
  ) {
    return this.writeEffect(`hijack run ${runId}`, () =>
      this.db
        .update(smithersRuns)
        .set({
          hijackRequestedAtMs,
          hijackTarget: hijackTarget ?? null,
        })
        .where(eq(smithersRuns.runId, runId)),
    );
  }

  requestRunHijack(
    runId: string,
    hijackRequestedAtMs: number,
    hijackTarget?: string | null,
  ) {
    return runPromise(
      this.requestRunHijackEffect(runId, hijackRequestedAtMs, hijackTarget),
    );
  }

  clearRunHijackEffect(runId: string) {
    return this.writeEffect(`clear hijack run ${runId}`, () =>
      this.db
        .update(smithersRuns)
        .set({
          hijackRequestedAtMs: null,
          hijackTarget: null,
        })
        .where(eq(smithersRuns.runId, runId)),
    );
  }

  clearRunHijack(runId: string) {
    return runPromise(this.clearRunHijackEffect(runId));
  }

  getRunEffect(runId: string) {
    return this.readEffect(`get run ${runId}`, () =>
      this.db
        .select()
        .from(smithersRuns)
        .where(eq(smithersRuns.runId, runId))
        .limit(1),
    ).pipe(Effect.map((rows) => rows[0]));
  }

  getRun(runId: string) {
    return runPromise(this.getRunEffect(runId));
  }

  listRunsEffect(limit = 50, status?: string) {
    const where = status ? eq(smithersRuns.status, status) : undefined;
    return this.readEffect(`list runs ${status ?? "all"}`, () => {
      const query = this.db
        .select()
        .from(smithersRuns)
        .orderBy(desc(smithersRuns.createdAtMs))
        .limit(limit);
      if (where) {
        return query.where(where);
      }
      return query;
    });
  }

  listRuns(limit = 50, status?: string) {
    return runPromise(this.listRunsEffect(limit, status));
  }

  insertNodeEffect(row: any) {
    return this.writeEffect(`insert node ${row.nodeId}`, () =>
      this.db
        .insert(smithersNodes)
        .values(row)
        .onConflictDoUpdate({
          target: [
            smithersNodes.runId,
            smithersNodes.nodeId,
            smithersNodes.iteration,
          ],
          set: row,
        }),
    );
  }

  insertNode(row: any) {
    return runPromise(this.insertNodeEffect(row));
  }

  getNodeEffect(runId: string, nodeId: string, iteration: number) {
    return this.readEffect(`get node ${nodeId}`, () =>
      this.db
        .select()
        .from(smithersNodes)
        .where(
          and(
            eq(smithersNodes.runId, runId),
            eq(smithersNodes.nodeId, nodeId),
            eq(smithersNodes.iteration, iteration),
          ),
        )
        .limit(1),
    ).pipe(Effect.map((rows) => rows[0]));
  }

  getNode(runId: string, nodeId: string, iteration: number) {
    return runPromise(this.getNodeEffect(runId, nodeId, iteration));
  }

  listNodesEffect(runId: string) {
    return this.readEffect(`list nodes ${runId}`, () =>
      this.db
        .select()
        .from(smithersNodes)
        .where(eq(smithersNodes.runId, runId)),
    );
  }

  listNodes(runId: string) {
    return runPromise(this.listNodesEffect(runId));
  }

  getRawNodeOutputEffect(tableName: string, runId: string, nodeId: string) {
    return this.readEffect(`get raw node output ${tableName}`, () => {
      const query = sql.raw(`SELECT * FROM "${tableName}" WHERE run_id = '${runId}' AND node_id = '${nodeId}' ORDER BY iteration DESC LIMIT 1`);
      const res = this.db.get(query);
      return Promise.resolve(res ?? null);
    }).pipe(
      Effect.catchAll(() => Effect.succeed(null))
    );
  }

  getRawNodeOutput(tableName: string, runId: string, nodeId: string) {
    return runPromise(this.getRawNodeOutputEffect(tableName, runId, nodeId));
  }

  insertAttemptEffect(row: any) {
    return this.writeEffect(`insert attempt ${row.nodeId}#${row.attempt}`, () =>
      this.db.insert(smithersAttempts).values(row).onConflictDoUpdate({
        target: [
          smithersAttempts.runId,
          smithersAttempts.nodeId,
          smithersAttempts.iteration,
          smithersAttempts.attempt,
        ],
        set: row,
      }),
    );
  }

  insertAttempt(row: any) {
    return runPromise(this.insertAttemptEffect(row));
  }

  updateAttemptEffect(
    runId: string,
    nodeId: string,
    iteration: number,
    attempt: number,
    patch: any,
  ) {
    return this.writeEffect(`update attempt ${nodeId}#${attempt}`, () =>
      this.db
        .update(smithersAttempts)
        .set(patch)
        .where(
          and(
            eq(smithersAttempts.runId, runId),
            eq(smithersAttempts.nodeId, nodeId),
            eq(smithersAttempts.iteration, iteration),
            eq(smithersAttempts.attempt, attempt),
          ),
        ),
    );
  }

  updateAttempt(
    runId: string,
    nodeId: string,
    iteration: number,
    attempt: number,
    patch: any,
  ) {
    return runPromise(
      this.updateAttemptEffect(runId, nodeId, iteration, attempt, patch),
    );
  }

  listAttemptsEffect(runId: string, nodeId: string, iteration: number) {
    return this.readEffect(`list attempts ${nodeId}`, () =>
      this.db
        .select()
        .from(smithersAttempts)
        .where(
          and(
            eq(smithersAttempts.runId, runId),
            eq(smithersAttempts.nodeId, nodeId),
            eq(smithersAttempts.iteration, iteration),
          ),
        )
        .orderBy(desc(smithersAttempts.attempt)),
    );
  }

  listAttempts(runId: string, nodeId: string, iteration: number) {
    return runPromise(this.listAttemptsEffect(runId, nodeId, iteration));
  }

  listAttemptsForRunEffect(runId: string) {
    return this.readEffect(`list attempts for run ${runId}`, () =>
      this.db
        .select()
        .from(smithersAttempts)
        .where(eq(smithersAttempts.runId, runId))
        .orderBy(
          smithersAttempts.startedAtMs,
          smithersAttempts.nodeId,
          smithersAttempts.iteration,
          smithersAttempts.attempt,
        ),
    );
  }

  listAttemptsForRun(runId: string) {
    return runPromise(this.listAttemptsForRunEffect(runId));
  }

  getAttemptEffect(
    runId: string,
    nodeId: string,
    iteration: number,
    attempt: number,
  ) {
    return this.readEffect(`get attempt ${nodeId}#${attempt}`, () =>
      this.db
        .select()
        .from(smithersAttempts)
        .where(
          and(
            eq(smithersAttempts.runId, runId),
            eq(smithersAttempts.nodeId, nodeId),
            eq(smithersAttempts.iteration, iteration),
            eq(smithersAttempts.attempt, attempt),
          ),
        )
        .limit(1),
    ).pipe(Effect.map((rows) => rows[0]));
  }

  getAttempt(runId: string, nodeId: string, iteration: number, attempt: number) {
    return runPromise(this.getAttemptEffect(runId, nodeId, iteration, attempt));
  }

  listInProgressAttemptsEffect(runId: string) {
    return this.readEffect(`list in-progress attempts ${runId}`, () =>
      this.db
        .select()
        .from(smithersAttempts)
        .where(
          and(
            eq(smithersAttempts.runId, runId),
            eq(smithersAttempts.state, "in-progress"),
          ),
        ),
    );
  }

  listInProgressAttempts(runId: string) {
    return runPromise(this.listInProgressAttemptsEffect(runId));
  }

  listAllInProgressAttemptsEffect() {
    return this.readEffect("list all in-progress attempts", () =>
      this.db
        .select()
        .from(smithersAttempts)
        .where(eq(smithersAttempts.state, "in-progress")),
    );
  }

  listAllInProgressAttempts() {
    return runPromise(this.listAllInProgressAttemptsEffect());
  }

  insertFrameEffect(row: any) {
    return this.writeEffect(`insert frame ${row.frameNo}`, () =>
      this.db
        .insert(smithersFrames)
        .values(row)
        .onConflictDoUpdate({
          target: [smithersFrames.runId, smithersFrames.frameNo],
          set: row,
        }),
    );
  }

  insertFrame(row: any) {
    return runPromise(this.insertFrameEffect(row));
  }

  getLastFrameEffect(runId: string) {
    return this.readEffect(`get last frame ${runId}`, () =>
      this.db
        .select()
        .from(smithersFrames)
        .where(eq(smithersFrames.runId, runId))
        .orderBy(desc(smithersFrames.frameNo))
        .limit(1),
    ).pipe(Effect.map((rows) => rows[0]));
  }

  getLastFrame(runId: string) {
    return runPromise(this.getLastFrameEffect(runId));
  }


  insertOrUpdateApprovalEffect(row: any) {
    return this.writeEffect(`upsert approval ${row.nodeId}`, () =>
      this.db
        .insert(smithersApprovals)
        .values(row)
        .onConflictDoUpdate({
          target: [
            smithersApprovals.runId,
            smithersApprovals.nodeId,
            smithersApprovals.iteration,
          ],
          set: row,
        }),
    );
  }

  insertOrUpdateApproval(row: any) {
    return runPromise(this.insertOrUpdateApprovalEffect(row));
  }

  getApprovalEffect(runId: string, nodeId: string, iteration: number) {
    return this.readEffect(`get approval ${nodeId}`, () =>
      this.db
        .select()
        .from(smithersApprovals)
        .where(
          and(
            eq(smithersApprovals.runId, runId),
            eq(smithersApprovals.nodeId, nodeId),
            eq(smithersApprovals.iteration, iteration),
          ),
        )
        .limit(1),
    ).pipe(Effect.map((rows) => rows[0]));
  }

  getApproval(runId: string, nodeId: string, iteration: number) {
    return runPromise(this.getApprovalEffect(runId, nodeId, iteration));
  }

  insertToolCallEffect(row: any) {
    return this.writeEffect(`insert tool call ${row.toolName}`, () =>
      this.db.insert(smithersToolCalls).values(row).onConflictDoNothing(),
    );
  }

  insertToolCall(row: any) {
    return runPromise(this.insertToolCallEffect(row));
  }

  insertEventEffect(row: any) {
    return this.writeEffect(`insert event ${row.type}`, () =>
      this.db.insert(smithersEvents).values(row).onConflictDoNothing(),
    );
  }

  insertEvent(row: any) {
    return runPromise(this.insertEventEffect(row));
  }

  insertEventWithNextSeqEffect(row: {
    runId: string;
    timestampMs: number;
    type: string;
    payloadJson: string;
  }) {
    const label = `insert event ${row.type}`;
    const self = this;
    return withSqliteWriteRetryEffect(
      () =>
        Effect.gen(function* () {
          const existing = yield* self.readEffect(label, () =>
            self.db
              .select({ seq: smithersEvents.seq })
              .from(smithersEvents)
              .where(
                and(
                  eq(smithersEvents.runId, row.runId),
                  eq(smithersEvents.timestampMs, row.timestampMs),
                  eq(smithersEvents.type, row.type),
                  eq(smithersEvents.payloadJson, row.payloadJson),
                ),
              )
              .orderBy(desc(smithersEvents.seq))
              .limit(1),
          );
          if (existing[0]?.seq !== undefined) {
            return existing[0].seq as number;
          }

          const client = (self.db as any).$client;
          if (
            !client ||
            typeof client.exec !== "function" ||
            typeof client.query !== "function"
          ) {
            const lastSeq = (yield* self.getLastEventSeqEffect(row.runId)) ?? -1;
            const seq = lastSeq + 1;
            yield* fromPromise("insert fallback event row", () =>
              self.db
                .insert(smithersEvents)
                .values({ ...row, seq })
                .onConflictDoNothing(),
            );
            return seq;
          }

          return yield* fromSync("insert event transaction", () => {
            client.run("BEGIN IMMEDIATE");
            try {
              const res = client
                .query(
                  "SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM _smithers_events WHERE run_id = ?",
                )
                .get(row.runId);
              const seq = Number(res?.seq ?? 0);
              client
                .query(
                  "INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json) VALUES (?, ?, ?, ?, ?)",
                )
                .run(row.runId, seq, row.timestampMs, row.type, row.payloadJson);
              client.run("COMMIT");
              return seq;
            } catch (error) {
              try {
                client.run("ROLLBACK");
              } catch {
                // ignore rollback failures
              }
              throw error;
            }
          });
        }),
      { label },
    ).pipe(
      Effect.annotateLogs({ dbOperation: label }),
      Effect.withLogSpan(`db:${label}`),
    );
  }

  insertEventWithNextSeq(row: {
    runId: string;
    timestampMs: number;
    type: string;
    payloadJson: string;
  }) {
    return runPromise(this.insertEventWithNextSeqEffect(row));
  }

  getLastEventSeqEffect(runId: string) {
    return this.readEffect(`get last event seq ${runId}`, () =>
      this.db
        .select()
        .from(smithersEvents)
        .where(eq(smithersEvents.runId, runId))
        .orderBy(desc(smithersEvents.seq))
        .limit(1),
    ).pipe(Effect.map((rows) => rows[0]?.seq as number | undefined));
  }

  getLastEventSeq(runId: string) {
    return runPromise(this.getLastEventSeqEffect(runId));
  }

  listEventsEffect(runId: string, afterSeq: number, limit = 200) {
    return this.readEffect(`list events ${runId}`, () =>
      this.db
        .select()
        .from(smithersEvents)
        .where(
          and(
            eq(smithersEvents.runId, runId),
            sql`${smithersEvents.seq} > ${afterSeq}`,
          ),
        )
        .orderBy(smithersEvents.seq)
        .limit(limit),
    );
  }

  listEvents(runId: string, afterSeq: number, limit = 200) {
    return runPromise(this.listEventsEffect(runId, afterSeq, limit));
  }

  insertOrUpdateRalphEffect(row: any) {
    return this.writeEffect(`upsert ralph ${row.ralphId}`, () =>
      this.db
        .insert(smithersRalph)
        .values(row)
        .onConflictDoUpdate({
          target: [smithersRalph.runId, smithersRalph.ralphId],
          set: row,
        }),
    );
  }

  insertOrUpdateRalph(row: any) {
    return runPromise(this.insertOrUpdateRalphEffect(row));
  }

  listRalphEffect(runId: string) {
    return this.readEffect(`list ralph ${runId}`, () =>
      this.db
        .select()
        .from(smithersRalph)
        .where(eq(smithersRalph.runId, runId)),
    );
  }

  listRalph(runId: string) {
    return runPromise(this.listRalphEffect(runId));
  }

  listPendingApprovalsEffect(runId: string) {
    return this.readEffect(`list pending approvals ${runId}`, () =>
      this.db
        .select()
        .from(smithersApprovals)
        .where(
          and(
            eq(smithersApprovals.runId, runId),
            eq(smithersApprovals.status, "requested"),
          ),
        ),
    );
  }

  listPendingApprovals(runId: string) {
    return runPromise(this.listPendingApprovalsEffect(runId));
  }

  getRalphEffect(runId: string, ralphId: string) {
    return this.readEffect(`get ralph ${ralphId}`, () =>
      this.db
        .select()
        .from(smithersRalph)
        .where(
          and(eq(smithersRalph.runId, runId), eq(smithersRalph.ralphId, ralphId)),
        )
        .limit(1),
    ).pipe(Effect.map((rows) => rows[0]));
  }

  getRalph(runId: string, ralphId: string) {
    return runPromise(this.getRalphEffect(runId, ralphId));
  }

  insertCacheEffect(row: any) {
    return this.writeEffect(`insert cache ${row.cacheKey}`, () =>
      this.db.insert(smithersCache).values(row).onConflictDoNothing(),
    );
  }

  insertCache(row: any) {
    return runPromise(this.insertCacheEffect(row));
  }

  getCacheEffect(cacheKey: string) {
    return this.readEffect(`get cache ${cacheKey}`, () =>
      this.db
        .select()
        .from(smithersCache)
        .where(eq(smithersCache.cacheKey, cacheKey))
        .limit(1),
    ).pipe(Effect.map((rows) => rows[0]));
  }

  getCache(cacheKey: string) {
    return runPromise(this.getCacheEffect(cacheKey));
  }

  deleteFramesAfterEffect(runId: string, frameNo: number) {
    return this.writeEffect(`delete frames after ${frameNo}`, () =>
      this.db
        .delete(smithersFrames)
        .where(
          and(
            eq(smithersFrames.runId, runId),
            sql`${smithersFrames.frameNo} > ${frameNo}`,
          ),
        ),
    );
  }

  deleteFramesAfter(runId: string, frameNo: number) {
    return runPromise(this.deleteFramesAfterEffect(runId, frameNo));
  }

  listFramesEffect(runId: string, limit: number, afterFrameNo?: number) {
    const where =
      afterFrameNo !== undefined
        ? and(
            eq(smithersFrames.runId, runId),
            sql`${smithersFrames.frameNo} > ${afterFrameNo}`,
          )
        : eq(smithersFrames.runId, runId);
    return this.readEffect(`list frames ${runId}`, () =>
      this.db
        .select()
        .from(smithersFrames)
        .where(where)
        .orderBy(desc(smithersFrames.frameNo))
        .limit(limit),
    );
  }

  listFrames(runId: string, limit: number, afterFrameNo?: number) {
    return runPromise(this.listFramesEffect(runId, limit, afterFrameNo));
  }

  countNodesByStateEffect(runId: string) {
    return this.readEffect(`count nodes by state ${runId}`, () =>
      this.db
        .select({ state: smithersNodes.state, count: sql<number>`count(*)` })
        .from(smithersNodes)
        .where(eq(smithersNodes.runId, runId))
        .groupBy(smithersNodes.state),
    );
  }

  countNodesByState(runId: string) {
    return runPromise(this.countNodesByStateEffect(runId));
  }

  upsertCronEffect(row: any) {
    return this.writeEffect("upsert cron", () =>
      this.db
        .insert(smithersCron)
        .values(row)
        .onConflictDoUpdate({
          target: smithersCron.cronId,
          set: {
            pattern: row.pattern,
            workflowPath: row.workflowPath,
            enabled: row.enabled,
            nextRunAtMs: row.nextRunAtMs,
          },
        }),
    );
  }

  upsertCron(row: any) {
    return runPromise(this.upsertCronEffect(row));
  }

  listCronsEffect(enabledOnly = true) {
    return this.readEffect("list crons", () => {
      let q = this.db.select().from(smithersCron);
      if (enabledOnly) {
        q = q.where(eq(smithersCron.enabled, true)) as any;
      }
      return Promise.resolve(q.all());
    });
  }

  listCrons(enabledOnly = true) {
    return runPromise(this.listCronsEffect(enabledOnly));
  }

  updateCronRunTimeEffect(cronId: string, lastRunAtMs: number, nextRunAtMs: number, errorJson?: string | null) {
    return this.writeEffect(`update cron run time ${cronId}`, () =>
      this.db
        .update(smithersCron)
        .set({ lastRunAtMs, nextRunAtMs, errorJson: errorJson ?? null })
        .where(eq(smithersCron.cronId, cronId)),
    );
  }

  updateCronRunTime(cronId: string, lastRunAtMs: number, nextRunAtMs: number, errorJson?: string | null) {
    return runPromise(this.updateCronRunTimeEffect(cronId, lastRunAtMs, nextRunAtMs, errorJson));
  }

  deleteCronEffect(cronId: string) {
    return this.writeEffect(`delete cron ${cronId}`, () =>
      this.db.delete(smithersCron).where(eq(smithersCron.cronId, cronId)),
    );
  }

  deleteCron(cronId: string) {
    return runPromise(this.deleteCronEffect(cronId));
  }

  // ---------------------------------------------------------------------------
  // Scorer results
  // ---------------------------------------------------------------------------

  insertScorerResultEffect(row: any) {
    return this.writeEffect(`insert scorer result ${row.scorerId}`, () =>
      this.db.insert(smithersScorers).values(row).onConflictDoNothing(),
    );
  }

  insertScorerResult(row: any) {
    return runPromise(this.insertScorerResultEffect(row));
  }

  listScorerResultsEffect(runId: string, nodeId?: string) {
    const where = nodeId
      ? and(eq(smithersScorers.runId, runId), eq(smithersScorers.nodeId, nodeId))
      : eq(smithersScorers.runId, runId);
    return this.readEffect(`list scorer results ${runId}`, () =>
      this.db
        .select()
        .from(smithersScorers)
        .where(where)
        .orderBy(smithersScorers.scoredAtMs),
    );
  }

  listScorerResults(runId: string, nodeId?: string) {
    return runPromise(this.listScorerResultsEffect(runId, nodeId));
  }
}
