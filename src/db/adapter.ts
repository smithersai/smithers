import { and, asc, desc, eq, getTableName, gte, isNull, or, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Effect, Exit, FiberId, Metric } from "effect";
import { isRunHeartbeatFresh } from "../engine";
import { fromPromise, fromSync } from "../effect/interop";
import { runPromise } from "../effect/runtime";
import {
  dbQueryDuration,
  dbTransactionDuration,
  dbTransactionRetries,
  dbTransactionRollbacks,
} from "../effect/metrics";
import { toSmithersError, type SmithersError } from "../utils/errors";
import {
  FRAME_KEYFRAME_INTERVAL,
  applyFrameDeltaJson,
  encodeFrameDelta,
  normalizeFrameEncoding,
  serializeFrameDelta,
  type FrameEncoding,
} from "./frame-codec";
import { getKeyColumns, type OutputKey } from "./output";
import {
  smithersRuns,
  smithersNodes,
  smithersAttempts,
  smithersFrames,
  smithersApprovals,
  smithersCache,
  smithersSandboxes,
  smithersToolCalls,
  smithersEvents,
  smithersRalph,
  smithersCron,
  smithersScorers,
  smithersVectors,
} from "./internal-schema";
import { withSqliteWriteRetryEffect } from "./write-retry";

export type RunRow = {
  runId: string;
  parentRunId: string | null;
  workflowName: string;
  workflowPath: string | null;
  workflowHash: string | null;
  status: string;
  createdAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  heartbeatAtMs: number | null;
  runtimeOwnerId: string | null;
  cancelRequestedAtMs: number | null;
  hijackRequestedAtMs: number | null;
  hijackTarget: string | null;
  vcsType: string | null;
  vcsRoot: string | null;
  vcsRevision: string | null;
  errorJson: string | null;
  configJson: string | null;
};

export type StaleRunRecord = {
  runId: string;
  workflowPath: string | null;
  heartbeatAtMs: number | null;
  runtimeOwnerId: string | null;
  status: string;
};

export type RunAncestryRow = {
  runId: string;
  parentRunId: string | null;
  depth: number;
};

export type EventHistoryQuery = {
  afterSeq?: number;
  limit?: number;
  nodeId?: string;
  types?: readonly string[];
  sinceTimestampMs?: number;
};

const FRAME_XML_CACHE_MAX = 512;

function classifyRunRowStatus<T extends { status: string; heartbeatAtMs: number | null }>(row: T): T {
  if (
    row.status === "running" &&
    typeof row.heartbeatAtMs === "number" &&
    row.heartbeatAtMs > 0 &&
    !isRunHeartbeatFresh(row)
  ) {
    return {
      ...row,
      status: "continued",
    };
  }
  return row;
}

export class SmithersDb {
  private reconstructedFrameXmlCache = new Map<string, string>();
  private transactionDepth = 0;
  private transactionOwnerThread: string | null = null;
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(private db: BunSQLiteDatabase<any>) {}

  private frameCacheKey(runId: string, frameNo: number): string {
    return `${runId}:${frameNo}`;
  }

  private getCachedFrameXml(runId: string, frameNo: number): string | undefined {
    const key = this.frameCacheKey(runId, frameNo);
    const value = this.reconstructedFrameXmlCache.get(key);
    if (value === undefined) return undefined;
    // Keep recently-used entries hot.
    this.reconstructedFrameXmlCache.delete(key);
    this.reconstructedFrameXmlCache.set(key, value);
    return value;
  }

  private rememberFrameXml(runId: string, frameNo: number, xmlJson: string): void {
    const key = this.frameCacheKey(runId, frameNo);
    if (this.reconstructedFrameXmlCache.has(key)) {
      this.reconstructedFrameXmlCache.delete(key);
    } else if (this.reconstructedFrameXmlCache.size >= FRAME_XML_CACHE_MAX) {
      const oldest = this.reconstructedFrameXmlCache.keys().next().value;
      if (oldest !== undefined) {
        this.reconstructedFrameXmlCache.delete(oldest);
      }
    }
    this.reconstructedFrameXmlCache.set(key, xmlJson);
  }

  private clearFrameCacheForRun(runId: string): void {
    for (const key of this.reconstructedFrameXmlCache.keys()) {
      if (key.startsWith(`${runId}:`)) {
        this.reconstructedFrameXmlCache.delete(key);
      }
    }
  }

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

  private ownsActiveTransaction(currentFiberThread: string): boolean {
    return (
      this.transactionDepth > 0 &&
      this.transactionOwnerThread === currentFiberThread
    );
  }

  private readEffect<A>(
    label: string,
    operation: () => PromiseLike<A>,
  ): Effect.Effect<A, SmithersError> {
    const self = this;
    return Effect.gen(function* () {
      const start = performance.now();
      const readOperation = fromPromise(label, operation, {
        code: "DB_QUERY_FAILED",
        details: { operation: label },
      });
      const currentFiberId = yield* Effect.fiberId;
      const currentFiberThread = FiberId.threadName(currentFiberId);
      let result: A;
      if (self.ownsActiveTransaction(currentFiberThread)) {
        result = yield* readOperation;
      } else {
        const releaseTurn = yield* self.acquireTransactionTurnEffect();
        result = yield* readOperation.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              releaseTurn();
            }),
          ),
        );
      }
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
    const self = this;
    return Effect.gen(function* () {
      const start = performance.now();
      const writeOperation = fromPromise(label, operation, {
        code: "DB_WRITE_FAILED",
        details: { operation: label },
      });
      const currentFiberId = yield* Effect.fiberId;
      const currentFiberThread = FiberId.threadName(currentFiberId);
      let result: A;
      if (self.ownsActiveTransaction(currentFiberThread)) {
        result = yield* writeOperation;
      } else {
        const releaseTurn = yield* self.acquireTransactionTurnEffect();
        result = yield* withSqliteWriteRetryEffect(
          () => writeOperation,
          { label },
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              releaseTurn();
            }),
          ),
        );
      }
      yield* Metric.update(dbQueryDuration, performance.now() - start);
      return result;
    }).pipe(
      Effect.annotateLogs({ dbOperation: label }),
      Effect.withLogSpan(`db:${label}`),
    );
  }

  private getSqliteTransactionClientEffect() {
    return fromSync("resolve sqlite transaction client", () => {
      const candidate = (this.db as any).session?.client ?? (this.db as any).$client;
      if (!candidate || typeof candidate.run !== "function") {
        throw new Error(
          "SmithersDb.withTransaction requires Bun SQLite client transaction primitives.",
        );
      }
      return candidate as { run: (sql: string) => unknown };
    }, {
      code: "DB_WRITE_FAILED",
      details: { operation: "resolve sqlite transaction client" },
    });
  }

  private acquireTransactionTurnEffect() {
    return fromPromise("acquire sqlite transaction turn", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const previous = this.transactionTail.catch(() => undefined);
      this.transactionTail = previous.then(() => gate);
      await previous;
      return release;
    }, {
      code: "DB_WRITE_FAILED",
      details: { operation: "acquire sqlite transaction turn" },
    });
  }

  withTransactionEffect<A>(
    writeGroup: string,
    operation: Effect.Effect<A, SmithersError>,
  ): Effect.Effect<A, SmithersError> {
    const self = this;
    const label = `sqlite transaction ${writeGroup}`;

    return withSqliteWriteRetryEffect(
      () =>
        Effect.gen(function* () {
          const currentFiberId = yield* Effect.fiberId;
          const currentFiberThread = FiberId.threadName(currentFiberId);
          if (self.ownsActiveTransaction(currentFiberThread)) {
            return yield* Effect.fail(
              toSmithersError(
                new Error(
                  `Nested sqlite transactions are not supported (writeGroup: ${writeGroup}).`,
                ),
                label,
                {
                  code: "DB_WRITE_FAILED",
                  details: { writeGroup, nestedTransaction: true },
                },
              ),
            );
          }
          const releaseTurn = yield* self.acquireTransactionTurnEffect();
          const start = performance.now();
          return yield* Effect.gen(function* () {
            const client = yield* self.getSqliteTransactionClientEffect();
            const rollback = (
              phase: "operation" | "commit",
              error: unknown,
            ) =>
              Effect.gen(function* () {
                yield* Metric.increment(dbTransactionRollbacks);
                yield* Effect.logWarning("transaction rollback").pipe(
                  Effect.annotateLogs({
                    writeGroup,
                    phase,
                    error: String(error),
                  }),
                );
                yield* Effect.sync(() => {
                  try {
                    client.run("ROLLBACK");
                  } catch {
                    // ignore rollback failures
                  }
                });
              });

            yield* fromSync("begin sqlite transaction", () => {
              client.run("BEGIN IMMEDIATE");
              self.transactionDepth += 1;
              self.transactionOwnerThread = currentFiberThread;
            }, {
              code: "DB_WRITE_FAILED",
              details: { writeGroup, phase: "begin" },
            });

            const operationExit = yield* Effect.exit(operation);
            if (Exit.isFailure(operationExit)) {
              yield* rollback("operation", operationExit.cause);
              return yield* Effect.failCause(operationExit.cause);
            }

            const commitExit = yield* Effect.exit(
              fromSync("commit sqlite transaction", () => {
                client.run("COMMIT");
              }, {
                code: "DB_WRITE_FAILED",
                details: { writeGroup, phase: "commit" },
              }),
            );
            if (Exit.isFailure(commitExit)) {
              yield* rollback("commit", commitExit.cause);
              return yield* Effect.failCause(commitExit.cause);
            }

            return operationExit.value;
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                self.transactionDepth = Math.max(0, self.transactionDepth - 1);
                if (self.transactionDepth === 0) {
                  self.transactionOwnerThread = null;
                }
                yield* Metric.update(
                  dbTransactionDuration,
                  performance.now() - start,
                );
              }),
            ),
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                releaseTurn();
              }),
            ),
          );
        }),
      { label },
    ).pipe(
      Effect.annotateLogs({ writeGroup }),
      Effect.withLogSpan("db:transaction"),
    );
  }

  withTransaction<A>(
    writeGroup: string,
    operation: Effect.Effect<A, SmithersError>,
  ) {
    return runPromise(this.withTransactionEffect(writeGroup, operation));
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
    return this.readEffect(`get run ${runId}`, async () => {
      const rows = await this.db
        .select()
        .from(smithersRuns)
        .where(eq(smithersRuns.runId, runId))
        .limit(1) as RunRow[];
      return rows[0] ? classifyRunRowStatus(rows[0]) : undefined;
    });
  }

  getRun(runId: string) {
    return runPromise(this.getRunEffect(runId));
  }

  listRunAncestryEffect(runId: string, limit = 1000) {
    return this.readEffect(`list run ancestry ${runId}`, () => {
      const client = (this.db as any).session.client;
      const stmt = client.query(
        `WITH RECURSIVE ancestry(run_id, parent_run_id, depth) AS (
           SELECT run_id, parent_run_id, 0
           FROM _smithers_runs
           WHERE run_id = ?
           UNION ALL
           SELECT child.run_id, child.parent_run_id, ancestry.depth + 1
           FROM _smithers_runs child
           JOIN ancestry ON child.run_id = ancestry.parent_run_id
           WHERE ancestry.parent_run_id IS NOT NULL
         )
         SELECT
           run_id AS runId,
           parent_run_id AS parentRunId,
           depth AS depth
         FROM ancestry
         ORDER BY depth ASC
         LIMIT ?`,
      );
      return Promise.resolve(stmt.all(runId, limit) as RunAncestryRow[]);
    });
  }

  listRunAncestry(runId: string, limit = 1000) {
    return runPromise(this.listRunAncestryEffect(runId, limit));
  }

  getLatestChildRunEffect(parentRunId: string) {
    return this.readEffect(`get latest child run ${parentRunId}`, () =>
      this.db
        .select()
        .from(smithersRuns)
        .where(eq(smithersRuns.parentRunId, parentRunId))
        .orderBy(desc(smithersRuns.createdAtMs))
        .limit(1),
    ).pipe(Effect.map((rows) => rows[0]));
  }

  getLatestChildRun(parentRunId: string) {
    return runPromise(this.getLatestChildRunEffect(parentRunId));
  }

  listRunsEffect(limit = 50, status?: string) {
    const where =
      status === "running"
        ? or(eq(smithersRuns.status, "running"), eq(smithersRuns.status, "continued"))
        : status
          ? eq(smithersRuns.status, status)
          : undefined;
    return this.readEffect(`list runs ${status ?? "all"}`, async () => {
      const query = this.db
        .select()
        .from(smithersRuns)
        .orderBy(desc(smithersRuns.createdAtMs))
        .limit(limit);
      const rows = (where ? await query.where(where) : await query) as RunRow[];
      return rows.map((row) => classifyRunRowStatus(row));
    });
  }

  listRuns(limit = 50, status?: string) {
    return runPromise(this.listRunsEffect(limit, status));
  }

  listStaleRunningRunsEffect(staleBeforeMs: number, limit = 1000) {
    return this.readEffect(
      `list stale running runs before ${staleBeforeMs}`,
      () => {
        const client = (this.db as any).session.client;
        const stmt = client.query(
          `SELECT
             run_id AS runId,
             workflow_path AS workflowPath,
             heartbeat_at_ms AS heartbeatAtMs,
             runtime_owner_id AS runtimeOwnerId,
             status AS status
           FROM _smithers_runs
           WHERE status = 'running'
             AND (heartbeat_at_ms IS NULL OR heartbeat_at_ms < ?)
           ORDER BY COALESCE(heartbeat_at_ms, 0) ASC
           LIMIT ?`,
        );
        const rows = stmt.all(staleBeforeMs, limit) as StaleRunRecord[];
        return Promise.resolve(rows);
      },
    );
  }

  listStaleRunningRuns(staleBeforeMs: number, limit = 1000) {
    return runPromise(this.listStaleRunningRunsEffect(staleBeforeMs, limit));
  }

  claimRunForResumeEffect(params: {
    runId: string;
    expectedRuntimeOwnerId: string | null;
    expectedHeartbeatAtMs: number | null;
    staleBeforeMs: number;
    claimOwnerId: string;
    claimHeartbeatAtMs: number;
  }) {
    return this.writeEffect(`claim stale run ${params.runId}`, () => {
      const client = (this.db as any).session.client;
      client
        .query(
          `UPDATE _smithers_runs
           SET runtime_owner_id = ?, heartbeat_at_ms = ?
           WHERE run_id = ?
             AND status = 'running'
             AND COALESCE(runtime_owner_id, '') = COALESCE(?, '')
             AND COALESCE(heartbeat_at_ms, -1) = COALESCE(?, -1)
             AND (heartbeat_at_ms IS NULL OR heartbeat_at_ms < ?)`,
        )
        .run(
          params.claimOwnerId,
          params.claimHeartbeatAtMs,
          params.runId,
          params.expectedRuntimeOwnerId,
          params.expectedHeartbeatAtMs,
          params.staleBeforeMs,
        );
      const res = client.query("SELECT changes() AS count").get() as
        | { count?: number }
        | undefined;
      return Promise.resolve(Number(res?.count ?? 0) > 0);
    });
  }

  claimRunForResume(params: {
    runId: string;
    expectedRuntimeOwnerId: string | null;
    expectedHeartbeatAtMs: number | null;
    staleBeforeMs: number;
    claimOwnerId: string;
    claimHeartbeatAtMs: number;
  }) {
    return runPromise(this.claimRunForResumeEffect(params));
  }

  releaseRunResumeClaimEffect(params: {
    runId: string;
    claimOwnerId: string;
    restoreRuntimeOwnerId: string | null;
    restoreHeartbeatAtMs: number | null;
  }) {
    return this.writeEffect(`release stale run claim ${params.runId}`, () => {
      const client = (this.db as any).session.client;
      client
        .query(
          `UPDATE _smithers_runs
           SET runtime_owner_id = ?, heartbeat_at_ms = ?
           WHERE run_id = ? AND runtime_owner_id = ?`,
        )
        .run(
          params.restoreRuntimeOwnerId,
          params.restoreHeartbeatAtMs,
          params.runId,
          params.claimOwnerId,
        );
      return Promise.resolve(undefined);
    });
  }

  releaseRunResumeClaim(params: {
    runId: string;
    claimOwnerId: string;
    restoreRuntimeOwnerId: string | null;
    restoreHeartbeatAtMs: number | null;
  }) {
    return runPromise(this.releaseRunResumeClaimEffect(params));
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

  listNodeIterationsEffect(runId: string, nodeId: string) {
    return this.readEffect(`list node iterations ${nodeId}`, () =>
      this.db
        .select()
        .from(smithersNodes)
        .where(
          and(
            eq(smithersNodes.runId, runId),
            eq(smithersNodes.nodeId, nodeId),
          ),
        )
        .orderBy(desc(smithersNodes.iteration)),
    );
  }

  listNodeIterations(runId: string, nodeId: string) {
    return runPromise(this.listNodeIterationsEffect(runId, nodeId));
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

  upsertOutputRowEffect(
    table: any,
    key: OutputKey,
    payload: Record<string, unknown>,
  ) {
    const cols = getKeyColumns(table);
    const values: Record<string, unknown> = { ...payload };
    values.runId = key.runId;
    values.nodeId = key.nodeId;
    if (cols.iteration) {
      values.iteration = key.iteration ?? 0;
    }

    const target = cols.iteration
      ? [cols.runId, cols.nodeId, cols.iteration]
      : [cols.runId, cols.nodeId];
    const tableName = (table as any)?.["_"]?.name ?? "output";

    return this.writeEffect(`upsert output ${tableName}`, () =>
      this.db
        .insert(table)
        .values(values)
        .onConflictDoUpdate({
          target: target as any,
          set: values,
        }),
    );
  }

  upsertOutputRow(
    table: any,
    key: OutputKey,
    payload: Record<string, unknown>,
  ) {
    return runPromise(this.upsertOutputRowEffect(table, key, payload));
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

  getRawNodeOutputForIterationEffect(
    tableName: string,
    runId: string,
    nodeId: string,
    iteration: number,
  ) {
    return this.readEffect(
      `get raw node output ${tableName} iteration ${iteration}`,
      () => {
        const escaped = tableName.replaceAll(`"`, `""`);
        const client = (this.db as any).session.client;
        const stmt = client.query(
          `SELECT * FROM "${escaped}" WHERE run_id = ? AND node_id = ? AND iteration = ? LIMIT 1`,
        );
        const row = stmt.get(runId, nodeId, iteration);
        return Promise.resolve(row ?? null);
      },
    ).pipe(Effect.catchAll(() => Effect.succeed(null)));
  }

  getRawNodeOutputForIteration(
    tableName: string,
    runId: string,
    nodeId: string,
    iteration: number,
  ) {
    return runPromise(
      this.getRawNodeOutputForIterationEffect(
        tableName,
        runId,
        nodeId,
        iteration,
      ),
    );
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

  heartbeatAttemptEffect(
    runId: string,
    nodeId: string,
    iteration: number,
    attempt: number,
    heartbeatAtMs: number,
    heartbeatDataJson: string | null,
  ) {
    return this.writeEffect(`heartbeat attempt ${nodeId}#${attempt}`, () =>
      this.db
        .update(smithersAttempts)
        .set({
          heartbeatAtMs,
          heartbeatDataJson,
        })
        .where(
          and(
            eq(smithersAttempts.runId, runId),
            eq(smithersAttempts.nodeId, nodeId),
            eq(smithersAttempts.iteration, iteration),
            eq(smithersAttempts.attempt, attempt),
            eq(smithersAttempts.state, "in-progress"),
          ),
        ),
    );
  }

  heartbeatAttempt(
    runId: string,
    nodeId: string,
    iteration: number,
    attempt: number,
    heartbeatAtMs: number,
    heartbeatDataJson: string | null,
  ) {
    return runPromise(
      this.heartbeatAttemptEffect(
        runId,
        nodeId,
        iteration,
        attempt,
        heartbeatAtMs,
        heartbeatDataJson,
      ),
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

  private listFrameChainDescEffect(
    runId: string,
    frameNo: number,
    limit?: number,
  ) {
    return this.readEffect(`list frame chain ${runId}:${frameNo}`, () => {
      const query = this.db
        .select()
        .from(smithersFrames)
        .where(
          and(
            eq(smithersFrames.runId, runId),
            sql`${smithersFrames.frameNo} <= ${frameNo}`,
          ),
        )
        .orderBy(desc(smithersFrames.frameNo));
      if (typeof limit === "number") {
        return query.limit(limit);
      }
      return query;
    });
  }

  private reconstructFrameXmlEffect(
    runId: string,
    frameNo: number,
    localCache = new Map<number, string>(),
  ) {
    const self = this;
    return Effect.gen(function* () {
      const localHit = localCache.get(frameNo);
      if (localHit !== undefined) return localHit;

      const cacheHit = self.getCachedFrameXml(runId, frameNo);
      if (cacheHit !== undefined) {
        localCache.set(frameNo, cacheHit);
        return cacheHit;
      }

      let rows = (yield* self.listFrameChainDescEffect(
        runId,
        frameNo,
        FRAME_KEYFRAME_INTERVAL + 2,
      )) as any[];
      if (rows.length === 0) return undefined;

      let anchorIndex = rows.findIndex(
        (row) => normalizeFrameEncoding(row.encoding) !== "delta",
      );

      if (anchorIndex < 0) {
        rows = (yield* self.listFrameChainDescEffect(runId, frameNo)) as any[];
        anchorIndex = rows.findIndex(
          (row) => normalizeFrameEncoding(row.encoding) !== "delta",
        );
      }

      if (anchorIndex < 0) {
        return rows.find((row) => row.frameNo === frameNo)?.xmlJson;
      }

      const chain = rows.slice(0, anchorIndex + 1).reverse();
      let currentXml = "";
      for (const frameRow of chain) {
        const rowEncoding = normalizeFrameEncoding(frameRow.encoding);
        if (rowEncoding === "delta") {
          if (!currentXml) {
            currentXml = String(frameRow.xmlJson ?? "null");
          } else {
            currentXml = yield* fromSync(
              `apply frame delta ${runId}:${frameRow.frameNo}`,
              () => applyFrameDeltaJson(currentXml, String(frameRow.xmlJson ?? "")),
              {
                code: "DB_QUERY_FAILED",
                details: { runId, frameNo: frameRow.frameNo },
              },
            );
          }
        } else {
          currentXml = String(frameRow.xmlJson ?? "null");
        }
        localCache.set(frameRow.frameNo, currentXml);
        self.rememberFrameXml(runId, frameRow.frameNo, currentXml);
      }
      return localCache.get(frameNo);
    });
  }

  private inflateFrameRowEffect(
    row: any,
    localCache = new Map<number, string>(),
  ) {
    const self = this;
    return Effect.gen(function* () {
      const encoding = normalizeFrameEncoding(row?.encoding);
      if (encoding !== "delta") {
        const xmlJson = String(row?.xmlJson ?? "null");
        localCache.set(row.frameNo, xmlJson);
        self.rememberFrameXml(row.runId, row.frameNo, xmlJson);
        return { ...row, encoding, xmlJson };
      }

      const xmlJson = yield* self.reconstructFrameXmlEffect(
        row.runId,
        row.frameNo,
        localCache,
      );
      return {
        ...row,
        encoding,
        xmlJson: xmlJson ?? String(row?.xmlJson ?? "null"),
      };
    });
  }

  insertFrameEffect(row: any) {
    const self = this;
    return Effect.gen(function* () {
      const runId = String(row.runId);
      const frameNo = Number(row.frameNo);
      const fullXmlJson = String(row.xmlJson ?? "null");

      let encoding: FrameEncoding = "keyframe";
      let persistedXmlJson = fullXmlJson;

      if (frameNo > 0 && frameNo % FRAME_KEYFRAME_INTERVAL !== 0) {
        const previousXmlJson = yield* self.reconstructFrameXmlEffect(
          runId,
          frameNo - 1,
        );
        if (typeof previousXmlJson === "string") {
          const delta = yield* fromSync(
            `encode frame delta ${runId}:${frameNo}`,
            () => encodeFrameDelta(previousXmlJson, fullXmlJson),
            {
              code: "DB_WRITE_FAILED",
              details: { runId, frameNo },
            },
          );
          const deltaJson = serializeFrameDelta(delta);
          if (deltaJson.length < fullXmlJson.length) {
            encoding = "delta";
            persistedXmlJson = deltaJson;
          }
        }
      }

      const persistedRow = {
        ...row,
        xmlJson: persistedXmlJson,
        encoding,
      };

      yield* self.writeEffect(`insert frame ${frameNo}`, () =>
        self.db
          .insert(smithersFrames)
          .values(persistedRow)
          .onConflictDoUpdate({
            target: [smithersFrames.runId, smithersFrames.frameNo],
            set: persistedRow,
          }),
      );

      self.clearFrameCacheForRun(runId);
      self.rememberFrameXml(runId, frameNo, fullXmlJson);
    });
  }

  insertFrame(row: any) {
    return runPromise(this.insertFrameEffect(row));
  }

  getLastFrameEffect(runId: string) {
    const self = this;
    return Effect.gen(function* () {
      const rows = (yield* self.readEffect(`get last frame ${runId}`, () =>
        self.db
          .select()
          .from(smithersFrames)
          .where(eq(smithersFrames.runId, runId))
          .orderBy(desc(smithersFrames.frameNo))
          .limit(1),
      )) as any[];
      const row = rows[0];
      if (!row) return undefined;
      return yield* self.inflateFrameRowEffect(row);
    });
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

  upsertSandboxEffect(row: any) {
    return this.writeEffect(`upsert sandbox ${row.sandboxId}`, () =>
      this.db
        .insert(smithersSandboxes)
        .values(row)
        .onConflictDoUpdate({
          target: [smithersSandboxes.runId, smithersSandboxes.sandboxId],
          set: row,
        }),
    );
  }

  upsertSandbox(row: any) {
    return runPromise(this.upsertSandboxEffect(row));
  }

  getSandboxEffect(runId: string, sandboxId: string) {
    return this.readEffect(`get sandbox ${sandboxId}`, () =>
      this.db
        .select()
        .from(smithersSandboxes)
        .where(
          and(
            eq(smithersSandboxes.runId, runId),
            eq(smithersSandboxes.sandboxId, sandboxId),
          ),
        )
        .limit(1),
    ).pipe(Effect.map((rows) => rows[0]));
  }

  getSandbox(runId: string, sandboxId: string) {
    return runPromise(this.getSandboxEffect(runId, sandboxId));
  }

  listSandboxesEffect(runId: string) {
    return this.readEffect(`list sandboxes ${runId}`, () =>
      this.db
        .select()
        .from(smithersSandboxes)
        .where(eq(smithersSandboxes.runId, runId)),
    );
  }

  listSandboxes(runId: string) {
    return runPromise(this.listSandboxesEffect(runId));
  }

  listToolCallsEffect(runId: string, nodeId: string, iteration: number) {
    return this.readEffect(`list tool calls ${nodeId}`, () =>
      this.db
        .select()
        .from(smithersToolCalls)
        .where(
          and(
            eq(smithersToolCalls.runId, runId),
            eq(smithersToolCalls.nodeId, nodeId),
            eq(smithersToolCalls.iteration, iteration),
          ),
        )
        .orderBy(
          smithersToolCalls.attempt,
          smithersToolCalls.seq,
        ),
    );
  }

  listToolCalls(runId: string, nodeId: string, iteration: number) {
    return runPromise(this.listToolCallsEffect(runId, nodeId, iteration));
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

  private buildEventHistoryWhere(
    runId: string,
    query: EventHistoryQuery = {},
  ): { whereSql: string; params: Array<string | number> } {
    const clauses: string[] = ["run_id = ?", "seq > ?"];
    const params: Array<string | number> = [runId, query.afterSeq ?? -1];

    if (typeof query.sinceTimestampMs === "number") {
      clauses.push("timestamp_ms >= ?");
      params.push(query.sinceTimestampMs);
    }

    if (query.types && query.types.length > 0) {
      clauses.push(`type IN (${query.types.map(() => "?").join(", ")})`);
      params.push(...query.types);
    }

    if (query.nodeId) {
      clauses.push("json_extract(payload_json, '$.nodeId') = ?");
      params.push(query.nodeId);
    }

    return {
      whereSql: clauses.join(" AND "),
      params,
    };
  }

  listEventHistoryEffect(runId: string, query: EventHistoryQuery = {}) {
    const limit = Math.max(1, Math.floor(query.limit ?? 200));
    return this.readEffect(`list event history ${runId}`, () => {
      const client = (this.db as any).session.client;
      const { whereSql, params } = this.buildEventHistoryWhere(runId, query);
      const stmt = client.query(
        `SELECT
           run_id AS runId,
           seq AS seq,
           timestamp_ms AS timestampMs,
           type AS type,
           payload_json AS payloadJson
         FROM _smithers_events
         WHERE ${whereSql}
         ORDER BY seq ASC
         LIMIT ?`,
      );
      return Promise.resolve(stmt.all(...params, limit) as any[]);
    });
  }

  listEventHistory(runId: string, query: EventHistoryQuery = {}) {
    return runPromise(this.listEventHistoryEffect(runId, query));
  }

  countEventHistoryEffect(runId: string, query: EventHistoryQuery = {}) {
    return this.readEffect(`count event history ${runId}`, () => {
      const client = (this.db as any).session.client;
      const { whereSql, params } = this.buildEventHistoryWhere(runId, query);
      const stmt = client.query(
        `SELECT COUNT(*) AS count
         FROM _smithers_events
         WHERE ${whereSql}`,
      );
      const row = stmt.get(...params) as { count?: number | string } | undefined;
      return Promise.resolve(Number(row?.count ?? 0));
    });
  }

  countEventHistory(runId: string, query: EventHistoryQuery = {}) {
    return runPromise(this.countEventHistoryEffect(runId, query));
  }

  listEventsEffect(runId: string, afterSeq: number, limit = 200) {
    return this.listEventHistoryEffect(runId, { afterSeq, limit });
  }

  listEvents(runId: string, afterSeq: number, limit = 200) {
    return runPromise(this.listEventsEffect(runId, afterSeq, limit));
  }

  listEventsByTypeEffect(runId: string, type: string) {
    return this.readEffect(`list events by type ${type}`, () =>
      this.db
        .select()
        .from(smithersEvents)
        .where(
          and(
            eq(smithersEvents.runId, runId),
            eq(smithersEvents.type, type),
          ),
        )
        .orderBy(smithersEvents.seq),
    );
  }

  listEventsByType(runId: string, type: string) {
    return runPromise(this.listEventsByTypeEffect(runId, type));
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

  listAllPendingApprovalsEffect() {
    return this.readEffect("list all pending approvals", () =>
      this.db
        .select({
          runId: smithersApprovals.runId,
          nodeId: smithersApprovals.nodeId,
          iteration: smithersApprovals.iteration,
          status: smithersApprovals.status,
          requestedAtMs: smithersApprovals.requestedAtMs,
          note: smithersApprovals.note,
          decidedBy: smithersApprovals.decidedBy,
          workflowName: smithersRuns.workflowName,
          runStatus: smithersRuns.status,
          nodeLabel: smithersNodes.label,
        })
        .from(smithersApprovals)
        .leftJoin(smithersRuns, eq(smithersApprovals.runId, smithersRuns.runId))
        .leftJoin(
          smithersNodes,
          and(
            eq(smithersApprovals.runId, smithersNodes.runId),
            eq(smithersApprovals.nodeId, smithersNodes.nodeId),
            eq(smithersApprovals.iteration, smithersNodes.iteration),
          ),
        )
        .where(eq(smithersApprovals.status, "requested"))
        .orderBy(
          sql`coalesce(${smithersApprovals.requestedAtMs}, 0) asc`,
          smithersApprovals.runId,
          smithersApprovals.nodeId,
          smithersApprovals.iteration,
        ),
    );
  }

  listAllPendingApprovals() {
    return runPromise(this.listAllPendingApprovalsEffect());
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

  listCacheByNodeEffect(
    nodeId: string,
    outputTable?: string,
    limit = 20,
  ) {
    const where = outputTable
      ? and(eq(smithersCache.nodeId, nodeId), eq(smithersCache.outputTable, outputTable))
      : eq(smithersCache.nodeId, nodeId);
    return this.readEffect(`list cache by node ${nodeId}`, () =>
      this.db
        .select()
        .from(smithersCache)
        .where(where)
        .orderBy(desc(smithersCache.createdAtMs))
        .limit(limit),
    );
  }

  listCacheByNode(
    nodeId: string,
    outputTable?: string,
    limit = 20,
  ) {
    return runPromise(this.listCacheByNodeEffect(nodeId, outputTable, limit));
  }

  deleteFramesAfterEffect(runId: string, frameNo: number) {
    const self = this;
    return Effect.gen(function* () {
      yield* self.writeEffect(`delete frames after ${frameNo}`, () =>
        self.db
          .delete(smithersFrames)
          .where(
            and(
              eq(smithersFrames.runId, runId),
              sql`${smithersFrames.frameNo} > ${frameNo}`,
            ),
          ),
      );
      self.clearFrameCacheForRun(runId);
    });
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
    const self = this;
    return Effect.gen(function* () {
      const rows = (yield* self.readEffect(`list frames ${runId}`, () =>
        self.db
          .select()
          .from(smithersFrames)
          .where(where)
          .orderBy(desc(smithersFrames.frameNo))
          .limit(limit),
      )) as any[];

      const localCache = new Map<number, string>();
      const expanded: any[] = [];
      for (const row of rows) {
        expanded.push(yield* self.inflateFrameRowEffect(row, localCache));
      }
      return expanded;
    });
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
