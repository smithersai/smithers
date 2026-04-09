import { getTableName, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Effect, Exit, FiberId, Metric } from "effect";
import { isRunHeartbeatFresh } from "../engine";
import { fromPromise, fromSync } from "../effect/interop";
import { runPromise } from "../effect/runtime";
import { getSqlMessageStorage, type SqlMessageStorage } from "../effect/sql-message-storage";
import type {
  HumanRequestKind,
  HumanRequestStatus,
} from "../human-requests";
import {
  dbQueryDuration,
  dbTransactionDuration,
  dbTransactionRetries,
  dbTransactionRollbacks,
} from "../effect/metrics";
import { toSmithersError, type SmithersError } from "../utils/errors";
import {
  assertOptionalStringMaxLength,
  assertPositiveFiniteNumber,
} from "../utils/input-bounds";
import {
  FRAME_KEYFRAME_INTERVAL,
  applyFrameDeltaJson,
  encodeFrameDelta,
  normalizeFrameEncoding,
  serializeFrameDelta,
  type FrameEncoding,
} from "./frame-codec";
import { getKeyColumns, type OutputKey } from "./output";
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

export type SignalQuery = {
  signalName?: string;
  correlationId?: string | null;
  receivedAfterMs?: number;
  limit?: number;
};

export type HumanRequestRow = {
  requestId: string;
  runId: string;
  nodeId: string;
  iteration: number;
  kind: HumanRequestKind;
  status: HumanRequestStatus;
  prompt: string;
  schemaJson: string | null;
  optionsJson: string | null;
  responseJson: string | null;
  requestedAtMs: number;
  answeredAtMs: number | null;
  answeredBy: string | null;
  timeoutAtMs: number | null;
};

export type PendingHumanRequestRow = HumanRequestRow & {
  workflowName: string | null;
  runStatus: string | null;
  nodeLabel: string | null;
};

const FRAME_XML_CACHE_MAX = 512;
export const DB_RUN_ID_MAX_LENGTH = 256;
export const DB_RUN_WORKFLOW_NAME_MAX_LENGTH = 256;
export const DB_RUN_ALLOWED_STATUSES = [
  "running",
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
  "finished",
  "failed",
  "cancelled",
  "continued",
] as const;

function validateRunStatus(status: unknown) {
  if (
    typeof status !== "string" ||
    !DB_RUN_ALLOWED_STATUSES.includes(status as (typeof DB_RUN_ALLOWED_STATUSES)[number])
  ) {
    throw toSmithersError(
      new Error("Invalid run status"),
      `Run status must be one of: ${DB_RUN_ALLOWED_STATUSES.join(", ")}`,
      {
        code: "INVALID_INPUT",
        details: { status },
      },
    );
  }
}

function validateOptionalPositiveTimestamp(row: Record<string, unknown>, field: string) {
  const value = row[field];
  if (value === undefined || value === null) return;
  assertPositiveFiniteNumber(field, Number(value));
}

function validateRunRow(row: any) {
  if (!row || typeof row !== "object") {
    throw toSmithersError(new Error("Invalid run row"), "Run row must be an object", {
      code: "INVALID_INPUT",
    });
  }
  assertOptionalStringMaxLength("runId", row.runId, DB_RUN_ID_MAX_LENGTH);
  assertOptionalStringMaxLength(
    "parentRunId",
    row.parentRunId,
    DB_RUN_ID_MAX_LENGTH,
  );
  assertOptionalStringMaxLength(
    "workflowName",
    row.workflowName,
    DB_RUN_WORKFLOW_NAME_MAX_LENGTH,
  );
  validateRunStatus(row.status);
  validateOptionalPositiveTimestamp(row, "createdAtMs");
  validateOptionalPositiveTimestamp(row, "startedAtMs");
  validateOptionalPositiveTimestamp(row, "finishedAtMs");
  validateOptionalPositiveTimestamp(row, "heartbeatAtMs");
  validateOptionalPositiveTimestamp(row, "cancelRequestedAtMs");
  validateOptionalPositiveTimestamp(row, "hijackRequestedAtMs");
}

function validateRunPatch(patch: any) {
  if (!patch || typeof patch !== "object") return;
  if ("workflowName" in patch) {
    assertOptionalStringMaxLength(
      "workflowName",
      patch.workflowName,
      DB_RUN_WORKFLOW_NAME_MAX_LENGTH,
    );
  }
  if ("status" in patch) {
    validateRunStatus(patch.status);
  }
  validateOptionalPositiveTimestamp(patch, "startedAtMs");
  validateOptionalPositiveTimestamp(patch, "finishedAtMs");
  validateOptionalPositiveTimestamp(patch, "heartbeatAtMs");
  validateOptionalPositiveTimestamp(patch, "cancelRequestedAtMs");
  validateOptionalPositiveTimestamp(patch, "hijackRequestedAtMs");
}

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
  private internalStorage: SqlMessageStorage;
  private reconstructedFrameXmlCache = new Map<string, string>();
  private transactionDepth = 0;
  private transactionOwnerThread: string | null = null;
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(private db: BunSQLiteDatabase<any>) {
    this.internalStorage = getSqlMessageStorage(db);
  }

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
    validateRunRow(row);
    return this.writeEffect("insert run", () =>
      this.internalStorage.insertIgnore("_smithers_runs", row),
    );
  }

  insertRun(row: any) {
    return runPromise(this.insertRunEffect(row));
  }

  updateRunEffect(runId: string, patch: any) {
    validateRunPatch(patch);
    return this.writeEffect(`update run ${runId}`, () =>
      this.internalStorage.updateWhere("_smithers_runs", patch, "run_id = ?", [runId]),
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
      this.internalStorage.updateWhere(
        "_smithers_runs",
        { heartbeatAtMs },
        "run_id = ? AND runtime_owner_id = ?",
        [runId, runtimeOwnerId],
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
      this.internalStorage.updateWhere(
        "_smithers_runs",
        { cancelRequestedAtMs },
        "run_id = ?",
        [runId],
      ),
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
      this.internalStorage.updateWhere(
        "_smithers_runs",
        {
          hijackRequestedAtMs,
          hijackTarget: hijackTarget ?? null,
        },
        "run_id = ?",
        [runId],
      ),
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
      this.internalStorage.updateWhere(
        "_smithers_runs",
        {
          hijackRequestedAtMs: null,
          hijackTarget: null,
        },
        "run_id = ?",
        [runId],
      ),
    );
  }

  clearRunHijack(runId: string) {
    return runPromise(this.clearRunHijackEffect(runId));
  }

  getRunEffect(runId: string) {
    return this.readEffect(`get run ${runId}`, async () => {
      const row = await this.internalStorage.queryOne<RunRow>(
        `SELECT *
         FROM _smithers_runs
         WHERE run_id = ?
         LIMIT 1`,
        [runId],
      );
      return row ? classifyRunRowStatus(row) : undefined;
    });
  }

  getRun(runId: string) {
    return runPromise(this.getRunEffect(runId));
  }

  listRunAncestryEffect(runId: string, limit = 1000) {
    return this.readEffect(`list run ancestry ${runId}`, () =>
      this.internalStorage.queryAll<RunAncestryRow>(
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
           run_id,
           parent_run_id,
           depth
         FROM ancestry
         ORDER BY depth ASC
         LIMIT ?`,
        [runId, limit],
      ),
    );
  }

  listRunAncestry(runId: string, limit = 1000) {
    return runPromise(this.listRunAncestryEffect(runId, limit));
  }

  getLatestChildRunEffect(parentRunId: string) {
    return this.readEffect(`get latest child run ${parentRunId}`, () =>
      this.internalStorage.queryOne(
        `SELECT *
         FROM _smithers_runs
         WHERE parent_run_id = ?
         ORDER BY created_at_ms DESC
         LIMIT 1`,
        [parentRunId],
      ),
    );
  }

  getLatestChildRun(parentRunId: string) {
    return runPromise(this.getLatestChildRunEffect(parentRunId));
  }

  listRunsEffect(limit = 50, status?: string) {
    return this.readEffect(`list runs ${status ?? "all"}`, async () => {
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (status === "running") {
        clauses.push("(status = ? OR status = ?)");
        params.push("running", "continued");
      } else if (status) {
        clauses.push("status = ?");
        params.push(status);
      }
      const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = await this.internalStorage.queryAll<RunRow>(
        `SELECT *
         FROM _smithers_runs
         ${whereSql}
         ORDER BY created_at_ms DESC
         LIMIT ?`,
        [...params, limit],
      );
      return rows.map((row) => classifyRunRowStatus(row));
    });
  }

  listRuns(limit = 50, status?: string) {
    return runPromise(this.listRunsEffect(limit, status));
  }

  listStaleRunningRunsEffect(staleBeforeMs: number, limit = 1000) {
    return this.readEffect(
      `list stale running runs before ${staleBeforeMs}`,
      () =>
        this.internalStorage.queryAll<StaleRunRecord>(
          `SELECT
             run_id,
             workflow_path,
             heartbeat_at_ms,
             runtime_owner_id,
             status
           FROM _smithers_runs
           WHERE status = 'running'
             AND (heartbeat_at_ms IS NULL OR heartbeat_at_ms < ?)
           ORDER BY COALESCE(heartbeat_at_ms, 0) ASC
           LIMIT ?`,
          [staleBeforeMs, limit],
        ),
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
      return this.internalStorage
        .queryOne<{ count: number }>("SELECT changes() AS count")
        .then((row) => Number(row?.count ?? 0) > 0);
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
      return this.internalStorage.execute(
        `UPDATE _smithers_runs
         SET runtime_owner_id = ?, heartbeat_at_ms = ?
         WHERE run_id = ? AND runtime_owner_id = ?`,
        [
          params.restoreRuntimeOwnerId,
          params.restoreHeartbeatAtMs,
          params.runId,
          params.claimOwnerId,
        ],
      );
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
      this.internalStorage.upsert(
        "_smithers_nodes",
        row,
        ["runId", "nodeId", "iteration"],
      ),
    );
  }

  insertNode(row: any) {
    return runPromise(this.insertNodeEffect(row));
  }

  getNodeEffect(runId: string, nodeId: string, iteration: number) {
    return this.readEffect(`get node ${nodeId}`, () =>
      this.internalStorage.queryOne(
        `SELECT *
         FROM _smithers_nodes
         WHERE run_id = ? AND node_id = ? AND iteration = ?
         LIMIT 1`,
        [runId, nodeId, iteration],
      ),
    );
  }

  getNode(runId: string, nodeId: string, iteration: number) {
    return runPromise(this.getNodeEffect(runId, nodeId, iteration));
  }

  listNodeIterationsEffect(runId: string, nodeId: string) {
    return this.readEffect(`list node iterations ${nodeId}`, () =>
      this.internalStorage.queryAll(
        `SELECT *
         FROM _smithers_nodes
         WHERE run_id = ? AND node_id = ?
         ORDER BY iteration DESC`,
        [runId, nodeId],
      ),
    );
  }

  listNodeIterations(runId: string, nodeId: string) {
    return runPromise(this.listNodeIterationsEffect(runId, nodeId));
  }

  listNodesEffect(runId: string) {
    return this.readEffect(`list nodes ${runId}`, () =>
      this.internalStorage.queryAll(
        `SELECT *
         FROM _smithers_nodes
         WHERE run_id = ?`,
        [runId],
      ),
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

  deleteOutputRowEffect(tableName: string, key: OutputKey) {
    return this.writeEffect(`delete output ${tableName}`, () => {
      const client = (this.db as any).session.client;
      let resolvedTableName = tableName;
      let escapedTableName = resolvedTableName.replaceAll(`"`, `""`);
      let tableInfo = client
        .query(`PRAGMA table_info("${escapedTableName}")`)
        .all() as Array<{ name?: string }>;
      if (tableInfo.length === 0) {
        const schemaCandidates = [
          (this.db as any)?._?.fullSchema,
          (this.db as any)?._?.schema,
          (this.db as any)?.schema,
        ];
        for (const candidate of schemaCandidates) {
          if (!candidate || typeof candidate !== "object") continue;
          const table = (candidate as Record<string, unknown>)[tableName];
          if (!table) continue;
          try {
            resolvedTableName = getTableName(table as any);
            escapedTableName = resolvedTableName.replaceAll(`"`, `""`);
            tableInfo = client
              .query(`PRAGMA table_info("${escapedTableName}")`)
              .all() as Array<{ name?: string }>;
            if (tableInfo.length > 0) {
              break;
            }
          } catch {}
        }
      }
      const columnNames = new Set(
        tableInfo
          .map((column) => column.name)
          .filter((name): name is string => typeof name === "string"),
      );
      const runIdColumn = columnNames.has("run_id")
        ? "run_id"
        : columnNames.has("runId")
          ? "runId"
          : null;
      const nodeIdColumn = columnNames.has("node_id")
        ? "node_id"
        : columnNames.has("nodeId")
          ? "nodeId"
          : null;
      const iterationColumn = columnNames.has("iteration")
        ? "iteration"
        : null;

      if (!runIdColumn || !nodeIdColumn) {
        throw new Error(
          `Output table ${tableName} is missing runId/nodeId columns`,
        );
      }

      if (iterationColumn) {
        client
          .query(
            `DELETE FROM "${escapedTableName}"
             WHERE "${runIdColumn}" = ? AND "${nodeIdColumn}" = ? AND "${iterationColumn}" = ?`,
          )
          .run(key.runId, key.nodeId, key.iteration ?? 0);
      } else {
        client
          .query(
            `DELETE FROM "${escapedTableName}"
             WHERE "${runIdColumn}" = ? AND "${nodeIdColumn}" = ?`,
          )
          .run(key.runId, key.nodeId);
      }

      return Promise.resolve(undefined);
    });
  }

  deleteOutputRow(tableName: string, key: OutputKey) {
    return runPromise(this.deleteOutputRowEffect(tableName, key));
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
      this.internalStorage.upsert(
        "_smithers_attempts",
        row,
        ["runId", "nodeId", "iteration", "attempt"],
      ),
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
      this.internalStorage.updateWhere(
        "_smithers_attempts",
        patch,
        "run_id = ? AND node_id = ? AND iteration = ? AND attempt = ?",
        [runId, nodeId, iteration, attempt],
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
      this.internalStorage.updateWhere(
        "_smithers_attempts",
        {
          heartbeatAtMs,
          heartbeatDataJson,
        },
        "run_id = ? AND node_id = ? AND iteration = ? AND attempt = ? AND state = ?",
        [runId, nodeId, iteration, attempt, "in-progress"],
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

  listAttemptsEffect(runId: string, nodeId: string, iteration: number): Effect.Effect<any[], SmithersError> {
    return this.readEffect(`list attempts ${nodeId}`, () =>
      this.internalStorage.queryAll<any>(
        `SELECT *
         FROM _smithers_attempts
         WHERE run_id = ? AND node_id = ? AND iteration = ?
         ORDER BY attempt DESC`,
        [runId, nodeId, iteration],
        { booleanColumns: ["cached"] },
      ),
    );
  }

  listAttempts(runId: string, nodeId: string, iteration: number) {
    return runPromise(this.listAttemptsEffect(runId, nodeId, iteration));
  }

  listAttemptsForRunEffect(runId: string): Effect.Effect<any[], SmithersError> {
    return this.readEffect(`list attempts for run ${runId}`, () =>
      this.internalStorage.queryAll<any>(
        `SELECT *
         FROM _smithers_attempts
         WHERE run_id = ?
         ORDER BY started_at_ms ASC, node_id ASC, iteration ASC, attempt ASC`,
        [runId],
        { booleanColumns: ["cached"] },
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
  ): Effect.Effect<any | undefined, SmithersError> {
    return this.readEffect(`get attempt ${nodeId}#${attempt}`, () =>
      this.internalStorage.queryOne<any>(
        `SELECT *
         FROM _smithers_attempts
         WHERE run_id = ? AND node_id = ? AND iteration = ? AND attempt = ?
         LIMIT 1`,
        [runId, nodeId, iteration, attempt],
        { booleanColumns: ["cached"] },
      ),
    );
  }

  getAttempt(runId: string, nodeId: string, iteration: number, attempt: number) {
    return runPromise(this.getAttemptEffect(runId, nodeId, iteration, attempt));
  }

  listInProgressAttemptsEffect(runId: string): Effect.Effect<any[], SmithersError> {
    return this.readEffect(`list in-progress attempts ${runId}`, () =>
      this.internalStorage.queryAll<any>(
        `SELECT *
         FROM _smithers_attempts
         WHERE run_id = ? AND state = ?`,
        [runId, "in-progress"],
        { booleanColumns: ["cached"] },
      ),
    );
  }

  listInProgressAttempts(runId: string) {
    return runPromise(this.listInProgressAttemptsEffect(runId));
  }

  listAllInProgressAttemptsEffect(): Effect.Effect<any[], SmithersError> {
    return this.readEffect("list all in-progress attempts", () =>
      this.internalStorage.queryAll<any>(
        `SELECT *
         FROM _smithers_attempts
         WHERE state = ?`,
        ["in-progress"],
        { booleanColumns: ["cached"] },
      ),
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
    return this.readEffect(`list frame chain ${runId}:${frameNo}`, () =>
      this.internalStorage.queryAll(
        `SELECT *
         FROM _smithers_frames
         WHERE run_id = ? AND frame_no <= ?
         ORDER BY frame_no DESC${typeof limit === "number" ? " LIMIT ?" : ""}`,
        typeof limit === "number" ? [runId, frameNo, limit] : [runId, frameNo],
      ),
    );
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
        self.internalStorage.upsert(
          "_smithers_frames",
          persistedRow,
          ["runId", "frameNo"],
        ),
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
      const row = yield* self.readEffect(`get last frame ${runId}`, () =>
        self.internalStorage.queryOne(
          `SELECT *
           FROM _smithers_frames
           WHERE run_id = ?
           ORDER BY frame_no DESC
           LIMIT 1`,
          [runId],
        ),
      );
      if (!row) return undefined;
      return yield* self.inflateFrameRowEffect(row);
    });
  }

  getLastFrame(runId: string) {
    return runPromise(this.getLastFrameEffect(runId));
  }


  insertOrUpdateApprovalEffect(row: any) {
    return this.writeEffect(`upsert approval ${row.nodeId}`, () =>
      this.internalStorage.upsert(
        "_smithers_approvals",
        row,
        ["runId", "nodeId", "iteration"],
      ),
    );
  }

  insertOrUpdateApproval(row: any) {
    return runPromise(this.insertOrUpdateApprovalEffect(row));
  }

  getApprovalEffect(runId: string, nodeId: string, iteration: number) {
    return this.readEffect(`get approval ${nodeId}`, () =>
      this.internalStorage.queryOne(
        `SELECT *
         FROM _smithers_approvals
         WHERE run_id = ? AND node_id = ? AND iteration = ?
         LIMIT 1`,
        [runId, nodeId, iteration],
        { booleanColumns: ["autoApproved"] },
      ),
    );
  }

  getApproval(runId: string, nodeId: string, iteration: number) {
    return runPromise(this.getApprovalEffect(runId, nodeId, iteration));
  }

  insertHumanRequestEffect(row: HumanRequestRow) {
    return this.writeEffect(`insert human request ${row.requestId}`, () =>
      this.internalStorage.insertIgnore("_smithers_human_requests", row),
    );
  }

  insertHumanRequest(row: HumanRequestRow) {
    return runPromise(this.insertHumanRequestEffect(row));
  }

  getHumanRequestEffect(requestId: string) {
    return this.readEffect(`get human request ${requestId}`, () =>
      this.internalStorage.queryOne<HumanRequestRow>(
        `SELECT *
         FROM _smithers_human_requests
         WHERE request_id = ?
         LIMIT 1`,
        [requestId],
      ),
    );
  }

  getHumanRequest(requestId: string) {
    return runPromise(this.getHumanRequestEffect(requestId));
  }

  listPendingHumanRequestsEffect() {
    return this.readEffect("list pending human requests", () =>
      this.internalStorage.queryAll<PendingHumanRequestRow>(
        `SELECT
           h.request_id,
           h.run_id,
           h.node_id,
           h.iteration,
           h.kind,
           h.status,
           h.prompt,
           h.schema_json,
           h.options_json,
           h.response_json,
           h.requested_at_ms,
           h.answered_at_ms,
           h.answered_by,
           h.timeout_at_ms,
           r.workflow_name,
           r.status AS run_status,
           n.label AS node_label
         FROM _smithers_human_requests h
         LEFT JOIN _smithers_runs r ON h.run_id = r.run_id
         LEFT JOIN _smithers_nodes n
           ON h.run_id = n.run_id
          AND h.node_id = n.node_id
          AND h.iteration = n.iteration
         WHERE h.status = ?
         ORDER BY h.requested_at_ms ASC, h.run_id, h.node_id, h.iteration`,
        ["pending"],
      ),
    );
  }

  listPendingHumanRequests() {
    return runPromise(this.listPendingHumanRequestsEffect());
  }

  answerHumanRequestEffect(
    requestId: string,
    responseJson: string,
    answeredAtMs: number,
    answeredBy?: string | null,
  ) {
    return this.writeEffect(`answer human request ${requestId}`, () =>
      this.internalStorage.updateWhere(
        "_smithers_human_requests",
        {
          status: "answered",
          responseJson,
          answeredAtMs,
          answeredBy: answeredBy ?? null,
        },
        "request_id = ? AND status = ?",
        [requestId, "pending"],
      ),
    );
  }

  answerHumanRequest(
    requestId: string,
    responseJson: string,
    answeredAtMs: number,
    answeredBy?: string | null,
  ) {
    return runPromise(
      this.answerHumanRequestEffect(
        requestId,
        responseJson,
        answeredAtMs,
        answeredBy,
      ),
    );
  }

  cancelHumanRequestEffect(requestId: string) {
    return this.writeEffect(`cancel human request ${requestId}`, () =>
      this.internalStorage.updateWhere(
        "_smithers_human_requests",
        {
          status: "cancelled",
        },
        "request_id = ? AND status = ?",
        [requestId, "pending"],
      ),
    );
  }

  cancelHumanRequest(requestId: string) {
    return runPromise(this.cancelHumanRequestEffect(requestId));
  }

  insertSignalWithNextSeqEffect(row: {
    runId: string;
    signalName: string;
    correlationId: string | null;
    payloadJson: string;
    receivedAtMs: number;
    receivedBy?: string | null;
  }) {
    const label = `insert signal ${row.signalName}`;
    const self = this;
    return withSqliteWriteRetryEffect(
      () =>
        Effect.gen(function* () {
          const existing = yield* self.readEffect(label, () =>
            self.internalStorage.queryOne<{ seq: number }>(
              `SELECT seq
               FROM _smithers_signals
               WHERE run_id = ?
                 AND signal_name = ?
                 AND ${row.correlationId === null ? "correlation_id IS NULL" : "correlation_id = ?"}
                 AND payload_json = ?
                 AND received_at_ms = ?
                 AND ${row.receivedBy == null ? "received_by IS NULL" : "received_by = ?"}
               ORDER BY seq DESC
               LIMIT 1`,
              [
                row.runId,
                row.signalName,
                ...(row.correlationId === null ? [] : [row.correlationId]),
                row.payloadJson,
                row.receivedAtMs,
                ...(row.receivedBy == null ? [] : [row.receivedBy]),
              ],
            ),
          );
          if (existing?.seq !== undefined) {
            return existing.seq as number;
          }

          const client = (self.db as any).$client;
          if (
            !client ||
            typeof client.exec !== "function" ||
            typeof client.query !== "function"
          ) {
            const lastSeq = (yield* self.getLastSignalSeqEffect(row.runId)) ?? -1;
            const seq = lastSeq + 1;
            yield* fromPromise("insert fallback signal row", () =>
              self.internalStorage.insertIgnore("_smithers_signals", {
                ...row,
                receivedBy: row.receivedBy ?? null,
                seq,
              }),
            );
            return seq;
          }

          return yield* fromSync("insert signal transaction", () => {
            client.run("BEGIN IMMEDIATE");
            try {
              const res = client
                .query(
                  "SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM _smithers_signals WHERE run_id = ?",
                )
                .get(row.runId);
              const seq = Number(res?.seq ?? 0);
              client
                .query(
                  "INSERT INTO _smithers_signals (run_id, seq, signal_name, correlation_id, payload_json, received_at_ms, received_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
                )
                .run(
                  row.runId,
                  seq,
                  row.signalName,
                  row.correlationId,
                  row.payloadJson,
                  row.receivedAtMs,
                  row.receivedBy ?? null,
                );
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
      Effect.annotateLogs({
        runId: row.runId,
        signalName: row.signalName,
        correlationId: row.correlationId ?? null,
      }),
      Effect.withLogSpan(`db:${label}`),
    );
  }

  insertSignalWithNextSeq(row: {
    runId: string;
    signalName: string;
    correlationId: string | null;
    payloadJson: string;
    receivedAtMs: number;
    receivedBy?: string | null;
  }) {
    return runPromise(this.insertSignalWithNextSeqEffect(row));
  }

  getLastSignalSeqEffect(runId: string) {
    return this.readEffect(`get last signal seq ${runId}`, () =>
      this.internalStorage.getLastSignalSeq(runId),
    );
  }

  getLastSignalSeq(runId: string) {
    return runPromise(this.getLastSignalSeqEffect(runId));
  }

  listSignalsEffect(runId: string, query: SignalQuery = {}) {
    const limit = Math.max(1, Math.floor(query.limit ?? 200));
    return this.readEffect(`list signals ${runId}`, () => {
      const clauses = ["run_id = ?"];
      const params: Array<string | number | null> = [runId];
      if (query.signalName) {
        clauses.push("signal_name = ?");
        params.push(query.signalName);
      }
      if (query.correlationId !== undefined) {
        if (query.correlationId === null) {
          clauses.push("correlation_id IS NULL");
        } else {
          clauses.push("correlation_id = ?");
          params.push(query.correlationId);
        }
      }
      if (typeof query.receivedAfterMs === "number") {
        clauses.push("received_at_ms >= ?");
        params.push(query.receivedAfterMs);
      }
      return this.internalStorage.queryAll(
        `SELECT *
         FROM _smithers_signals
         WHERE ${clauses.join(" AND ")}
         ORDER BY seq ASC
         LIMIT ?`,
        [...params, limit],
      );
    });
  }

  listSignals(runId: string, query: SignalQuery = {}) {
    return runPromise(this.listSignalsEffect(runId, query));
  }

  insertToolCallEffect(row: any) {
    return this.writeEffect(`insert tool call ${row.toolName}`, () =>
      this.internalStorage.insertIgnore("_smithers_tool_calls", row),
    );
  }

  insertToolCall(row: any) {
    return runPromise(this.insertToolCallEffect(row));
  }

  upsertSandboxEffect(row: any) {
    return this.writeEffect(`upsert sandbox ${row.sandboxId}`, () =>
      this.internalStorage.upsert(
        "_smithers_sandboxes",
        row,
        ["runId", "sandboxId"],
      ),
    );
  }

  upsertSandbox(row: any) {
    return runPromise(this.upsertSandboxEffect(row));
  }

  getSandboxEffect(runId: string, sandboxId: string) {
    return this.readEffect(`get sandbox ${sandboxId}`, () =>
      this.internalStorage.queryOne(
        `SELECT *
         FROM _smithers_sandboxes
         WHERE run_id = ? AND sandbox_id = ?
         LIMIT 1`,
        [runId, sandboxId],
      ),
    );
  }

  getSandbox(runId: string, sandboxId: string) {
    return runPromise(this.getSandboxEffect(runId, sandboxId));
  }

  listSandboxesEffect(runId: string) {
    return this.readEffect(`list sandboxes ${runId}`, () =>
      this.internalStorage.queryAll(
        `SELECT *
         FROM _smithers_sandboxes
         WHERE run_id = ?`,
        [runId],
      ),
    );
  }

  listSandboxes(runId: string) {
    return runPromise(this.listSandboxesEffect(runId));
  }

  listToolCallsEffect(runId: string, nodeId: string, iteration: number) {
    return this.readEffect(`list tool calls ${nodeId}`, () =>
      this.internalStorage.queryAll(
        `SELECT *
         FROM _smithers_tool_calls
         WHERE run_id = ? AND node_id = ? AND iteration = ?
         ORDER BY attempt ASC, seq ASC`,
        [runId, nodeId, iteration],
      ),
    );
  }

  listToolCalls(runId: string, nodeId: string, iteration: number) {
    return runPromise(this.listToolCallsEffect(runId, nodeId, iteration));
  }

  insertEventEffect(row: any) {
    return this.writeEffect(`insert event ${row.type}`, () =>
      this.internalStorage.insertIgnore("_smithers_events", row),
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
            self.internalStorage.queryOne<{ seq: number }>(
              `SELECT seq
               FROM _smithers_events
               WHERE run_id = ?
                 AND timestamp_ms = ?
                 AND type = ?
                 AND payload_json = ?
               ORDER BY seq DESC
               LIMIT 1`,
              [row.runId, row.timestampMs, row.type, row.payloadJson],
            ),
          );
          if (existing?.seq !== undefined) {
            return existing.seq as number;
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
              self.internalStorage.insertIgnore("_smithers_events", { ...row, seq }),
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
      this.internalStorage.getLastEventSeq(runId),
    );
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
    return this.readEffect(`list event history ${runId}`, () =>
      this.internalStorage.listEventHistory(runId, query),
    );
  }

  listEventHistory(runId: string, query: EventHistoryQuery = {}) {
    return runPromise(this.listEventHistoryEffect(runId, query));
  }

  countEventHistoryEffect(runId: string, query: EventHistoryQuery = {}) {
    return this.readEffect(`count event history ${runId}`, () =>
      this.internalStorage.countEventHistory(runId, query),
    );
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
      this.internalStorage.listEventsByType(runId, type),
    );
  }

  listEventsByType(runId: string, type: string) {
    return runPromise(this.listEventsByTypeEffect(runId, type));
  }

  insertOrUpdateRalphEffect(row: any) {
    return this.writeEffect(`upsert ralph ${row.ralphId}`, () =>
      this.internalStorage.upsert(
        "_smithers_ralph",
        row,
        ["runId", "ralphId"],
      ),
    );
  }

  insertOrUpdateRalph(row: any) {
    return runPromise(this.insertOrUpdateRalphEffect(row));
  }

  listRalphEffect(runId: string) {
    return this.readEffect(`list ralph ${runId}`, () =>
      this.internalStorage.queryAll(
        `SELECT *
         FROM _smithers_ralph
         WHERE run_id = ?`,
        [runId],
        { booleanColumns: ["done"] },
      ),
    );
  }

  listRalph(runId: string) {
    return runPromise(this.listRalphEffect(runId));
  }

  listPendingApprovalsEffect(runId: string) {
    return this.readEffect(`list pending approvals ${runId}`, () =>
      this.internalStorage.queryAll(
        `SELECT *
         FROM _smithers_approvals
         WHERE run_id = ? AND status = ?`,
        [runId, "requested"],
        { booleanColumns: ["autoApproved"] },
      ),
    );
  }

  listPendingApprovals(runId: string) {
    return runPromise(this.listPendingApprovalsEffect(runId));
  }

  listAllPendingApprovalsEffect() {
    return this.readEffect("list all pending approvals", () =>
      this.internalStorage.queryAll(
        `SELECT
           a.run_id,
           a.node_id,
           a.iteration,
           a.status,
           a.requested_at_ms,
           a.note,
           a.decided_by,
           r.workflow_name,
           r.status AS run_status,
           n.label AS node_label
         FROM _smithers_approvals a
         LEFT JOIN _smithers_runs r ON a.run_id = r.run_id
         LEFT JOIN _smithers_nodes n
           ON a.run_id = n.run_id
          AND a.node_id = n.node_id
          AND a.iteration = n.iteration
         WHERE a.status = ?
         ORDER BY COALESCE(a.requested_at_ms, 0) ASC, a.run_id, a.node_id, a.iteration`,
        ["requested"],
      ),
    );
  }

  listAllPendingApprovals() {
    return runPromise(this.listAllPendingApprovalsEffect());
  }

  listApprovalHistoryForNodeEffect(workflowName: string, nodeId: string, limit = 50) {
    return this.readEffect(`list approval history ${workflowName}:${nodeId}`, () =>
      this.internalStorage.queryAll(
        `SELECT
           a.run_id,
           a.node_id,
           a.iteration,
           a.status,
           a.requested_at_ms,
           a.decided_at_ms,
           a.note,
           a.decided_by,
           a.request_json,
           a.decision_json,
           a.auto_approved,
           r.workflow_name,
           r.created_at_ms AS run_created_at_ms
         FROM _smithers_approvals a
         INNER JOIN _smithers_runs r ON a.run_id = r.run_id
         WHERE r.workflow_name = ? AND a.node_id = ?
         ORDER BY r.created_at_ms DESC, a.decided_at_ms DESC
         LIMIT ?`,
        [workflowName, nodeId, limit],
        { booleanColumns: ["autoApproved"] },
      ),
    );
  }

  listApprovalHistoryForNode(workflowName: string, nodeId: string, limit = 50) {
    return runPromise(this.listApprovalHistoryForNodeEffect(workflowName, nodeId, limit));
  }

  getRalphEffect(runId: string, ralphId: string) {
    return this.readEffect(`get ralph ${ralphId}`, () =>
      this.internalStorage.queryOne(
        `SELECT *
         FROM _smithers_ralph
         WHERE run_id = ? AND ralph_id = ?
         LIMIT 1`,
        [runId, ralphId],
        { booleanColumns: ["done"] },
      ),
    );
  }

  getRalph(runId: string, ralphId: string) {
    return runPromise(this.getRalphEffect(runId, ralphId));
  }

  insertCacheEffect(row: any) {
    return this.writeEffect(`insert cache ${row.cacheKey}`, () =>
      this.internalStorage.insertIgnore("_smithers_cache", row),
    );
  }

  insertCache(row: any) {
    return runPromise(this.insertCacheEffect(row));
  }

  getCacheEffect(cacheKey: string) {
    return this.readEffect(`get cache ${cacheKey}`, () =>
      this.internalStorage.queryOne(
        `SELECT *
         FROM _smithers_cache
         WHERE cache_key = ?
         LIMIT 1`,
        [cacheKey],
      ),
    );
  }

  getCache(cacheKey: string) {
    return runPromise(this.getCacheEffect(cacheKey));
  }

  listCacheByNodeEffect(
    nodeId: string,
    outputTable?: string,
    limit = 20,
  ) {
    return this.readEffect(`list cache by node ${nodeId}`, () =>
      this.internalStorage.queryAll(
        `SELECT *
         FROM _smithers_cache
         WHERE node_id = ?${outputTable ? " AND output_table = ?" : ""}
         ORDER BY created_at_ms DESC
         LIMIT ?`,
        outputTable ? [nodeId, outputTable, limit] : [nodeId, limit],
      ),
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
        self.internalStorage.deleteWhere(
          "_smithers_frames",
          "run_id = ? AND frame_no > ?",
          [runId, frameNo],
        ),
      );
      self.clearFrameCacheForRun(runId);
    });
  }

  deleteFramesAfter(runId: string, frameNo: number) {
    return runPromise(this.deleteFramesAfterEffect(runId, frameNo));
  }

  listFramesEffect(runId: string, limit: number, afterFrameNo?: number) {
    const self = this;
    return Effect.gen(function* () {
      const rows = (yield* self.readEffect(`list frames ${runId}`, () =>
        self.internalStorage.queryAll(
          `SELECT *
           FROM _smithers_frames
           WHERE run_id = ?${afterFrameNo !== undefined ? " AND frame_no > ?" : ""}
           ORDER BY frame_no DESC
           LIMIT ?`,
          afterFrameNo !== undefined
            ? [runId, afterFrameNo, limit]
            : [runId, limit],
        ),
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
      this.internalStorage.queryAll(
        `SELECT state, COUNT(*) AS count
         FROM _smithers_nodes
         WHERE run_id = ?
         GROUP BY state`,
        [runId],
      ),
    );
  }

  countNodesByState(runId: string) {
    return runPromise(this.countNodesByStateEffect(runId));
  }

  upsertCronEffect(row: any) {
    return this.writeEffect("upsert cron", () =>
      this.internalStorage.upsert(
        "_smithers_cron",
        row,
        ["cronId"],
        ["pattern", "workflowPath", "enabled", "nextRunAtMs"],
      ),
    );
  }

  upsertCron(row: any) {
    return runPromise(this.upsertCronEffect(row));
  }

  listCronsEffect(enabledOnly = true) {
    return this.readEffect("list crons", () =>
      this.internalStorage.queryAll(
        `SELECT *
         FROM _smithers_cron${enabledOnly ? " WHERE enabled = ?" : ""}`,
        enabledOnly ? [true] : [],
        { booleanColumns: ["enabled"] },
      ),
    );
  }

  listCrons(enabledOnly = true) {
    return runPromise(this.listCronsEffect(enabledOnly));
  }

  updateCronRunTimeEffect(cronId: string, lastRunAtMs: number, nextRunAtMs: number, errorJson?: string | null) {
    return this.writeEffect(`update cron run time ${cronId}`, () =>
      this.internalStorage.updateWhere(
        "_smithers_cron",
        { lastRunAtMs, nextRunAtMs, errorJson: errorJson ?? null },
        "cron_id = ?",
        [cronId],
      ),
    );
  }

  updateCronRunTime(cronId: string, lastRunAtMs: number, nextRunAtMs: number, errorJson?: string | null) {
    return runPromise(this.updateCronRunTimeEffect(cronId, lastRunAtMs, nextRunAtMs, errorJson));
  }

  deleteCronEffect(cronId: string) {
    return this.writeEffect(`delete cron ${cronId}`, () =>
      this.internalStorage.deleteWhere("_smithers_cron", "cron_id = ?", [cronId]),
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
      this.internalStorage.insertIgnore("_smithers_scorers", row),
    );
  }

  insertScorerResult(row: any) {
    return runPromise(this.insertScorerResultEffect(row));
  }

  listScorerResultsEffect(runId: string, nodeId?: string) {
    return this.readEffect(`list scorer results ${runId}`, () =>
      this.internalStorage.queryAll(
        `SELECT *
         FROM _smithers_scorers
         WHERE run_id = ?${nodeId ? " AND node_id = ?" : ""}
         ORDER BY scored_at_ms ASC`,
        nodeId ? [runId, nodeId] : [runId],
      ),
    );
  }

  listScorerResults(runId: string, nodeId?: string) {
    return runPromise(this.listScorerResultsEffect(runId, nodeId));
  }
}
