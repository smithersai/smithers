import { getTableName, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Effect, Exit, FiberId, Metric } from "effect";
import { fromPromise, fromSync } from "@smithers/driver/interop";
import { getSqlMessageStorage, type SqlMessageStorage } from "./sql-message-storage";
import type {
  HumanRequestKind,
  HumanRequestStatus,
} from "@smithers/durables";
import {
  alertsAcknowledgedTotal,
  alertsActive,
  alertsFiredTotal,
  dbQueryDuration,
  dbTransactionDuration,
  dbTransactionRetries,
  dbTransactionRollbacks,
} from "@smithers/observability/metrics";
import { toSmithersError } from "@smithers/errors/toSmithersError";
import type { SmithersError } from "@smithers/errors/SmithersError";
import {
  assertOptionalStringMaxLength,
  assertPositiveFiniteNumber,
} from "./input-bounds";
import {
  FRAME_KEYFRAME_INTERVAL,
  applyFrameDeltaJson,
  encodeFrameDelta,
  normalizeFrameEncoding,
  serializeFrameDelta,
  type FrameEncoding,
} from "./frame-codec";
import { getKeyColumns, type OutputKey } from "./output";
import { withSqliteWriteRetry } from "./write-retry";
import { camelToSnake } from "./utils/camelToSnake";

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

export type NodeRow = {
  runId: string;
  nodeId: string;
  iteration: number;
  state: string;
  lastAttempt: number | null;
  updatedAtMs: number;
  outputTable: string;
  label: string | null;
};

export type AttemptRow = {
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  state: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  heartbeatAtMs: number | null;
  heartbeatDataJson: string | null;
  errorJson: string | null;
  jjPointer: string | null;
  responseText: string | null;
  jjCwd: string | null;
  cached: boolean;
  metaJson: string | null;
};

export type ApprovalRow = {
  runId: string;
  nodeId: string;
  iteration: number;
  status: string;
  requestedAtMs: number | null;
  decidedAtMs: number | null;
  note: string | null;
  decidedBy: string | null;
  requestJson: string | null;
  decisionJson: string | null;
  autoApproved: boolean;
};

export type CacheRow = {
  cacheKey: string;
  createdAtMs: number;
  workflowName: string;
  nodeId: string;
  outputTable: string;
  schemaSig: string;
  agentSig: string | null;
  toolsSig: string | null;
  jjPointer: string | null;
  payloadJson: string;
};

export type SignalRow = {
  runId: string;
  seq: number;
  signalName: string;
  correlationId: string | null;
  payloadJson: string;
  receivedAtMs: number;
  receivedBy: string | null;
};

export type PendingHumanRequestRow = HumanRequestRow & {
  workflowName: string | null;
  runStatus: string | null;
  nodeLabel: string | null;
};

export const DB_ALERT_ID_MAX_LENGTH = 256;
export const DB_ALERT_POLICY_NAME_MAX_LENGTH = 256;
export const DB_ALERT_MESSAGE_MAX_LENGTH = 4096;
export const DB_ALERT_ALLOWED_SEVERITIES = [
  "info",
  "warning",
  "critical",
] as const;
export type AlertSeverity = (typeof DB_ALERT_ALLOWED_SEVERITIES)[number];
export const DB_ALERT_ALLOWED_STATUSES = [
  "firing",
  "acknowledged",
  "resolved",
  "silenced",
] as const;
export type AlertStatus = (typeof DB_ALERT_ALLOWED_STATUSES)[number];
export type AlertRow = {
  alertId: string;
  runId: string | null;
  policyName: string;
  severity: AlertSeverity;
  status: AlertStatus;
  firedAtMs: number;
  resolvedAtMs: number | null;
  acknowledgedAtMs: number | null;
  message: string;
  detailsJson: string | null;
  fingerprint?: string | null;
  nodeId?: string | null;
  iteration?: number | null;
  owner?: string | null;
  runbook?: string | null;
  labelsJson?: string | null;
  reactionJson?: string | null;
  sourceEventType?: string | null;
  firstFiredAtMs?: number | null;
  lastFiredAtMs?: number | null;
  occurrenceCount?: number;
  silencedUntilMs?: number | null;
  acknowledgedBy?: string | null;
  resolvedBy?: string | null;
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
const RUN_HEARTBEAT_STALE_MS = 30_000;
const RAW_QUERY_ALLOWED_PREFIX = /^(?:select|with|explain|values)\b/i;
const RAW_QUERY_FORBIDDEN_KEYWORDS = /\b(?:drop|delete|insert|update|alter|create|attach|detach|pragma)\b/i;
const ACTIVE_ALERT_STATUSES = new Set<AlertStatus>([
  "firing",
  "acknowledged",
  "silenced",
]);

function stripSqlCommentsAndLiterals(queryString: string): string {
  let sanitized = "";
  let index = 0;
  while (index < queryString.length) {
    const char = queryString[index];
    const nextChar = queryString[index + 1];

    if (char === "-" && nextChar === "-") {
      sanitized += " ";
      index += 2;
      while (index < queryString.length && queryString[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (char === "/" && nextChar === "*") {
      sanitized += " ";
      index += 2;
      while (index < queryString.length) {
        if (queryString[index] === "*" && queryString[index + 1] === "/") {
          index += 2;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (char === "'" || char === "\"" || char === "`") {
      const quote = char;
      sanitized += " ";
      index += 1;
      while (index < queryString.length) {
        if (queryString[index] === quote) {
          if (queryString[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (char === "[") {
      sanitized += " ";
      index += 1;
      while (index < queryString.length) {
        if (queryString[index] === "]") {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    sanitized += char;
    index += 1;
  }
  return sanitized;
}

function validateReadOnlyRawQuery(queryString: string): string {
  const trimmedQuery = queryString.trim();
  if (!trimmedQuery) {
    throw toSmithersError(new Error("Raw query must not be empty"), undefined, {
      code: "INVALID_INPUT",
      details: { operation: "raw query validation" },
    });
  }

  const sanitizedQuery = stripSqlCommentsAndLiterals(trimmedQuery).trim();
  if (!sanitizedQuery) {
    throw toSmithersError(new Error("Raw query must not be empty"), undefined, {
      code: "INVALID_INPUT",
      details: { operation: "raw query validation" },
    });
  }

  const singleStatementQuery = sanitizedQuery.replace(/;+\s*$/, "").trim();
  if (singleStatementQuery.includes(";")) {
    throw toSmithersError(
      new Error("Raw query must contain a single read-only SQL statement"),
      undefined,
      {
        code: "INVALID_INPUT",
        details: { operation: "raw query validation" },
      },
    );
  }

  const forbiddenKeyword = singleStatementQuery.match(RAW_QUERY_FORBIDDEN_KEYWORDS)?.[0];
  if (forbiddenKeyword) {
    throw toSmithersError(
      new Error(`Raw query cannot use ${forbiddenKeyword.toUpperCase()} statements`),
      undefined,
      {
        code: "INVALID_INPUT",
        details: {
          operation: "raw query validation",
          keyword: forbiddenKeyword.toUpperCase(),
        },
      },
    );
  }

  if (!RAW_QUERY_ALLOWED_PREFIX.test(singleStatementQuery)) {
    throw toSmithersError(
      new Error("Raw query only supports read-only SELECT, WITH, EXPLAIN, or VALUES statements"),
      undefined,
      {
        code: "INVALID_INPUT",
        details: { operation: "raw query validation" },
      },
    );
  }

  return trimmedQuery;
}

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

function validateAlertSeverity(severity: unknown) {
  if (
    typeof severity !== "string" ||
    !DB_ALERT_ALLOWED_SEVERITIES.includes(
      severity as (typeof DB_ALERT_ALLOWED_SEVERITIES)[number],
    )
  ) {
    throw toSmithersError(
      new Error("Invalid alert severity"),
      `Alert severity must be one of: ${DB_ALERT_ALLOWED_SEVERITIES.join(", ")}`,
      {
        code: "INVALID_INPUT",
        details: { severity },
      },
    );
  }
}

function validateAlertStatus(status: unknown) {
  if (
    typeof status !== "string" ||
    !DB_ALERT_ALLOWED_STATUSES.includes(
      status as (typeof DB_ALERT_ALLOWED_STATUSES)[number],
    )
  ) {
    throw toSmithersError(
      new Error("Invalid alert status"),
      `Alert status must be one of: ${DB_ALERT_ALLOWED_STATUSES.join(", ")}`,
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

function validateAlertRow(row: AlertRow) {
  if (!row || typeof row !== "object") {
    throw toSmithersError(
      new Error("Invalid alert row"),
      "Alert row must be an object",
      { code: "INVALID_INPUT" },
    );
  }

  assertOptionalStringMaxLength("alertId", row.alertId, DB_ALERT_ID_MAX_LENGTH);
  assertOptionalStringMaxLength("runId", row.runId, DB_RUN_ID_MAX_LENGTH);
  assertOptionalStringMaxLength(
    "policyName",
    row.policyName,
    DB_ALERT_POLICY_NAME_MAX_LENGTH,
  );
  assertOptionalStringMaxLength(
    "message",
    row.message,
    DB_ALERT_MESSAGE_MAX_LENGTH,
  );

  if (typeof row.alertId !== "string" || row.alertId.length === 0) {
    throw toSmithersError(
      new Error("Invalid alert ID"),
      "Alert ID must be a non-empty string",
      { code: "INVALID_INPUT", details: { alertId: row.alertId } },
    );
  }
  if (row.runId !== null && row.runId !== undefined && typeof row.runId !== "string") {
    throw toSmithersError(
      new Error("Invalid alert run ID"),
      "Alert run ID must be a string or null",
      { code: "INVALID_INPUT", details: { runId: row.runId } },
    );
  }
  if (typeof row.policyName !== "string" || row.policyName.length === 0) {
    throw toSmithersError(
      new Error("Invalid alert policy name"),
      "Alert policy name must be a non-empty string",
      { code: "INVALID_INPUT", details: { policyName: row.policyName } },
    );
  }
  if (typeof row.message !== "string" || row.message.length === 0) {
    throw toSmithersError(
      new Error("Invalid alert message"),
      "Alert message must be a non-empty string",
      { code: "INVALID_INPUT", details: { message: row.message } },
    );
  }
  if (
    row.detailsJson !== null &&
    row.detailsJson !== undefined &&
    typeof row.detailsJson !== "string"
  ) {
    throw toSmithersError(
      new Error("Invalid alert details JSON"),
      "Alert details JSON must be a string or null",
      { code: "INVALID_INPUT", details: { detailsJson: row.detailsJson } },
    );
  }

  validateAlertSeverity(row.severity);
  validateAlertStatus(row.status);
  validateOptionalPositiveTimestamp(row as Record<string, unknown>, "firedAtMs");
  validateOptionalPositiveTimestamp(
    row as Record<string, unknown>,
    "resolvedAtMs",
  );
  validateOptionalPositiveTimestamp(
    row as Record<string, unknown>,
    "acknowledgedAtMs",
  );
}

function isAlertActiveStatus(status: string | null | undefined): status is AlertStatus {
  return status !== undefined && status !== null && ACTIVE_ALERT_STATUSES.has(status as AlertStatus);
}

function classifyRunRowStatus<T extends { status: string; heartbeatAtMs: number | null }>(row: T): T {
  const isRunHeartbeatFresh = Boolean(
    row.status === "running" &&
      typeof row.heartbeatAtMs === "number" &&
      Date.now() - row.heartbeatAtMs <= RUN_HEARTBEAT_STALE_MS,
  );
  if (
    row.status === "running" &&
    typeof row.heartbeatAtMs === "number" &&
    row.heartbeatAtMs > 0 &&
    !isRunHeartbeatFresh
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

  rawQuery(queryString: string) {
    const self = this;
    return Effect.gen(function* () {
      const validatedQuery = yield* fromSync(
        "validate raw query",
        () => validateReadOnlyRawQuery(queryString),
        {
          code: "INVALID_INPUT",
          details: { operation: "raw query validation" },
        },
      );
      return yield* self.read(`raw query ${validatedQuery.slice(0, 20)}`, () => {
        const client = (self.db as any).session.client;
        const stmt = client.query(validatedQuery);
        return Promise.resolve(stmt.all());
      });
    });
  }

  private ownsActiveTransaction(currentFiberThread: string): boolean {
    return (
      this.transactionDepth > 0 &&
      this.transactionOwnerThread === currentFiberThread
    );
  }

  private read<A>(
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
        const releaseTurn = yield* self.acquireTransactionTurn();
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

  private write<A>(
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
        const releaseTurn = yield* self.acquireTransactionTurn();
        result = yield* withSqliteWriteRetry(
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

  private getSqliteTransactionClient() {
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

  private acquireTransactionTurn() {
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

  withTransaction<A>(
    writeGroup: string,
    operation: Effect.Effect<A, SmithersError>,
  ): Effect.Effect<A, SmithersError> {
    const self = this;
    const label = `sqlite transaction ${writeGroup}`;

    return withSqliteWriteRetry(
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
          const releaseTurn = yield* self.acquireTransactionTurn();
          const start = performance.now();
          return yield* Effect.gen(function* () {
            const client = yield* self.getSqliteTransactionClient();
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

  insertRun(row: any) {
    validateRunRow(row);
    return this.write("insert run", () =>
      this.internalStorage.insertIgnore("_smithers_runs", row),
    );
  }

  updateRun(runId: string, patch: any) {
    validateRunPatch(patch);
    return this.write(`update run ${runId}`, () =>
      this.internalStorage.updateWhere("_smithers_runs", patch, "run_id = ?", [runId]),
    );
  }

  heartbeatRun(
    runId: string,
    runtimeOwnerId: string,
    heartbeatAtMs: number,
  ) {
    return this.write(`heartbeat run ${runId}`, () =>
      this.internalStorage.updateWhere(
        "_smithers_runs",
        { heartbeatAtMs },
        "run_id = ? AND runtime_owner_id = ?",
        [runId, runtimeOwnerId],
      ),
    );
  }

  requestRunCancel(runId: string, cancelRequestedAtMs: number) {
    return this.write(`cancel run ${runId}`, () =>
      this.internalStorage.updateWhere(
        "_smithers_runs",
        { cancelRequestedAtMs },
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
    return this.write(`hijack run ${runId}`, () =>
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

  clearRunHijack(runId: string) {
    return this.write(`clear hijack run ${runId}`, () =>
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

  getRun(runId: string) {
    return this.read(`get run ${runId}`, async () => {
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

  listRunAncestry(runId: string, limit = 1000) {
    return this.read(`list run ancestry ${runId}`, () =>
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

  getLatestChildRun(parentRunId: string) {
    return this.read(`get latest child run ${parentRunId}`, () =>
      this.internalStorage.queryOne<RunRow>(
        `SELECT *
         FROM _smithers_runs
         WHERE parent_run_id = ?
         ORDER BY created_at_ms DESC
         LIMIT 1`,
        [parentRunId],
      ),
    );
  }

  listRuns(limit = 50, status?: string) {
    return this.read(`list runs ${status ?? "all"}`, async () => {
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

  listStaleRunningRuns(staleBeforeMs: number, limit = 1000) {
    return this.read(
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

  claimRunForResume(params: {
    runId: string;
    expectedStatus?: string;
    expectedRuntimeOwnerId: string | null;
    expectedHeartbeatAtMs: number | null;
    staleBeforeMs: number;
    claimOwnerId: string;
    claimHeartbeatAtMs: number;
    requireStale?: boolean;
  }) {
    return this.write(`claim stale run ${params.runId}`, () => {
      const client = (this.db as any).session.client;
      const expectedStatus = params.expectedStatus ?? "running";
      const requireStale =
        params.requireStale ?? expectedStatus === "running";
      client
        .query(
          `UPDATE _smithers_runs
           SET runtime_owner_id = ?, heartbeat_at_ms = ?
           WHERE run_id = ?
             AND status = ?
             AND COALESCE(runtime_owner_id, '') = COALESCE(?, '')
             AND COALESCE(heartbeat_at_ms, -1) = COALESCE(?, -1)
             AND (? = 0 OR heartbeat_at_ms IS NULL OR heartbeat_at_ms < ?)`,
        )
        .run(
          params.claimOwnerId,
          params.claimHeartbeatAtMs,
          params.runId,
          expectedStatus,
          params.expectedRuntimeOwnerId,
          params.expectedHeartbeatAtMs,
          requireStale ? 1 : 0,
          params.staleBeforeMs,
        );
      return this.internalStorage
        .queryOne<{ count: number }>("SELECT changes() AS count")
        .then((row) => Number(row?.count ?? 0) > 0);
    });
  }

  releaseRunResumeClaim(params: {
    runId: string;
    claimOwnerId: string;
    restoreRuntimeOwnerId: string | null;
    restoreHeartbeatAtMs: number | null;
  }) {
    return this.write(`release stale run claim ${params.runId}`, () => {
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

  updateClaimedRun(params: {
    runId: string;
    expectedRuntimeOwnerId: string;
    expectedHeartbeatAtMs: number | null;
    patch: any;
  }) {
    validateRunPatch(params.patch);
    return this.write(`update claimed run ${params.runId}`, () => {
      const client = (this.db as any).session.client;
      const patchEntries = Object.entries(params.patch);
      if (patchEntries.length === 0) {
        return Promise.resolve(true);
      }
      const assignments = patchEntries.map(([key]) => `${camelToSnake(key)} = ?`);
      client
        .query(
          `UPDATE _smithers_runs
           SET ${assignments.join(", ")}
           WHERE run_id = ?
             AND runtime_owner_id = ?
             AND COALESCE(heartbeat_at_ms, -1) = COALESCE(?, -1)`,
        )
        .run(
          ...patchEntries.map(([, value]) => value),
          params.runId,
          params.expectedRuntimeOwnerId,
          params.expectedHeartbeatAtMs,
        );
      return this.internalStorage
        .queryOne<{ count: number }>("SELECT changes() AS count")
        .then((row) => Number(row?.count ?? 0) > 0);
    });
  }

  insertNode(row: any) {
    return this.write(`insert node ${row.nodeId}`, () =>
      this.internalStorage.upsert(
        "_smithers_nodes",
        row,
        ["runId", "nodeId", "iteration"],
      ),
    );
  }

  getNode(runId: string, nodeId: string, iteration: number) {
    return this.read(`get node ${nodeId}`, () =>
      this.internalStorage.queryOne<NodeRow>(
        `SELECT *
         FROM _smithers_nodes
         WHERE run_id = ? AND node_id = ? AND iteration = ?
         LIMIT 1`,
        [runId, nodeId, iteration],
      ),
    );
  }

  listNodeIterations(runId: string, nodeId: string) {
    return this.read(`list node iterations ${nodeId}`, () =>
      this.internalStorage.queryAll<NodeRow>(
        `SELECT *
         FROM _smithers_nodes
         WHERE run_id = ? AND node_id = ?
         ORDER BY iteration DESC`,
        [runId, nodeId],
      ),
    );
  }

  listNodes(runId: string) {
    return this.read(`list nodes ${runId}`, () =>
      this.internalStorage.queryAll<NodeRow>(
        `SELECT *
         FROM _smithers_nodes
         WHERE run_id = ?`,
        [runId],
      ),
    );
  }

  upsertOutputRow(
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

    return this.write(`upsert output ${tableName}`, () =>
      this.db
        .insert(table)
        .values(values)
        .onConflictDoUpdate({
          target: target as any,
          set: values,
        }),
    );
  }

  deleteOutputRow(tableName: string, key: OutputKey) {
    return this.write(`delete output ${tableName}`, () => {
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

  getRawNodeOutput(tableName: string, runId: string, nodeId: string) {
    return this.read(`get raw node output ${tableName}`, () => {
      const query = sql.raw(`SELECT * FROM "${tableName}" WHERE run_id = '${runId}' AND node_id = '${nodeId}' ORDER BY iteration DESC LIMIT 1`);
      const res = this.db.get(query);
      return Promise.resolve(res ?? null);
    }).pipe(
      Effect.catchAll(() => Effect.succeed(null))
    );
  }

  getRawNodeOutputForIteration(
    tableName: string,
    runId: string,
    nodeId: string,
    iteration: number,
  ) {
    return this.read(
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

  insertAttempt(row: any) {
    return this.write(`insert attempt ${row.nodeId}#${row.attempt}`, () =>
      this.internalStorage.upsert(
        "_smithers_attempts",
        row,
        ["runId", "nodeId", "iteration", "attempt"],
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
    return this.write(`update attempt ${nodeId}#${attempt}`, () =>
      this.internalStorage.updateWhere(
        "_smithers_attempts",
        patch,
        "run_id = ? AND node_id = ? AND iteration = ? AND attempt = ?",
        [runId, nodeId, iteration, attempt],
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
    return this.write(`heartbeat attempt ${nodeId}#${attempt}`, () =>
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

  listAttempts(runId: string, nodeId: string, iteration: number): Effect.Effect<AttemptRow[], SmithersError> {
    return this.read(`list attempts ${nodeId}`, () =>
      this.internalStorage.queryAll<AttemptRow>(
        `SELECT *
         FROM _smithers_attempts
         WHERE run_id = ? AND node_id = ? AND iteration = ?
         ORDER BY attempt DESC`,
        [runId, nodeId, iteration],
        { booleanColumns: ["cached"] },
      ),
    );
  }

  listAttemptsForRun(runId: string): Effect.Effect<AttemptRow[], SmithersError> {
    return this.read(`list attempts for run ${runId}`, () =>
      this.internalStorage.queryAll<AttemptRow>(
        `SELECT *
         FROM _smithers_attempts
         WHERE run_id = ?
         ORDER BY started_at_ms ASC, node_id ASC, iteration ASC, attempt ASC`,
        [runId],
        { booleanColumns: ["cached"] },
      ),
    );
  }

  getAttempt(
    runId: string,
    nodeId: string,
    iteration: number,
    attempt: number,
  ): Effect.Effect<AttemptRow | undefined, SmithersError> {
    return this.read(`get attempt ${nodeId}#${attempt}`, () =>
      this.internalStorage.queryOne<AttemptRow>(
        `SELECT *
         FROM _smithers_attempts
         WHERE run_id = ? AND node_id = ? AND iteration = ? AND attempt = ?
         LIMIT 1`,
        [runId, nodeId, iteration, attempt],
        { booleanColumns: ["cached"] },
      ),
    );
  }

  listInProgressAttempts(runId: string): Effect.Effect<AttemptRow[], SmithersError> {
    return this.read(`list in-progress attempts ${runId}`, () =>
      this.internalStorage.queryAll<AttemptRow>(
        `SELECT *
         FROM _smithers_attempts
         WHERE run_id = ? AND state = ?`,
        [runId, "in-progress"],
        { booleanColumns: ["cached"] },
      ),
    );
  }

  listAllInProgressAttempts(): Effect.Effect<any[], SmithersError> {
    return this.read("list all in-progress attempts", () =>
      this.internalStorage.queryAll<any>(
        `SELECT *
         FROM _smithers_attempts
         WHERE state = ?`,
        ["in-progress"],
        { booleanColumns: ["cached"] },
      ),
    );
  }

  private listFrameChainDesc(
    runId: string,
    frameNo: number,
    limit?: number,
  ) {
    return this.read(`list frame chain ${runId}:${frameNo}`, () =>
      this.internalStorage.queryAll(
        `SELECT *
         FROM _smithers_frames
         WHERE run_id = ? AND frame_no <= ?
         ORDER BY frame_no DESC${typeof limit === "number" ? " LIMIT ?" : ""}`,
        typeof limit === "number" ? [runId, frameNo, limit] : [runId, frameNo],
      ),
    );
  }

  private reconstructFrameXml(
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

      let rows = (yield* self.listFrameChainDesc(
        runId,
        frameNo,
        FRAME_KEYFRAME_INTERVAL + 2,
      )) as any[];
      if (rows.length === 0) return undefined;

      let anchorIndex = rows.findIndex(
        (row) => normalizeFrameEncoding(row.encoding) !== "delta",
      );

      if (anchorIndex < 0) {
        rows = (yield* self.listFrameChainDesc(runId, frameNo)) as any[];
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

  private inflateFrameRow(
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

      const xmlJson = yield* self.reconstructFrameXml(
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

  insertFrame(row: any) {
    const self = this;
    return Effect.gen(function* () {
      const runId = String(row.runId);
      const frameNo = Number(row.frameNo);
      const fullXmlJson = String(row.xmlJson ?? "null");

      let encoding: FrameEncoding = "keyframe";
      let persistedXmlJson = fullXmlJson;

      if (frameNo > 0 && frameNo % FRAME_KEYFRAME_INTERVAL !== 0) {
        const previousXmlJson = yield* self.reconstructFrameXml(
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

      yield* self.write(`insert frame ${frameNo}`, () =>
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

  getLastFrame(runId: string) {
    const self = this;
    return Effect.gen(function* () {
      const row = yield* self.read(`get last frame ${runId}`, () =>
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
      return yield* self.inflateFrameRow(row);
    });
  }


  insertOrUpdateApproval(row: any) {
    return this.write(`upsert approval ${row.nodeId}`, () =>
      this.internalStorage.upsert(
        "_smithers_approvals",
        row,
        ["runId", "nodeId", "iteration"],
      ),
    );
  }

  getApproval(runId: string, nodeId: string, iteration: number) {
    return this.read(`get approval ${nodeId}`, () =>
      this.internalStorage.queryOne<ApprovalRow>(
        `SELECT *
         FROM _smithers_approvals
         WHERE run_id = ? AND node_id = ? AND iteration = ?
         LIMIT 1`,
        [runId, nodeId, iteration],
        { booleanColumns: ["autoApproved"] },
      ),
    );
  }

  insertHumanRequest(row: HumanRequestRow) {
    return this.write(`insert human request ${row.requestId}`, () =>
      this.internalStorage.insertIgnore("_smithers_human_requests", row),
    );
  }

  getHumanRequest(requestId: string) {
    return this.read(`get human request ${requestId}`, () =>
      this.internalStorage.queryOne<HumanRequestRow>(
        `SELECT *
         FROM _smithers_human_requests
         WHERE request_id = ?
         LIMIT 1`,
        [requestId],
      ),
    );
  }

  reopenHumanRequest(requestId: string) {
    return this.write(`reopen human request ${requestId}`, () =>
      this.internalStorage.updateWhere(
        "_smithers_human_requests",
        {
          status: "pending",
          responseJson: null,
          answeredAtMs: null,
          answeredBy: null,
        },
        "request_id = ? AND status = ?",
        [requestId, "answered"],
      ),
    );
  }

  expireStaleHumanRequests(nowMs = Date.now()) {
    return this.write(`expire stale human requests before ${nowMs}`, () =>
      this.internalStorage.updateWhere(
        "_smithers_human_requests",
        {
          status: "expired",
          responseJson: null,
          answeredAtMs: null,
          answeredBy: null,
        },
        "status = ? AND timeout_at_ms IS NOT NULL AND timeout_at_ms <= ?",
        ["pending", nowMs],
      ),
    );
  }

  listPendingHumanRequests(nowMs = Date.now()) {
    const self = this;
    return Effect.gen(function* () {
      yield* self.expireStaleHumanRequests(nowMs);
      return yield* self.read("list pending human requests", () =>
        self.internalStorage.queryAll<PendingHumanRequestRow>(
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
    });
  }

  answerHumanRequest(
    requestId: string,
    responseJson: string,
    answeredAtMs: number,
    answeredBy?: string | null,
  ) {
    return this.write(`answer human request ${requestId}`, () =>
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

  cancelHumanRequest(requestId: string) {
    return this.write(`cancel human request ${requestId}`, () =>
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

  insertAlert(row: AlertRow) {
    validateAlertRow(row);
    const self = this;
    return this.withTransaction(
      `insert alert ${row.alertId}`,
      Effect.gen(function* () {
        const existing = yield* self.getAlert(row.alertId);
        if (existing) {
          return existing;
        }

        yield* self.write(`insert alert ${row.alertId}`, () =>
          self.internalStorage.insertIgnore("_smithers_alerts", row),
        );
        yield* Metric.increment(
          Metric.tagged(
            Metric.tagged(alertsFiredTotal, "policy", row.policyName),
            "severity",
            row.severity,
          ),
        );
        if (isAlertActiveStatus(row.status)) {
          yield* Metric.update(alertsActive, 1);
        }
        return yield* self.getAlert(row.alertId);
      }),
    );
  }

  getAlert(alertId: string) {
    return this.read(`get alert ${alertId}`, () =>
      this.internalStorage.queryOne<AlertRow>(
        `SELECT *
         FROM _smithers_alerts
         WHERE alert_id = ?
         LIMIT 1`,
        [alertId],
      ),
    );
  }

  listAlerts(limit = 100, statuses?: readonly AlertStatus[]) {
    if (statuses) {
      for (const status of statuses) {
        validateAlertStatus(status);
      }
    }

    const normalizedLimit = Math.max(1, Math.floor(limit));
    return this.read("list alerts", () => {
      const clauses: string[] = [];
      const params: Array<string | number> = [];

      if (statuses && statuses.length > 0) {
        clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
        params.push(...statuses);
      }

      const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      return this.internalStorage.queryAll<AlertRow>(
        `SELECT *
         FROM _smithers_alerts
         ${whereSql}
         ORDER BY
           CASE status
             WHEN 'firing' THEN 0
             WHEN 'acknowledged' THEN 1
             WHEN 'silenced' THEN 2
             WHEN 'resolved' THEN 3
             ELSE 4
           END,
           fired_at_ms DESC,
           alert_id ASC
         LIMIT ?`,
        [...params, normalizedLimit],
      );
    });
  }

  acknowledgeAlert(alertId: string, acknowledgedAtMs = Date.now()) {
    validateOptionalPositiveTimestamp(
      { acknowledgedAtMs },
      "acknowledgedAtMs",
    );
    const self = this;
    return this.withTransaction(
      `acknowledge alert ${alertId}`,
      Effect.gen(function* () {
        const alert = yield* self.getAlert(alertId);
        if (!alert) {
          return undefined;
        }
        if (alert.status !== "firing") {
          return alert;
        }

        yield* self.write(`acknowledge alert ${alertId}`, () =>
          self.internalStorage.updateWhere(
            "_smithers_alerts",
            {
              status: "acknowledged",
              acknowledgedAtMs,
            },
            "alert_id = ? AND status = ?",
            [alertId, "firing"],
          ),
        );
        yield* Metric.increment(
          Metric.tagged(alertsAcknowledgedTotal, "policy", alert.policyName),
        );
        return yield* self.getAlert(alertId);
      }),
    );
  }

  resolveAlert(alertId: string, resolvedAtMs = Date.now()) {
    validateOptionalPositiveTimestamp({ resolvedAtMs }, "resolvedAtMs");
    const self = this;
    return this.withTransaction(
      `resolve alert ${alertId}`,
      Effect.gen(function* () {
        const alert = yield* self.getAlert(alertId);
        if (!alert) {
          return undefined;
        }
        if (alert.status === "resolved") {
          return alert;
        }

        yield* self.write(`resolve alert ${alertId}`, () =>
          self.internalStorage.updateWhere(
            "_smithers_alerts",
            {
              status: "resolved",
              resolvedAtMs,
            },
            "alert_id = ? AND status != ?",
            [alertId, "resolved"],
          ),
        );
        if (isAlertActiveStatus(alert.status)) {
          yield* Metric.update(alertsActive, -1);
        }
        return yield* self.getAlert(alertId);
      }),
    );
  }

  silenceAlert(alertId: string) {
    const self = this;
    return this.withTransaction(
      `silence alert ${alertId}`,
      Effect.gen(function* () {
        const alert = yield* self.getAlert(alertId);
        if (!alert) {
          return undefined;
        }
        if (alert.status === "resolved" || alert.status === "silenced") {
          return alert;
        }

        yield* self.write(`silence alert ${alertId}`, () =>
          self.internalStorage.updateWhere(
            "_smithers_alerts",
            {
              status: "silenced",
            },
            "alert_id = ? AND status != ? AND status != ?",
            [alertId, "resolved", "silenced"],
          ),
        );
        return yield* self.getAlert(alertId);
      }),
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
    const label = `insert signal ${row.signalName}`;
    const self = this;
    return withSqliteWriteRetry(
      () =>
        Effect.gen(function* () {
          const existing = yield* self.read(label, () =>
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
            const lastSeq = (yield* self.getLastSignalSeq(row.runId)) ?? -1;
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

  getLastSignalSeq(runId: string) {
    return this.read(`get last signal seq ${runId}`, () =>
      this.internalStorage.getLastSignalSeq(runId),
    );
  }

  listSignals(runId: string, query: SignalQuery = {}) {
    const limit = Math.max(1, Math.floor(query.limit ?? 200));
    return this.read(`list signals ${runId}`, () => {
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
      return this.internalStorage.queryAll<SignalRow>(
        `SELECT *
         FROM _smithers_signals
         WHERE ${clauses.join(" AND ")}
         ORDER BY seq ASC
         LIMIT ?`,
        [...params, limit],
      );
    });
  }

  insertToolCall(row: any) {
    return this.write(`insert tool call ${row.toolName}`, () =>
      this.internalStorage.insertIgnore("_smithers_tool_calls", row),
    );
  }

  upsertSandbox(row: any) {
    return this.write(`upsert sandbox ${row.sandboxId}`, () =>
      this.internalStorage.upsert(
        "_smithers_sandboxes",
        row,
        ["runId", "sandboxId"],
      ),
    );
  }

  getSandbox(runId: string, sandboxId: string) {
    return this.read(`get sandbox ${sandboxId}`, () =>
      this.internalStorage.queryOne(
        `SELECT *
         FROM _smithers_sandboxes
         WHERE run_id = ? AND sandbox_id = ?
         LIMIT 1`,
        [runId, sandboxId],
      ),
    );
  }

  listSandboxes(runId: string) {
    return this.read(`list sandboxes ${runId}`, () =>
      this.internalStorage.queryAll(
        `SELECT *
         FROM _smithers_sandboxes
         WHERE run_id = ?`,
        [runId],
      ),
    );
  }

  listToolCalls(runId: string, nodeId: string, iteration: number) {
    return this.read(`list tool calls ${nodeId}`, () =>
      this.internalStorage.queryAll(
        `SELECT *
         FROM _smithers_tool_calls
         WHERE run_id = ? AND node_id = ? AND iteration = ?
         ORDER BY attempt ASC, seq ASC`,
        [runId, nodeId, iteration],
      ),
    );
  }

  insertEvent(row: any) {
    return this.write(`insert event ${row.type}`, () =>
      this.internalStorage.insertIgnore("_smithers_events", row),
    );
  }

  insertEventWithNextSeq(row: {
    runId: string;
    timestampMs: number;
    type: string;
    payloadJson: string;
  }) {
    const label = `insert event ${row.type}`;
    const self = this;
    return withSqliteWriteRetry(
      () =>
        Effect.gen(function* () {
          const existing = yield* self.read(label, () =>
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
            const lastSeq = (yield* self.getLastEventSeq(row.runId)) ?? -1;
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

  getLastEventSeq(runId: string) {
    return this.read(`get last event seq ${runId}`, () =>
      this.internalStorage.getLastEventSeq(runId),
    );
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

  listEventHistory(runId: string, query: EventHistoryQuery = {}) {
    return this.read(`list event history ${runId}`, () =>
      this.internalStorage.listEventHistory(runId, query),
    );
  }

  countEventHistory(runId: string, query: EventHistoryQuery = {}) {
    return this.read(`count event history ${runId}`, () =>
      this.internalStorage.countEventHistory(runId, query),
    );
  }

  listEvents(runId: string, afterSeq: number, limit = 200) {
    return this.listEventHistory(runId, { afterSeq, limit });
  }

  listEventsByType(runId: string, type: string) {
    return this.read(`list events by type ${type}`, () =>
      this.internalStorage.listEventsByType(runId, type),
    );
  }

  insertOrUpdateRalph(row: any) {
    return this.write(`upsert ralph ${row.ralphId}`, () =>
      this.internalStorage.upsert(
        "_smithers_ralph",
        row,
        ["runId", "ralphId"],
      ),
    );
  }

  listRalph(runId: string) {
    return this.read(`list ralph ${runId}`, () =>
      this.internalStorage.queryAll(
        `SELECT *
         FROM _smithers_ralph
         WHERE run_id = ?`,
        [runId],
        { booleanColumns: ["done"] },
      ),
    );
  }

  listPendingApprovals(runId: string) {
    return this.read(`list pending approvals ${runId}`, () =>
      this.internalStorage.queryAll<ApprovalRow>(
        `SELECT *
         FROM _smithers_approvals
         WHERE run_id = ? AND status = ?`,
        [runId, "requested"],
        { booleanColumns: ["autoApproved"] },
      ),
    );
  }

  listAllPendingApprovals() {
    return this.read("list all pending approvals", () =>
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

  listApprovalHistoryForNode(workflowName: string, nodeId: string, limit = 50) {
    return this.read(`list approval history ${workflowName}:${nodeId}`, () =>
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

  getRalph(runId: string, ralphId: string) {
    return this.read(`get ralph ${ralphId}`, () =>
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

  insertCache(row: any) {
    return this.write(`insert cache ${row.cacheKey}`, () =>
      this.internalStorage.insertIgnore("_smithers_cache", row),
    );
  }

  getCache(cacheKey: string) {
    return this.read(`get cache ${cacheKey}`, () =>
      this.internalStorage.queryOne<CacheRow>(
        `SELECT *
         FROM _smithers_cache
         WHERE cache_key = ?
         LIMIT 1`,
        [cacheKey],
      ),
    );
  }

  listCacheByNode(
    nodeId: string,
    outputTable?: string,
    limit = 20,
  ) {
    return this.read(`list cache by node ${nodeId}`, () =>
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

  deleteFramesAfter(runId: string, frameNo: number) {
    const self = this;
    return Effect.gen(function* () {
      yield* self.write(`delete frames after ${frameNo}`, () =>
        self.internalStorage.deleteWhere(
          "_smithers_frames",
          "run_id = ? AND frame_no > ?",
          [runId, frameNo],
        ),
      );
      self.clearFrameCacheForRun(runId);
    });
  }

  listFrames(runId: string, limit: number, afterFrameNo?: number) {
    const self = this;
    return Effect.gen(function* () {
      const rows = (yield* self.read(`list frames ${runId}`, () =>
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
        expanded.push(yield* self.inflateFrameRow(row, localCache));
      }
      return expanded;
    });
  }

  countNodesByState(runId: string) {
    return this.read(`count nodes by state ${runId}`, () =>
      this.internalStorage.queryAll(
        `SELECT state, COUNT(*) AS count
         FROM _smithers_nodes
         WHERE run_id = ?
         GROUP BY state`,
        [runId],
      ),
    );
  }

  upsertCron(row: any) {
    return this.write("upsert cron", () =>
      this.internalStorage.upsert(
        "_smithers_cron",
        row,
        ["cronId"],
        ["pattern", "workflowPath", "enabled", "nextRunAtMs"],
      ),
    );
  }

  listCrons(enabledOnly = true) {
    return this.read("list crons", () =>
      this.internalStorage.queryAll(
        `SELECT *
         FROM _smithers_cron${enabledOnly ? " WHERE enabled = ?" : ""}`,
        enabledOnly ? [true] : [],
        { booleanColumns: ["enabled"] },
      ),
    );
  }

  updateCronRunTime(cronId: string, lastRunAtMs: number, nextRunAtMs: number, errorJson?: string | null) {
    return this.write(`update cron run time ${cronId}`, () =>
      this.internalStorage.updateWhere(
        "_smithers_cron",
        { lastRunAtMs, nextRunAtMs, errorJson: errorJson ?? null },
        "cron_id = ?",
        [cronId],
      ),
    );
  }

  deleteCron(cronId: string) {
    return this.write(`delete cron ${cronId}`, () =>
      this.internalStorage.deleteWhere("_smithers_cron", "cron_id = ?", [cronId]),
    );
  }

  // ---------------------------------------------------------------------------
  // Scorer results
  // ---------------------------------------------------------------------------

  insertScorerResult(row: any) {
    return this.write(`insert scorer result ${row.scorerId}`, () =>
      this.internalStorage.insertIgnore("_smithers_scorers", row),
    );
  }

  listScorerResults(runId: string, nodeId?: string) {
    return this.read(`list scorer results ${runId}`, () =>
      this.internalStorage.queryAll(
        `SELECT *
         FROM _smithers_scorers
         WHERE run_id = ?${nodeId ? " AND node_id = ?" : ""}
         ORDER BY scored_at_ms ASC`,
        nodeId ? [runId, nodeId] : [runId],
      ),
    );
  }
}
