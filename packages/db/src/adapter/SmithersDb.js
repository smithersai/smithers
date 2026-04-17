import { getTableName, sql } from "drizzle-orm";
import { Effect, Exit, FiberId, Metric } from "effect";
import { toSmithersError } from "@smithers/errors/toSmithersError";
import { getSqlMessageStorage } from "../sql-message-storage.js";
import { alertsAcknowledgedTotal, alertsFiredTotal, dbQueryDuration, dbTransactionDuration, dbTransactionRetries, dbTransactionRollbacks, } from "@smithers/observability/metrics";
import { assertOptionalStringMaxLength, assertPositiveFiniteNumber, } from "../input-bounds.js";
import { FRAME_KEYFRAME_INTERVAL, applyFrameDeltaJson, encodeFrameDelta, normalizeFrameEncoding, serializeFrameDelta, } from "../frame-codec.js";
import { getKeyColumns } from "../output.js";
import { withSqliteWriteRetryEffect } from "../write-retry.js";
import { camelToSnake } from "../utils/camelToSnake.js";
import { DB_ALERT_ID_MAX_LENGTH } from "./DB_ALERT_ID_MAX_LENGTH.js";
import { DB_ALERT_POLICY_NAME_MAX_LENGTH } from "./DB_ALERT_POLICY_NAME_MAX_LENGTH.js";
import { DB_ALERT_MESSAGE_MAX_LENGTH } from "./DB_ALERT_MESSAGE_MAX_LENGTH.js";
import { DB_ALERT_ALLOWED_SEVERITIES } from "./DB_ALERT_ALLOWED_SEVERITIES.js";
import { DB_ALERT_ALLOWED_STATUSES } from "./DB_ALERT_ALLOWED_STATUSES.js";
import { DB_RUN_ID_MAX_LENGTH } from "./DB_RUN_ID_MAX_LENGTH.js";
import { DB_RUN_WORKFLOW_NAME_MAX_LENGTH } from "./DB_RUN_WORKFLOW_NAME_MAX_LENGTH.js";
import { DB_RUN_ALLOWED_STATUSES } from "./DB_RUN_ALLOWED_STATUSES.js";
import { alertsActive } from "@smithers/observability/metrics";
/** @typedef {import("./AlertRow.ts").AlertRow} AlertRow */
/** @typedef {import("./AlertStatus.ts").AlertStatus} AlertStatus */
/** @typedef {import("./AttemptRow.ts").AttemptRow} AttemptRow */
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase} BunSQLiteDatabase */
/** @typedef {import("./EventHistoryQuery.ts").EventHistoryQuery} EventHistoryQuery */
/** @typedef {import("./HumanRequestRow.ts").HumanRequestRow} HumanRequestRow */
/** @typedef {import("../output/OutputKey.ts").OutputKey} OutputKey */
/**
 * @template A, E
 * @typedef {Effect.Effect<A, E> & PromiseLike<A>} RunnableEffect
 */
/** @typedef {import("./SignalQuery.ts").SignalQuery} SignalQuery */
/** @typedef {import("@smithers/errors/SmithersError").SmithersError} SmithersError */

const FRAME_XML_CACHE_MAX = 512;
const RUN_HEARTBEAT_STALE_MS = 30_000;
const RAW_QUERY_ALLOWED_PREFIX = /^(?:select|with|explain|values)\b/i;
const RAW_QUERY_FORBIDDEN_KEYWORDS = /\b(?:drop|delete|insert|update|alter|create|attach|detach|pragma)\b/i;
const ACTIVE_ALERT_STATUSES = new Set([
    "firing",
    "acknowledged",
    "silenced",
]);
/**
 * @param {string} queryString
 * @returns {string}
 */
function stripSqlCommentsAndLiterals(queryString) {
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
/**
 * @param {string} queryString
 * @returns {string}
 */
function validateReadOnlyRawQuery(queryString) {
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
        throw toSmithersError(new Error("Raw query must contain a single read-only SQL statement"), undefined, {
            code: "INVALID_INPUT",
            details: { operation: "raw query validation" },
        });
    }
    const forbiddenKeyword = singleStatementQuery.match(RAW_QUERY_FORBIDDEN_KEYWORDS)?.[0];
    if (forbiddenKeyword) {
        throw toSmithersError(new Error(`Raw query cannot use ${forbiddenKeyword.toUpperCase()} statements`), undefined, {
            code: "INVALID_INPUT",
            details: {
                operation: "raw query validation",
                keyword: forbiddenKeyword.toUpperCase(),
            },
        });
    }
    if (!RAW_QUERY_ALLOWED_PREFIX.test(singleStatementQuery)) {
        throw toSmithersError(new Error("Raw query only supports read-only SELECT, WITH, EXPLAIN, or VALUES statements"), undefined, {
            code: "INVALID_INPUT",
            details: { operation: "raw query validation" },
        });
    }
    return trimmedQuery;
}
/**
 * @param {unknown} status
 */
function validateRunStatus(status) {
    if (typeof status !== "string" ||
        !DB_RUN_ALLOWED_STATUSES.includes(status)) {
        throw toSmithersError(new Error("Invalid run status"), `Run status must be one of: ${DB_RUN_ALLOWED_STATUSES.join(", ")}`, {
            code: "INVALID_INPUT",
            details: { status },
        });
    }
}
/**
 * @param {unknown} severity
 */
function validateAlertSeverity(severity) {
    if (typeof severity !== "string" ||
        !DB_ALERT_ALLOWED_SEVERITIES.includes(severity)) {
        throw toSmithersError(new Error("Invalid alert severity"), `Alert severity must be one of: ${DB_ALERT_ALLOWED_SEVERITIES.join(", ")}`, {
            code: "INVALID_INPUT",
            details: { severity },
        });
    }
}
/**
 * @param {unknown} status
 */
function validateAlertStatus(status) {
    if (typeof status !== "string" ||
        !DB_ALERT_ALLOWED_STATUSES.includes(status)) {
        throw toSmithersError(new Error("Invalid alert status"), `Alert status must be one of: ${DB_ALERT_ALLOWED_STATUSES.join(", ")}`, {
            code: "INVALID_INPUT",
            details: { status },
        });
    }
}
/**
 * @param {Record<string, unknown>} row
 * @param {string} field
 */
function validateOptionalPositiveTimestamp(row, field) {
    const value = row[field];
    if (value === undefined || value === null)
        return;
    assertPositiveFiniteNumber(field, Number(value));
}
/**
 * @param {any} row
 */
function validateRunRow(row) {
    if (!row || typeof row !== "object") {
        throw toSmithersError(new Error("Invalid run row"), "Run row must be an object", {
            code: "INVALID_INPUT",
        });
    }
    assertOptionalStringMaxLength("runId", row.runId, DB_RUN_ID_MAX_LENGTH);
    assertOptionalStringMaxLength("parentRunId", row.parentRunId, DB_RUN_ID_MAX_LENGTH);
    assertOptionalStringMaxLength("workflowName", row.workflowName, DB_RUN_WORKFLOW_NAME_MAX_LENGTH);
    validateRunStatus(row.status);
    validateOptionalPositiveTimestamp(row, "createdAtMs");
    validateOptionalPositiveTimestamp(row, "startedAtMs");
    validateOptionalPositiveTimestamp(row, "finishedAtMs");
    validateOptionalPositiveTimestamp(row, "heartbeatAtMs");
    validateOptionalPositiveTimestamp(row, "cancelRequestedAtMs");
    validateOptionalPositiveTimestamp(row, "hijackRequestedAtMs");
}
/**
 * @param {any} patch
 */
function validateRunPatch(patch) {
    if (!patch || typeof patch !== "object")
        return;
    if ("workflowName" in patch) {
        assertOptionalStringMaxLength("workflowName", patch.workflowName, DB_RUN_WORKFLOW_NAME_MAX_LENGTH);
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
/**
 * @param {AlertRow} row
 */
function validateAlertRow(row) {
    if (!row || typeof row !== "object") {
        throw toSmithersError(new Error("Invalid alert row"), "Alert row must be an object", { code: "INVALID_INPUT" });
    }
    assertOptionalStringMaxLength("alertId", row.alertId, DB_ALERT_ID_MAX_LENGTH);
    assertOptionalStringMaxLength("runId", row.runId, DB_RUN_ID_MAX_LENGTH);
    assertOptionalStringMaxLength("policyName", row.policyName, DB_ALERT_POLICY_NAME_MAX_LENGTH);
    assertOptionalStringMaxLength("message", row.message, DB_ALERT_MESSAGE_MAX_LENGTH);
    if (typeof row.alertId !== "string" || row.alertId.length === 0) {
        throw toSmithersError(new Error("Invalid alert ID"), "Alert ID must be a non-empty string", { code: "INVALID_INPUT", details: { alertId: row.alertId } });
    }
    if (row.runId !== null && row.runId !== undefined && typeof row.runId !== "string") {
        throw toSmithersError(new Error("Invalid alert run ID"), "Alert run ID must be a string or null", { code: "INVALID_INPUT", details: { runId: row.runId } });
    }
    if (typeof row.policyName !== "string" || row.policyName.length === 0) {
        throw toSmithersError(new Error("Invalid alert policy name"), "Alert policy name must be a non-empty string", { code: "INVALID_INPUT", details: { policyName: row.policyName } });
    }
    if (typeof row.message !== "string" || row.message.length === 0) {
        throw toSmithersError(new Error("Invalid alert message"), "Alert message must be a non-empty string", { code: "INVALID_INPUT", details: { message: row.message } });
    }
    if (row.detailsJson !== null &&
        row.detailsJson !== undefined &&
        typeof row.detailsJson !== "string") {
        throw toSmithersError(new Error("Invalid alert details JSON"), "Alert details JSON must be a string or null", { code: "INVALID_INPUT", details: { detailsJson: row.detailsJson } });
    }
    validateAlertSeverity(row.severity);
    validateAlertStatus(row.status);
    validateOptionalPositiveTimestamp(row, "firedAtMs");
    validateOptionalPositiveTimestamp(row, "resolvedAtMs");
    validateOptionalPositiveTimestamp(row, "acknowledgedAtMs");
}
/**
 * @param {string | null | undefined} status
 * @returns {status is AlertStatus}
 */
function isAlertActiveStatus(status) {
    return status !== undefined && status !== null && ACTIVE_ALERT_STATUSES.has(status);
}
/**
 * Returns the row unchanged. Heartbeat-based classification now lives in
 * `deriveRunState`, which correctly returns "stale" / "orphaned" rather than
 * misusing "continued" (which means the run forked into a new run, and is
 * treated as a success by `deriveRunState`).
 *
 * @template T
 * @param {T} row
 * @returns {T}
 */
function classifyRunRowStatus(row) {
    return row;
}
/**
 * @template A, E
 * @param {Effect.Effect<A, E>} effect
 * @returns {RunnableEffect<A, E>}
 */
function runnableEffect(effect) {
    const runnable = effect;
    if (typeof runnable.then !== "function") {
        Object.defineProperty(runnable, "then", {
            configurable: true,
            value: (onfulfilled, onrejected) => Effect.runPromise(effect).then(onfulfilled, onrejected),
        });
    }
    return runnable;
}
export class SmithersDb {
    db;
    internalStorage;
    reconstructedFrameXmlCache = new Map();
    transactionDepth = 0;
    transactionOwnerThread = null;
    transactionTail = Promise.resolve();
    /**
   * @param {BunSQLiteDatabase<any>} db
   */
    constructor(db) {
        this.db = db;
        this.internalStorage = getSqlMessageStorage(db);
    }
    /**
   * @param {string} runId
   * @param {number} frameNo
   * @returns {string}
   */
    frameCacheKey(runId, frameNo) {
        return `${runId}:${frameNo}`;
    }
    /**
   * @param {string} runId
   * @param {number} frameNo
   * @returns {string | undefined}
   */
    getCachedFrameXml(runId, frameNo) {
        const key = this.frameCacheKey(runId, frameNo);
        const value = this.reconstructedFrameXmlCache.get(key);
        if (value === undefined)
            return undefined;
        // Keep recently-used entries hot.
        this.reconstructedFrameXmlCache.delete(key);
        this.reconstructedFrameXmlCache.set(key, value);
        return value;
    }
    /**
   * @param {string} runId
   * @param {number} frameNo
   * @param {string} xmlJson
   */
    rememberFrameXml(runId, frameNo, xmlJson) {
        const key = this.frameCacheKey(runId, frameNo);
        if (this.reconstructedFrameXmlCache.has(key)) {
            this.reconstructedFrameXmlCache.delete(key);
        }
        else if (this.reconstructedFrameXmlCache.size >= FRAME_XML_CACHE_MAX) {
            const oldest = this.reconstructedFrameXmlCache.keys().next().value;
            if (oldest !== undefined) {
                this.reconstructedFrameXmlCache.delete(oldest);
            }
        }
        this.reconstructedFrameXmlCache.set(key, xmlJson);
    }
    /**
   * @param {string} runId
   */
    clearFrameCacheForRun(runId) {
        for (const key of this.reconstructedFrameXmlCache.keys()) {
            if (key.startsWith(`${runId}:`)) {
                this.reconstructedFrameXmlCache.delete(key);
            }
        }
    }
    /**
   * @param {string} queryString
   */
    rawQuery(queryString) {
        const self = this;
        return runnableEffect(Effect.gen(function* () {
            const validatedQuery = yield* Effect.try({
                try: () => validateReadOnlyRawQuery(queryString),
                catch: (cause) => toSmithersError(cause, "validate raw query", {
                    code: "INVALID_INPUT",
                    details: { operation: "raw query validation" },
                }),
            });
            return yield* self.read(`raw query ${validatedQuery.slice(0, 20)}`, () => {
                const client = self.db.session.client;
                const stmt = client.query(validatedQuery);
                return Promise.resolve(stmt.all());
            });
        }));
    }
    /**
   * @param {string} currentFiberThread
   * @returns {boolean}
   */
    ownsActiveTransaction(currentFiberThread) {
        return (this.transactionDepth > 0 &&
            this.transactionOwnerThread === currentFiberThread);
    }
    /**
   * @template A
   * @param {string} label
   * @param {() => PromiseLike<A>} operation
   * @returns {RunnableEffect<A>}
   */
    read(label, operation) {
        const self = this;
        return runnableEffect(Effect.gen(function* () {
            const start = performance.now();
            const readOperation = Effect.tryPromise({
                try: () => operation(),
                catch: (cause) => toSmithersError(cause, label, {
                    code: "DB_QUERY_FAILED",
                    details: { operation: label },
                }),
            });
            const currentFiberId = yield* Effect.fiberId;
            const currentFiberThread = FiberId.threadName(currentFiberId);
            let result;
            if (self.ownsActiveTransaction(currentFiberThread)) {
                result = yield* readOperation;
            }
            else {
                const releaseTurn = yield* self.acquireTransactionTurn();
                result = yield* readOperation.pipe(Effect.ensuring(Effect.sync(() => {
                    releaseTurn();
                })));
            }
            yield* Metric.update(dbQueryDuration, performance.now() - start);
            return result;
        }).pipe(Effect.annotateLogs({ dbOperation: label }), Effect.withLogSpan(`db:${label}`)));
    }
    /**
   * @template A
   * @param {string} label
   * @param {() => PromiseLike<A>} operation
   * @returns {RunnableEffect<A>}
   */
    write(label, operation) {
        const self = this;
        return runnableEffect(Effect.gen(function* () {
            const start = performance.now();
            const writeOperation = Effect.tryPromise({
                try: () => operation(),
                catch: (cause) => toSmithersError(cause, label, {
                    code: "DB_WRITE_FAILED",
                    details: { operation: label },
                }),
            });
            const currentFiberId = yield* Effect.fiberId;
            const currentFiberThread = FiberId.threadName(currentFiberId);
            let result;
            if (self.ownsActiveTransaction(currentFiberThread)) {
                result = yield* writeOperation;
            }
            else {
                const releaseTurn = yield* self.acquireTransactionTurn();
                result = yield* withSqliteWriteRetryEffect(() => writeOperation, { label }).pipe(Effect.ensuring(Effect.sync(() => {
                    releaseTurn();
                })));
            }
            yield* Metric.update(dbQueryDuration, performance.now() - start);
            return result;
        }).pipe(Effect.annotateLogs({ dbOperation: label }), Effect.withLogSpan(`db:${label}`)));
    }
    getSqliteTransactionClient() {
        return Effect.try({
            try: () => {
                const candidate = this.db.session?.client ?? this.db.$client;
                if (!candidate || typeof candidate.run !== "function") {
                    throw new Error("SmithersDb.withTransaction requires Bun SQLite client transaction primitives.");
                }
                return candidate;
            },
            catch: (cause) => toSmithersError(cause, "resolve sqlite transaction client", {
                code: "DB_WRITE_FAILED",
                details: { operation: "resolve sqlite transaction client" },
            }),
        });
    }
    acquireTransactionTurn() {
        return Effect.tryPromise({
            try: async () => {
                let release;
                const gate = new Promise((resolve) => {
                    release = resolve;
                });
                const previous = this.transactionTail.catch(() => undefined);
                this.transactionTail = previous.then(() => gate);
                await previous;
                return release;
            },
            catch: (cause) => toSmithersError(cause, "acquire sqlite transaction turn", {
                code: "DB_WRITE_FAILED",
                details: { operation: "acquire sqlite transaction turn" },
            }),
        });
    }
    /**
   * @template A
   * @param {string} writeGroup
   * @param {Effect.Effect<A, SmithersError>} operation
   * @returns {RunnableEffect<A>}
   */
    withTransactionEffect(writeGroup, operation) {
        const self = this;
        const label = `sqlite transaction ${writeGroup}`;
        return runnableEffect(withSqliteWriteRetryEffect(() => Effect.gen(function* () {
            const currentFiberId = yield* Effect.fiberId;
            const currentFiberThread = FiberId.threadName(currentFiberId);
            if (self.ownsActiveTransaction(currentFiberThread)) {
                return yield* Effect.fail(toSmithersError(new Error(`Nested sqlite transactions are not supported (writeGroup: ${writeGroup}).`), label, {
                    code: "DB_WRITE_FAILED",
                    details: { writeGroup, nestedTransaction: true },
                }));
            }
            const releaseTurn = yield* self.acquireTransactionTurn();
            const start = performance.now();
            return yield* Effect.gen(function* () {
                const client = yield* self.getSqliteTransactionClient();
                /**
     * @param {"operation" | "commit"} phase
     * @param {unknown} error
     */
                const rollback = (phase, error) => Effect.gen(function* () {
                    yield* Metric.increment(dbTransactionRollbacks);
                    yield* Effect.logWarning("transaction rollback").pipe(Effect.annotateLogs({
                        writeGroup,
                        phase,
                        error: String(error),
                    }));
                    yield* Effect.sync(() => {
                        try {
                            client.run("ROLLBACK");
                        }
                        catch {
                            // ignore rollback failures
                        }
                    });
                });
                yield* Effect.try({
                    try: () => {
                        client.run("BEGIN IMMEDIATE");
                        self.transactionDepth += 1;
                        self.transactionOwnerThread = currentFiberThread;
                    },
                    catch: (cause) => toSmithersError(cause, "begin sqlite transaction", {
                        code: "DB_WRITE_FAILED",
                        details: { writeGroup, phase: "begin" },
                    }),
                });
                const operationExit = yield* Effect.exit(operation);
                if (Exit.isFailure(operationExit)) {
                    yield* rollback("operation", operationExit.cause);
                    return yield* Effect.failCause(operationExit.cause);
                }
                const commitExit = yield* Effect.exit(Effect.try({
                    try: () => {
                        client.run("COMMIT");
                    },
                    catch: (cause) => toSmithersError(cause, "commit sqlite transaction", {
                        code: "DB_WRITE_FAILED",
                        details: { writeGroup, phase: "commit" },
                    }),
                }));
                if (Exit.isFailure(commitExit)) {
                    yield* rollback("commit", commitExit.cause);
                    return yield* Effect.failCause(commitExit.cause);
                }
                return operationExit.value;
            }).pipe(Effect.ensuring(Effect.gen(function* () {
                self.transactionDepth = Math.max(0, self.transactionDepth - 1);
                if (self.transactionDepth === 0) {
                    self.transactionOwnerThread = null;
                }
                yield* Metric.update(dbTransactionDuration, performance.now() - start);
            }))).pipe(Effect.ensuring(Effect.sync(() => {
                releaseTurn();
            })));
        }), { label }).pipe(Effect.annotateLogs({ writeGroup }), Effect.withLogSpan("db:transaction")));
    }
    /**
   * @template A
   * @param {string} writeGroup
   * @param {Effect.Effect<A, SmithersError>} operation
   * @returns {Promise<A>}
   */
    withTransaction(writeGroup, operation) {
        return Effect.runPromise(this.withTransactionEffect(writeGroup, operation));
    }
    /**
   * @param {any} row
   */
    insertRun(row) {
        validateRunRow(row);
        return this.write("insert run", () => this.internalStorage.insertIgnore("_smithers_runs", row));
    }
    /**
   * @param {string} runId
   * @param {any} patch
   */
    updateRun(runId, patch) {
        validateRunPatch(patch);
        return this.write(`update run ${runId}`, () => this.internalStorage.updateWhere("_smithers_runs", patch, "run_id = ?", [runId]));
    }
    /**
   * @param {string} runId
   * @param {any} patch
   */
    updateRunEffect(runId, patch) {
        return this.updateRun(runId, patch);
    }
    /**
   * @param {string} runId
   * @param {string} runtimeOwnerId
   * @param {number} heartbeatAtMs
   */
    heartbeatRun(runId, runtimeOwnerId, heartbeatAtMs) {
        return this.write(`heartbeat run ${runId}`, () => this.internalStorage.updateWhere("_smithers_runs", { heartbeatAtMs }, "run_id = ? AND runtime_owner_id = ?", [runId, runtimeOwnerId]));
    }
    /**
   * @param {string} runId
   * @param {number} cancelRequestedAtMs
   */
    requestRunCancel(runId, cancelRequestedAtMs) {
        return this.write(`cancel run ${runId}`, () => this.internalStorage.updateWhere("_smithers_runs", { cancelRequestedAtMs }, "run_id = ?", [runId]));
    }
    /**
   * @param {string} runId
   * @param {number} hijackRequestedAtMs
   * @param {string | null} [hijackTarget]
   */
    requestRunHijack(runId, hijackRequestedAtMs, hijackTarget) {
        return this.write(`hijack run ${runId}`, () => this.internalStorage.updateWhere("_smithers_runs", {
            hijackRequestedAtMs,
            hijackTarget: hijackTarget ?? null,
        }, "run_id = ?", [runId]));
    }
    /**
   * @param {string} runId
   */
    clearRunHijack(runId) {
        return this.write(`clear hijack run ${runId}`, () => this.internalStorage.updateWhere("_smithers_runs", {
            hijackRequestedAtMs: null,
            hijackTarget: null,
        }, "run_id = ?", [runId]));
    }
    /**
   * @param {string} runId
   */
    getRun(runId) {
        return this.read(`get run ${runId}`, async () => {
            const row = await this.internalStorage.queryOne(`SELECT *
         FROM _smithers_runs
         WHERE run_id = ?
         LIMIT 1`, [runId]);
            return row ? classifyRunRowStatus(row) : undefined;
        });
    }
    /**
   * @param {string} runId
   */
    listRunAncestry(runId, limit = 1000) {
        return this.read(`list run ancestry ${runId}`, () => this.internalStorage.queryAll(`WITH RECURSIVE ancestry(run_id, parent_run_id, depth) AS (
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
         LIMIT ?`, [runId, limit]));
    }
    /**
   * @param {string} parentRunId
   */
    getLatestChildRun(parentRunId) {
        return this.read(`get latest child run ${parentRunId}`, () => this.internalStorage.queryOne(`SELECT *
         FROM _smithers_runs
         WHERE parent_run_id = ?
         ORDER BY created_at_ms DESC
         LIMIT 1`, [parentRunId]));
    }
    /**
   * @param {string} [status]
   */
    listRuns(limit = 50, status) {
        return this.read(`list runs ${status ?? "all"}`, async () => {
            const clauses = [];
            const params = [];
            if (status === "running") {
                clauses.push("(status = ? OR status = ?)");
                params.push("running", "continued");
            }
            else if (status) {
                clauses.push("status = ?");
                params.push(status);
            }
            const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
            const rows = await this.internalStorage.queryAll(`SELECT *
         FROM _smithers_runs
         ${whereSql}
         ORDER BY created_at_ms DESC
         LIMIT ?`, [...params, limit]);
            return rows.map((row) => classifyRunRowStatus(row));
        });
    }
    /**
   * @param {number} staleBeforeMs
   */
    listStaleRunningRuns(staleBeforeMs, limit = 1000) {
        return this.read(`list stale running runs before ${staleBeforeMs}`, () => this.internalStorage.queryAll(`SELECT
             run_id,
             workflow_path,
             heartbeat_at_ms,
             runtime_owner_id,
             status
           FROM _smithers_runs
           WHERE status = 'running'
             AND (heartbeat_at_ms IS NULL OR heartbeat_at_ms < ?)
           ORDER BY COALESCE(heartbeat_at_ms, 0) ASC
           LIMIT ?`, [staleBeforeMs, limit]));
    }
    /**
   * @param {{ runId: string; expectedStatus?: string; expectedRuntimeOwnerId: string | null; expectedHeartbeatAtMs: number | null; staleBeforeMs: number; claimOwnerId: string; claimHeartbeatAtMs: number; requireStale?: boolean; }} params
   */
    claimRunForResume(params) {
        return this.write(`claim stale run ${params.runId}`, () => {
            const client = this.db.session.client;
            const expectedStatus = params.expectedStatus ?? "running";
            const requireStale = params.requireStale ?? expectedStatus === "running";
            client
                .query(`UPDATE _smithers_runs
           SET runtime_owner_id = ?, heartbeat_at_ms = ?
           WHERE run_id = ?
             AND status = ?
             AND COALESCE(runtime_owner_id, '') = COALESCE(?, '')
             AND COALESCE(heartbeat_at_ms, -1) = COALESCE(?, -1)
             AND (? = 0 OR heartbeat_at_ms IS NULL OR heartbeat_at_ms < ?)`)
                .run(params.claimOwnerId, params.claimHeartbeatAtMs, params.runId, expectedStatus, params.expectedRuntimeOwnerId, params.expectedHeartbeatAtMs, requireStale ? 1 : 0, params.staleBeforeMs);
            return this.internalStorage
                .queryOne("SELECT changes() AS count")
                .then((row) => Number(row?.count ?? 0) > 0);
        });
    }
    /**
   * @param {{ runId: string; claimOwnerId: string; restoreRuntimeOwnerId: string | null; restoreHeartbeatAtMs: number | null; }} params
   */
    releaseRunResumeClaim(params) {
        return this.write(`release stale run claim ${params.runId}`, () => {
            return this.internalStorage.execute(`UPDATE _smithers_runs
         SET runtime_owner_id = ?, heartbeat_at_ms = ?
         WHERE run_id = ? AND runtime_owner_id = ?`, [
                params.restoreRuntimeOwnerId,
                params.restoreHeartbeatAtMs,
                params.runId,
                params.claimOwnerId,
            ]);
        });
    }
    /**
   * @param {{ runId: string; expectedRuntimeOwnerId: string; expectedHeartbeatAtMs: number | null; patch: any; }} params
   */
    updateClaimedRun(params) {
        validateRunPatch(params.patch);
        return this.write(`update claimed run ${params.runId}`, () => {
            const client = this.db.session.client;
            const patchEntries = Object.entries(params.patch);
            if (patchEntries.length === 0) {
                return Promise.resolve(true);
            }
            const assignments = patchEntries.map(([key]) => `${camelToSnake(key)} = ?`);
            client
                .query(`UPDATE _smithers_runs
           SET ${assignments.join(", ")}
           WHERE run_id = ?
             AND runtime_owner_id = ?
             AND COALESCE(heartbeat_at_ms, -1) = COALESCE(?, -1)`)
                .run(...patchEntries.map(([, value]) => value), params.runId, params.expectedRuntimeOwnerId, params.expectedHeartbeatAtMs);
            return this.internalStorage
                .queryOne("SELECT changes() AS count")
                .then((row) => Number(row?.count ?? 0) > 0);
        });
    }
    /**
   * @param {any} row
   */
    insertNode(row) {
        return this.insertNodeEffect(row);
    }
    /**
   * @param {any} row
   */
    insertNodeEffect(row) {
        return this.write(`insert node ${row.nodeId}`, () => this.internalStorage.upsert("_smithers_nodes", row, ["runId", "nodeId", "iteration"]));
    }
    /**
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   */
    getNode(runId, nodeId, iteration) {
        return this.read(`get node ${nodeId}`, () => this.internalStorage.queryOne(`SELECT *
         FROM _smithers_nodes
         WHERE run_id = ? AND node_id = ? AND iteration = ?
         LIMIT 1`, [runId, nodeId, iteration]));
    }
    /**
   * @param {string} runId
   * @param {string} nodeId
   */
    listNodeIterations(runId, nodeId) {
        return this.read(`list node iterations ${nodeId}`, () => this.internalStorage.queryAll(`SELECT *
         FROM _smithers_nodes
         WHERE run_id = ? AND node_id = ?
         ORDER BY iteration DESC`, [runId, nodeId]));
    }
    /**
   * @param {string} runId
   */
    listNodes(runId) {
        return this.read(`list nodes ${runId}`, () => this.internalStorage.queryAll(`SELECT *
         FROM _smithers_nodes
         WHERE run_id = ?`, [runId]));
    }
    /**
   * @param {any} table
   * @param {OutputKey} key
   * @param {Record<string, unknown>} payload
   */
    upsertOutputRow(table, key, payload) {
        const cols = getKeyColumns(table);
        const values = { ...payload };
        values.runId = key.runId;
        values.nodeId = key.nodeId;
        if (cols.iteration) {
            values.iteration = key.iteration ?? 0;
        }
        const target = cols.iteration
            ? [cols.runId, cols.nodeId, cols.iteration]
            : [cols.runId, cols.nodeId];
        const tableName = table?.["_"]?.name ?? "output";
        return this.write(`upsert output ${tableName}`, () => this.db
            .insert(table)
            .values(values)
            .onConflictDoUpdate({
            target: target,
            set: values,
        }));
    }
    /**
   * @param {any} table
   * @param {OutputKey} key
   * @param {Record<string, unknown>} payload
   */
    upsertOutputRowEffect(table, key, payload) {
        return this.upsertOutputRow(table, key, payload);
    }
    /**
   * @param {string} tableName
   * @param {OutputKey} key
   */
    deleteOutputRow(tableName, key) {
        return this.write(`delete output ${tableName}`, () => {
            const client = this.db.session.client;
            let resolvedTableName = tableName;
            let escapedTableName = resolvedTableName.replaceAll(`"`, `""`);
            let tableInfo = client
                .query(`PRAGMA table_info("${escapedTableName}")`)
                .all();
            if (tableInfo.length === 0) {
                const schemaCandidates = [
                    this.db?._?.fullSchema,
                    this.db?._?.schema,
                    this.db?.schema,
                ];
                for (const candidate of schemaCandidates) {
                    if (!candidate || typeof candidate !== "object")
                        continue;
                    const table = candidate[tableName];
                    if (!table)
                        continue;
                    try {
                        resolvedTableName = getTableName(table);
                        escapedTableName = resolvedTableName.replaceAll(`"`, `""`);
                        tableInfo = client
                            .query(`PRAGMA table_info("${escapedTableName}")`)
                            .all();
                        if (tableInfo.length > 0) {
                            break;
                        }
                    }
                    catch { }
                }
            }
            const columnNames = new Set(tableInfo
                .map((column) => column.name)
                .filter((name) => typeof name === "string"));
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
                throw new Error(`Output table ${tableName} is missing runId/nodeId columns`);
            }
            if (iterationColumn) {
                client
                    .query(`DELETE FROM "${escapedTableName}"
             WHERE "${runIdColumn}" = ? AND "${nodeIdColumn}" = ? AND "${iterationColumn}" = ?`)
                    .run(key.runId, key.nodeId, key.iteration ?? 0);
            }
            else {
                client
                    .query(`DELETE FROM "${escapedTableName}"
             WHERE "${runIdColumn}" = ? AND "${nodeIdColumn}" = ?`)
                    .run(key.runId, key.nodeId);
            }
            return Promise.resolve(undefined);
        });
    }
    /**
   * @param {string} tableName
   * @param {OutputKey} key
   */
    deleteOutputRowEffect(tableName, key) {
        return this.deleteOutputRow(tableName, key);
    }
    /**
   * @param {string} tableName
   * @param {string} runId
   * @param {string} nodeId
   */
    getRawNodeOutput(tableName, runId, nodeId) {
        return runnableEffect(this.read(`get raw node output ${tableName}`, () => {
            const query = sql.raw(`SELECT * FROM "${tableName}" WHERE run_id = '${runId}' AND node_id = '${nodeId}' ORDER BY iteration DESC LIMIT 1`);
            const res = this.db.get(query);
            return Promise.resolve(res ?? null);
        }).pipe(Effect.catchAll(() => Effect.succeed(null))));
    }
    /**
   * @param {string} tableName
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   */
    getRawNodeOutputForIteration(tableName, runId, nodeId, iteration) {
        return runnableEffect(this.read(`get raw node output ${tableName} iteration ${iteration}`, () => {
            const escaped = tableName.replaceAll(`"`, `""`);
            const client = this.db.session.client;
            const stmt = client.query(`SELECT * FROM "${escaped}" WHERE run_id = ? AND node_id = ? AND iteration = ? LIMIT 1`);
            const row = stmt.get(runId, nodeId, iteration);
            return Promise.resolve(row ?? null);
        }).pipe(Effect.catchAll(() => Effect.succeed(null))));
    }
    /**
   * @param {any} row
   */
    insertAttempt(row) {
        return this.write(`insert attempt ${row.nodeId}#${row.attempt}`, () => this.internalStorage.upsert("_smithers_attempts", row, ["runId", "nodeId", "iteration", "attempt"]));
    }
    /**
   * @param {any} row
   */
    insertAttemptEffect(row) {
        return this.insertAttempt(row);
    }
    /**
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   * @param {number} attempt
   * @param {any} patch
   */
    updateAttempt(runId, nodeId, iteration, attempt, patch) {
        return this.write(`update attempt ${nodeId}#${attempt}`, () => this.internalStorage.updateWhere("_smithers_attempts", patch, "run_id = ? AND node_id = ? AND iteration = ? AND attempt = ?", [runId, nodeId, iteration, attempt]));
    }
    /**
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   * @param {number} attempt
   * @param {any} patch
   */
    updateAttemptEffect(runId, nodeId, iteration, attempt, patch) {
        return this.updateAttempt(runId, nodeId, iteration, attempt, patch);
    }
    /**
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   * @param {number} attempt
   * @param {number} heartbeatAtMs
   * @param {string | null} heartbeatDataJson
   */
    heartbeatAttempt(runId, nodeId, iteration, attempt, heartbeatAtMs, heartbeatDataJson) {
        return this.write(`heartbeat attempt ${nodeId}#${attempt}`, () => this.internalStorage.updateWhere("_smithers_attempts", {
            heartbeatAtMs,
            heartbeatDataJson,
        }, "run_id = ? AND node_id = ? AND iteration = ? AND attempt = ? AND state = ?", [runId, nodeId, iteration, attempt, "in-progress"]));
    }
    /**
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   * @returns {RunnableEffect<AttemptRow[]>}
   */
    listAttempts(runId, nodeId, iteration) {
        return this.read(`list attempts ${nodeId}`, () => this.internalStorage.queryAll(`SELECT *
         FROM _smithers_attempts
         WHERE run_id = ? AND node_id = ? AND iteration = ?
         ORDER BY attempt DESC`, [runId, nodeId, iteration], { booleanColumns: ["cached"] }));
    }
    /**
   * @param {string} runId
   * @returns {RunnableEffect<AttemptRow[]>}
   */
    listAttemptsForRun(runId) {
        return this.read(`list attempts for run ${runId}`, () => this.internalStorage.queryAll(`SELECT *
         FROM _smithers_attempts
         WHERE run_id = ?
         ORDER BY started_at_ms ASC, node_id ASC, iteration ASC, attempt ASC`, [runId], { booleanColumns: ["cached"] }));
    }
    /**
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   * @param {number} attempt
   * @returns {RunnableEffect<AttemptRow | undefined>}
   */
    getAttempt(runId, nodeId, iteration, attempt) {
        return this.read(`get attempt ${nodeId}#${attempt}`, () => this.internalStorage.queryOne(`SELECT *
         FROM _smithers_attempts
         WHERE run_id = ? AND node_id = ? AND iteration = ? AND attempt = ?
         LIMIT 1`, [runId, nodeId, iteration, attempt], { booleanColumns: ["cached"] }));
    }
    /**
   * @param {string} runId
   * @returns {RunnableEffect<AttemptRow[]>}
   */
    listInProgressAttempts(runId) {
        return this.read(`list in-progress attempts ${runId}`, () => this.internalStorage.queryAll(`SELECT *
         FROM _smithers_attempts
         WHERE run_id = ? AND state = ?`, [runId, "in-progress"], { booleanColumns: ["cached"] }));
    }
    /**
   * @returns {RunnableEffect<any[]>}
   */
    listAllInProgressAttempts() {
        return this.read("list all in-progress attempts", () => this.internalStorage.queryAll(`SELECT *
         FROM _smithers_attempts
         WHERE state = ?`, ["in-progress"], { booleanColumns: ["cached"] }));
    }
    /**
   * @param {string} runId
   * @param {number} frameNo
   * @param {number} [limit]
   */
    listFrameChainDesc(runId, frameNo, limit) {
        return this.read(`list frame chain ${runId}:${frameNo}`, () => this.internalStorage.queryAll(`SELECT *
         FROM _smithers_frames
         WHERE run_id = ? AND frame_no <= ?
         ORDER BY frame_no DESC${typeof limit === "number" ? " LIMIT ?" : ""}`, typeof limit === "number" ? [runId, frameNo, limit] : [runId, frameNo]));
    }
    /**
   * @param {string} runId
   * @param {number} frameNo
   */
    reconstructFrameXml(runId, frameNo, localCache = new Map()) {
        const self = this;
        return Effect.gen(function* () {
            const localHit = localCache.get(frameNo);
            if (localHit !== undefined)
                return localHit;
            const cacheHit = self.getCachedFrameXml(runId, frameNo);
            if (cacheHit !== undefined) {
                localCache.set(frameNo, cacheHit);
                return cacheHit;
            }
            let rows = (yield* self.listFrameChainDesc(runId, frameNo, FRAME_KEYFRAME_INTERVAL + 2));
            if (rows.length === 0)
                return undefined;
            let anchorIndex = rows.findIndex((row) => normalizeFrameEncoding(row.encoding) !== "delta");
            if (anchorIndex < 0) {
                rows = (yield* self.listFrameChainDesc(runId, frameNo));
                anchorIndex = rows.findIndex((row) => normalizeFrameEncoding(row.encoding) !== "delta");
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
                    }
                    else {
                        currentXml = yield* Effect.try({
                            try: () => applyFrameDeltaJson(currentXml, String(frameRow.xmlJson ?? "")),
                            catch: (cause) => toSmithersError(cause, `apply frame delta ${runId}:${frameRow.frameNo}`, {
                                code: "DB_QUERY_FAILED",
                                details: { runId, frameNo: frameRow.frameNo },
                            }),
                        });
                    }
                }
                else {
                    currentXml = String(frameRow.xmlJson ?? "null");
                }
                localCache.set(frameRow.frameNo, currentXml);
                self.rememberFrameXml(runId, frameRow.frameNo, currentXml);
            }
            return localCache.get(frameNo);
        });
    }
    /**
   * @param {any} row
   */
    inflateFrameRow(row, localCache = new Map()) {
        const self = this;
        return Effect.gen(function* () {
            const encoding = normalizeFrameEncoding(row?.encoding);
            if (encoding !== "delta") {
                const xmlJson = String(row?.xmlJson ?? "null");
                localCache.set(row.frameNo, xmlJson);
                self.rememberFrameXml(row.runId, row.frameNo, xmlJson);
                return { ...row, encoding, xmlJson };
            }
            const xmlJson = yield* self.reconstructFrameXml(row.runId, row.frameNo, localCache);
            return {
                ...row,
                encoding,
                xmlJson: xmlJson ?? String(row?.xmlJson ?? "null"),
            };
        });
    }
    /**
   * @param {any} row
   */
    insertFrame(row) {
        const self = this;
        return runnableEffect(Effect.gen(function* () {
            const runId = String(row.runId);
            const frameNo = Number(row.frameNo);
            const fullXmlJson = String(row.xmlJson ?? "null");
            let encoding = "keyframe";
            let persistedXmlJson = fullXmlJson;
            if (frameNo > 0 && frameNo % FRAME_KEYFRAME_INTERVAL !== 0) {
                const previousXmlJson = yield* self.reconstructFrameXml(runId, frameNo - 1);
                if (typeof previousXmlJson === "string") {
                    const delta = yield* Effect.try({
                        try: () => encodeFrameDelta(previousXmlJson, fullXmlJson),
                        catch: (cause) => toSmithersError(cause, `encode frame delta ${runId}:${frameNo}`, {
                            code: "DB_WRITE_FAILED",
                            details: { runId, frameNo },
                        }),
                    });
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
            yield* self.write(`insert frame ${frameNo}`, () => self.internalStorage.upsert("_smithers_frames", persistedRow, ["runId", "frameNo"]));
            self.clearFrameCacheForRun(runId);
            self.rememberFrameXml(runId, frameNo, fullXmlJson);
        }));
    }
    /**
   * @param {any} row
   */
    insertFrameEffect(row) {
        return this.insertFrame(row);
    }
    /**
   * @param {string} runId
   */
    getLastFrame(runId) {
        const self = this;
        return runnableEffect(Effect.gen(function* () {
            const row = yield* self.read(`get last frame ${runId}`, () => self.internalStorage.queryOne(`SELECT *
           FROM _smithers_frames
           WHERE run_id = ?
           ORDER BY frame_no DESC
           LIMIT 1`, [runId]));
            if (!row)
                return undefined;
            return yield* self.inflateFrameRow(row);
        }));
    }
    /**
   * @param {any} row
   */
    insertOrUpdateApproval(row) {
        return this.write(`upsert approval ${row.nodeId}`, () => this.internalStorage.upsert("_smithers_approvals", row, ["runId", "nodeId", "iteration"]));
    }
    /**
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   */
    getApproval(runId, nodeId, iteration) {
        return this.read(`get approval ${nodeId}`, () => this.internalStorage.queryOne(`SELECT *
         FROM _smithers_approvals
         WHERE run_id = ? AND node_id = ? AND iteration = ?
         LIMIT 1`, [runId, nodeId, iteration], { booleanColumns: ["autoApproved"] }));
    }
    /**
   * @param {HumanRequestRow} row
   */
    insertHumanRequest(row) {
        return this.write(`insert human request ${row.requestId}`, () => this.internalStorage.insertIgnore("_smithers_human_requests", row));
    }
    /**
   * @param {string} requestId
   */
    getHumanRequest(requestId) {
        return this.read(`get human request ${requestId}`, () => this.internalStorage.queryOne(`SELECT *
         FROM _smithers_human_requests
         WHERE request_id = ?
         LIMIT 1`, [requestId]));
    }
    /**
   * @param {string} requestId
   */
    reopenHumanRequest(requestId) {
        return this.write(`reopen human request ${requestId}`, () => this.internalStorage.updateWhere("_smithers_human_requests", {
            status: "pending",
            responseJson: null,
            answeredAtMs: null,
            answeredBy: null,
        }, "request_id = ? AND status = ?", [requestId, "answered"]));
    }
    expireStaleHumanRequests(nowMs = Date.now()) {
        return this.write(`expire stale human requests before ${nowMs}`, () => this.internalStorage.updateWhere("_smithers_human_requests", {
            status: "expired",
            responseJson: null,
            answeredAtMs: null,
            answeredBy: null,
        }, "status = ? AND timeout_at_ms IS NOT NULL AND timeout_at_ms <= ?", ["pending", nowMs]));
    }
    listPendingHumanRequests(nowMs = Date.now()) {
        const self = this;
        return runnableEffect(Effect.gen(function* () {
            yield* self.expireStaleHumanRequests(nowMs);
            return yield* self.read("list pending human requests", () => self.internalStorage.queryAll(`SELECT
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
           ORDER BY h.requested_at_ms ASC, h.run_id, h.node_id, h.iteration`, ["pending"]));
        }));
    }
    /**
   * @param {string} requestId
   * @param {string} responseJson
   * @param {number} answeredAtMs
   * @param {string | null} [answeredBy]
   */
    answerHumanRequest(requestId, responseJson, answeredAtMs, answeredBy) {
        return this.write(`answer human request ${requestId}`, () => this.internalStorage.updateWhere("_smithers_human_requests", {
            status: "answered",
            responseJson,
            answeredAtMs,
            answeredBy: answeredBy ?? null,
        }, "request_id = ? AND status = ?", [requestId, "pending"]));
    }
    /**
   * @param {string} requestId
   */
    cancelHumanRequest(requestId) {
        return this.write(`cancel human request ${requestId}`, () => this.internalStorage.updateWhere("_smithers_human_requests", {
            status: "cancelled",
        }, "request_id = ? AND status = ?", [requestId, "pending"]));
    }
    /**
   * @param {AlertRow} row
   */
    insertAlert(row) {
        validateAlertRow(row);
        const self = this;
        return this.withTransaction(`insert alert ${row.alertId}`, Effect.gen(function* () {
            const existing = yield* self.getAlert(row.alertId);
            if (existing) {
                return existing;
            }
            yield* self.write(`insert alert ${row.alertId}`, () => self.internalStorage.insertIgnore("_smithers_alerts", row));
            yield* Metric.increment(Metric.tagged(Metric.tagged(alertsFiredTotal, "policy", row.policyName), "severity", row.severity));
            if (isAlertActiveStatus(row.status)) {
                yield* Metric.update(alertsActive, 1);
            }
            return yield* self.getAlert(row.alertId);
        }));
    }
    /**
   * @param {string} alertId
   */
    getAlert(alertId) {
        return this.read(`get alert ${alertId}`, () => this.internalStorage.queryOne(`SELECT *
         FROM _smithers_alerts
         WHERE alert_id = ?
         LIMIT 1`, [alertId]));
    }
    /**
   * @param {readonly AlertStatus[]} [statuses]
   */
    listAlerts(limit = 100, statuses) {
        if (statuses) {
            for (const status of statuses) {
                validateAlertStatus(status);
            }
        }
        const normalizedLimit = Math.max(1, Math.floor(limit));
        return this.read("list alerts", () => {
            const clauses = [];
            const params = [];
            if (statuses && statuses.length > 0) {
                clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
                params.push(...statuses);
            }
            const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
            return this.internalStorage.queryAll(`SELECT *
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
         LIMIT ?`, [...params, normalizedLimit]);
        });
    }
    /**
   * @param {string} alertId
   */
    acknowledgeAlert(alertId, acknowledgedAtMs = Date.now()) {
        validateOptionalPositiveTimestamp({ acknowledgedAtMs }, "acknowledgedAtMs");
        const self = this;
        return this.withTransaction(`acknowledge alert ${alertId}`, Effect.gen(function* () {
            const alert = yield* self.getAlert(alertId);
            if (!alert) {
                return undefined;
            }
            if (alert.status !== "firing") {
                return alert;
            }
            yield* self.write(`acknowledge alert ${alertId}`, () => self.internalStorage.updateWhere("_smithers_alerts", {
                status: "acknowledged",
                acknowledgedAtMs,
            }, "alert_id = ? AND status = ?", [alertId, "firing"]));
            yield* Metric.increment(Metric.tagged(alertsAcknowledgedTotal, "policy", alert.policyName));
            return yield* self.getAlert(alertId);
        }));
    }
    /**
   * @param {string} alertId
   */
    resolveAlert(alertId, resolvedAtMs = Date.now()) {
        validateOptionalPositiveTimestamp({ resolvedAtMs }, "resolvedAtMs");
        const self = this;
        return this.withTransaction(`resolve alert ${alertId}`, Effect.gen(function* () {
            const alert = yield* self.getAlert(alertId);
            if (!alert) {
                return undefined;
            }
            if (alert.status === "resolved") {
                return alert;
            }
            yield* self.write(`resolve alert ${alertId}`, () => self.internalStorage.updateWhere("_smithers_alerts", {
                status: "resolved",
                resolvedAtMs,
            }, "alert_id = ? AND status != ?", [alertId, "resolved"]));
            if (isAlertActiveStatus(alert.status)) {
                yield* Metric.update(alertsActive, -1);
            }
            return yield* self.getAlert(alertId);
        }));
    }
    /**
   * @param {string} alertId
   */
    silenceAlert(alertId) {
        const self = this;
        return this.withTransaction(`silence alert ${alertId}`, Effect.gen(function* () {
            const alert = yield* self.getAlert(alertId);
            if (!alert) {
                return undefined;
            }
            if (alert.status === "resolved" || alert.status === "silenced") {
                return alert;
            }
            yield* self.write(`silence alert ${alertId}`, () => self.internalStorage.updateWhere("_smithers_alerts", {
                status: "silenced",
            }, "alert_id = ? AND status != ? AND status != ?", [alertId, "resolved", "silenced"]));
            return yield* self.getAlert(alertId);
        }));
    }
    /**
   * @param {{ runId: string; signalName: string; correlationId: string | null; payloadJson: string; receivedAtMs: number; receivedBy?: string | null; }} row
   */
    insertSignalWithNextSeq(row) {
        const label = `insert signal ${row.signalName}`;
        const self = this;
        return runnableEffect(withSqliteWriteRetryEffect(() => Effect.gen(function* () {
            const existing = yield* self.read(label, () => self.internalStorage.queryOne(`SELECT seq
               FROM _smithers_signals
               WHERE run_id = ?
                 AND signal_name = ?
                 AND ${row.correlationId === null ? "correlation_id IS NULL" : "correlation_id = ?"}
                 AND payload_json = ?
                 AND received_at_ms = ?
                 AND ${row.receivedBy == null ? "received_by IS NULL" : "received_by = ?"}
               ORDER BY seq DESC
               LIMIT 1`, [
                row.runId,
                row.signalName,
                ...(row.correlationId === null ? [] : [row.correlationId]),
                row.payloadJson,
                row.receivedAtMs,
                ...(row.receivedBy == null ? [] : [row.receivedBy]),
            ]));
            if (existing?.seq !== undefined) {
                return existing.seq;
            }
            const client = self.db.$client;
            if (!client ||
                typeof client.exec !== "function" ||
                typeof client.query !== "function") {
                const lastSeq = (yield* self.getLastSignalSeq(row.runId)) ?? -1;
                const seq = lastSeq + 1;
                yield* Effect.tryPromise({
                    try: () => self.internalStorage.insertIgnore("_smithers_signals", {
                        ...row,
                        receivedBy: row.receivedBy ?? null,
                        seq,
                    }),
                    catch: (cause) => toSmithersError(cause, "insert fallback signal row"),
                });
                return seq;
            }
            return yield* Effect.try({
                try: () => {
                    client.run("BEGIN IMMEDIATE");
                    try {
                        const res = client
                            .query("SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM _smithers_signals WHERE run_id = ?")
                            .get(row.runId);
                        const seq = Number(res?.seq ?? 0);
                        client
                            .query("INSERT INTO _smithers_signals (run_id, seq, signal_name, correlation_id, payload_json, received_at_ms, received_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
                            .run(row.runId, seq, row.signalName, row.correlationId, row.payloadJson, row.receivedAtMs, row.receivedBy ?? null);
                        client.run("COMMIT");
                        return seq;
                    }
                    catch (error) {
                        try {
                            client.run("ROLLBACK");
                        }
                        catch {
                            // ignore rollback failures
                        }
                        throw error;
                    }
                },
                catch: (cause) => toSmithersError(cause, "insert signal transaction"),
            });
        }), { label }).pipe(Effect.annotateLogs({
            runId: row.runId,
            signalName: row.signalName,
            correlationId: row.correlationId ?? null,
        }), Effect.withLogSpan(`db:${label}`)));
    }
    /**
   * @param {string} runId
   */
    getLastSignalSeq(runId) {
        return this.read(`get last signal seq ${runId}`, () => this.internalStorage.getLastSignalSeq(runId));
    }
    /**
   * @param {string} runId
   * @param {SignalQuery} [query]
   */
    listSignals(runId, query = {}) {
        const limit = Math.max(1, Math.floor(query.limit ?? 200));
        return this.read(`list signals ${runId}`, () => {
            const clauses = ["run_id = ?"];
            const params = [runId];
            if (query.signalName) {
                clauses.push("signal_name = ?");
                params.push(query.signalName);
            }
            if (query.correlationId !== undefined) {
                if (query.correlationId === null) {
                    clauses.push("correlation_id IS NULL");
                }
                else {
                    clauses.push("correlation_id = ?");
                    params.push(query.correlationId);
                }
            }
            if (typeof query.receivedAfterMs === "number") {
                clauses.push("received_at_ms >= ?");
                params.push(query.receivedAfterMs);
            }
            return this.internalStorage.queryAll(`SELECT *
         FROM _smithers_signals
         WHERE ${clauses.join(" AND ")}
         ORDER BY seq ASC
         LIMIT ?`, [...params, limit]);
        });
    }
    /**
   * @param {any} row
   */
    insertToolCall(row) {
        return this.write(`insert tool call ${row.toolName}`, () => this.internalStorage.insertIgnore("_smithers_tool_calls", row));
    }
    /**
   * @param {any} row
   */
    upsertSandbox(row) {
        return this.write(`upsert sandbox ${row.sandboxId}`, () => this.internalStorage.upsert("_smithers_sandboxes", row, ["runId", "sandboxId"]));
    }
    /**
   * @param {string} runId
   * @param {string} sandboxId
   */
    getSandbox(runId, sandboxId) {
        return this.read(`get sandbox ${sandboxId}`, () => this.internalStorage.queryOne(`SELECT *
         FROM _smithers_sandboxes
         WHERE run_id = ? AND sandbox_id = ?
         LIMIT 1`, [runId, sandboxId]));
    }
    /**
   * @param {string} runId
   */
    listSandboxes(runId) {
        return this.read(`list sandboxes ${runId}`, () => this.internalStorage.queryAll(`SELECT *
         FROM _smithers_sandboxes
         WHERE run_id = ?`, [runId]));
    }
    /**
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   */
    listToolCalls(runId, nodeId, iteration) {
        return this.read(`list tool calls ${nodeId}`, () => this.internalStorage.queryAll(`SELECT *
         FROM _smithers_tool_calls
         WHERE run_id = ? AND node_id = ? AND iteration = ?
         ORDER BY attempt ASC, seq ASC`, [runId, nodeId, iteration]));
    }
    /**
   * @param {any} row
   */
    insertEvent(row) {
        return this.write(`insert event ${row.type}`, () => this.internalStorage.insertIgnore("_smithers_events", row));
    }
    /**
   * @param {{ runId: string; timestampMs: number; type: string; payloadJson: string; }} row
   */
    insertEventWithNextSeq(row) {
        const label = `insert event ${row.type}`;
        const self = this;
        return runnableEffect(withSqliteWriteRetryEffect(() => Effect.gen(function* () {
            const existing = yield* self.read(label, () => self.internalStorage.queryOne(`SELECT seq
               FROM _smithers_events
               WHERE run_id = ?
                 AND timestamp_ms = ?
                 AND type = ?
                 AND payload_json = ?
               ORDER BY seq DESC
               LIMIT 1`, [row.runId, row.timestampMs, row.type, row.payloadJson]));
            if (existing?.seq !== undefined) {
                return existing.seq;
            }
            const client = self.db.$client;
            if (!client ||
                typeof client.exec !== "function" ||
                typeof client.query !== "function") {
                const lastSeq = (yield* self.getLastEventSeq(row.runId)) ?? -1;
                const seq = lastSeq + 1;
                yield* Effect.tryPromise({
                    try: () => self.internalStorage.insertIgnore("_smithers_events", { ...row, seq }),
                    catch: (cause) => toSmithersError(cause, "insert fallback event row"),
                });
                return seq;
            }
            return yield* Effect.try({
                try: () => {
                    client.run("BEGIN IMMEDIATE");
                    try {
                        const res = client
                            .query("SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM _smithers_events WHERE run_id = ?")
                            .get(row.runId);
                        const seq = Number(res?.seq ?? 0);
                        client
                            .query("INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json) VALUES (?, ?, ?, ?, ?)")
                            .run(row.runId, seq, row.timestampMs, row.type, row.payloadJson);
                        client.run("COMMIT");
                        return seq;
                    }
                    catch (error) {
                        try {
                            client.run("ROLLBACK");
                        }
                        catch {
                            // ignore rollback failures
                        }
                        throw error;
                    }
                },
                catch: (cause) => toSmithersError(cause, "insert event transaction"),
            });
        }), { label }).pipe(Effect.annotateLogs({ dbOperation: label }), Effect.withLogSpan(`db:${label}`)));
    }
    /**
   * @param {string} runId
   */
    getLastEventSeq(runId) {
        return this.read(`get last event seq ${runId}`, () => this.internalStorage.getLastEventSeq(runId));
    }
    /**
   * @param {string} runId
   * @param {EventHistoryQuery} [query]
   * @returns {{ whereSql: string; params: Array<string | number> }}
   */
    buildEventHistoryWhere(runId, query = {}) {
        const clauses = ["run_id = ?", "seq > ?"];
        const params = [runId, query.afterSeq ?? -1];
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
    /**
   * @param {string} runId
   * @param {EventHistoryQuery} [query]
   */
    listEventHistory(runId, query = {}) {
        return this.read(`list event history ${runId}`, () => this.internalStorage.listEventHistory(runId, query));
    }
    /**
   * @param {string} runId
   * @param {EventHistoryQuery} [query]
   */
    countEventHistory(runId, query = {}) {
        return this.read(`count event history ${runId}`, () => this.internalStorage.countEventHistory(runId, query));
    }
    /**
   * @param {string} runId
   * @param {number} afterSeq
   */
    listEvents(runId, afterSeq, limit = 200) {
        return this.listEventHistory(runId, { afterSeq, limit });
    }
    /**
   * @param {string} runId
   * @param {string} type
   */
    listEventsByType(runId, type) {
        return this.read(`list events by type ${type}`, () => this.internalStorage.listEventsByType(runId, type));
    }
    /**
   * @param {any} row
   */
    insertOrUpdateRalph(row) {
        return this.write(`upsert ralph ${row.ralphId}`, () => this.internalStorage.upsert("_smithers_ralph", row, ["runId", "ralphId"]));
    }
    /**
   * @param {string} runId
   */
    listRalph(runId) {
        return this.read(`list ralph ${runId}`, () => this.internalStorage.queryAll(`SELECT *
         FROM _smithers_ralph
         WHERE run_id = ?`, [runId], { booleanColumns: ["done"] }));
    }
    /**
   * @param {string} runId
   */
    listPendingApprovals(runId) {
        return this.read(`list pending approvals ${runId}`, () => this.internalStorage.queryAll(`SELECT *
         FROM _smithers_approvals
         WHERE run_id = ? AND status = ?`, [runId, "requested"], { booleanColumns: ["autoApproved"] }));
    }
    listAllPendingApprovals() {
        return this.read("list all pending approvals", () => this.internalStorage.queryAll(`SELECT
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
         ORDER BY COALESCE(a.requested_at_ms, 0) ASC, a.run_id, a.node_id, a.iteration`, ["requested"]));
    }
    /**
   * @param {string} workflowName
   * @param {string} nodeId
   */
    listApprovalHistoryForNode(workflowName, nodeId, limit = 50) {
        return this.read(`list approval history ${workflowName}:${nodeId}`, () => this.internalStorage.queryAll(`SELECT
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
         LIMIT ?`, [workflowName, nodeId, limit], { booleanColumns: ["autoApproved"] }));
    }
    /**
   * @param {string} runId
   * @param {string} ralphId
   */
    getRalph(runId, ralphId) {
        return this.read(`get ralph ${ralphId}`, () => this.internalStorage.queryOne(`SELECT *
         FROM _smithers_ralph
         WHERE run_id = ? AND ralph_id = ?
         LIMIT 1`, [runId, ralphId], { booleanColumns: ["done"] }));
    }
    /**
   * @param {any} row
   */
    insertCache(row) {
        return this.write(`insert cache ${row.cacheKey}`, () => this.internalStorage.insertIgnore("_smithers_cache", row));
    }
    /**
   * @param {any} row
   */
    insertCacheEffect(row) {
        return this.insertCache(row);
    }
    /**
   * @param {string} cacheKey
   */
    getCache(cacheKey) {
        return this.read(`get cache ${cacheKey}`, () => this.internalStorage.queryOne(`SELECT *
         FROM _smithers_cache
         WHERE cache_key = ?
         LIMIT 1`, [cacheKey]));
    }
    /**
   * @param {string} nodeId
   * @param {string} [outputTable]
   */
    listCacheByNode(nodeId, outputTable, limit = 20) {
        return this.read(`list cache by node ${nodeId}`, () => this.internalStorage.queryAll(`SELECT *
         FROM _smithers_cache
         WHERE node_id = ?${outputTable ? " AND output_table = ?" : ""}
         ORDER BY created_at_ms DESC
         LIMIT ?`, outputTable ? [nodeId, outputTable, limit] : [nodeId, limit]));
    }
    /**
   * @param {string} runId
   * @param {number} frameNo
   */
    deleteFramesAfter(runId, frameNo) {
        const self = this;
        return runnableEffect(Effect.gen(function* () {
            yield* self.write(`delete frames after ${frameNo}`, () => self.internalStorage.deleteWhere("_smithers_frames", "run_id = ? AND frame_no > ?", [runId, frameNo]));
            self.clearFrameCacheForRun(runId);
        }));
    }
    /**
   * @param {string} runId
   * @param {number} limit
   * @param {number} [afterFrameNo]
   */
    listFrames(runId, limit, afterFrameNo) {
        const self = this;
        return runnableEffect(Effect.gen(function* () {
            const rows = (yield* self.read(`list frames ${runId}`, () => self.internalStorage.queryAll(`SELECT *
           FROM _smithers_frames
           WHERE run_id = ?${afterFrameNo !== undefined ? " AND frame_no > ?" : ""}
           ORDER BY frame_no DESC
           LIMIT ?`, afterFrameNo !== undefined
                ? [runId, afterFrameNo, limit]
                : [runId, limit])));
            const localCache = new Map();
            const expanded = [];
            for (const row of rows) {
                expanded.push(yield* self.inflateFrameRow(row, localCache));
            }
            return expanded;
        }));
    }
    /**
   * @param {string} runId
   */
    countNodesByState(runId) {
        return this.read(`count nodes by state ${runId}`, () => this.internalStorage.queryAll(`SELECT state, COUNT(*) AS count
         FROM _smithers_nodes
         WHERE run_id = ?
         GROUP BY state`, [runId]));
    }
    /**
   * @param {any} row
   */
    upsertCron(row) {
        return this.write("upsert cron", () => this.internalStorage.upsert("_smithers_cron", row, ["cronId"], ["pattern", "workflowPath", "enabled", "nextRunAtMs"]));
    }
    listCrons(enabledOnly = true) {
        return this.read("list crons", () => this.internalStorage.queryAll(`SELECT *
         FROM _smithers_cron${enabledOnly ? " WHERE enabled = ?" : ""}`, enabledOnly ? [true] : [], { booleanColumns: ["enabled"] }));
    }
    /**
   * @param {string} cronId
   * @param {number} lastRunAtMs
   * @param {number} nextRunAtMs
   * @param {string | null} [errorJson]
   */
    updateCronRunTime(cronId, lastRunAtMs, nextRunAtMs, errorJson) {
        return this.write(`update cron run time ${cronId}`, () => this.internalStorage.updateWhere("_smithers_cron", { lastRunAtMs, nextRunAtMs, errorJson: errorJson ?? null }, "cron_id = ?", [cronId]));
    }
    /**
   * @param {string} cronId
   */
    deleteCron(cronId) {
        return this.write(`delete cron ${cronId}`, () => this.internalStorage.deleteWhere("_smithers_cron", "cron_id = ?", [cronId]));
    }
    // ---------------------------------------------------------------------------
    // Scorer results
    // ---------------------------------------------------------------------------
    /**
   * @param {any} row
   */
    insertScorerResult(row) {
        return this.write(`insert scorer result ${row.scorerId}`, () => this.internalStorage.insertIgnore("_smithers_scorers", row));
    }
    /**
   * @param {string} runId
   * @param {string} [nodeId]
   */
    listScorerResults(runId, nodeId) {
        return this.read(`list scorer results ${runId}`, () => this.internalStorage.queryAll(`SELECT *
         FROM _smithers_scorers
         WHERE run_id = ?${nodeId ? " AND node_id = ?" : ""}
         ORDER BY scored_at_ms ASC`, nodeId ? [runId, nodeId] : [runId]));
    }
    /**
   * @param {string} runId
   */
    getRunEffect(runId) {
        return this.getRun(runId);
    }
    /**
   * @param {string} [status]
   */
    listRunsEffect(limit = 50, status) {
        return this.listRuns(limit, status);
    }
    /**
   * @param {number} staleBeforeMs
   */
    listStaleRunningRunsEffect(staleBeforeMs, limit = 1000) {
        return this.listStaleRunningRuns(staleBeforeMs, limit);
    }
    /**
   * @param {Parameters<SmithersDb["claimRunForResume"]>[0]} params
   */
    claimRunForResumeEffect(params) {
        return this.claimRunForResume(params);
    }
    /**
   * @param {Parameters<SmithersDb["releaseRunResumeClaim"]>[0]} params
   */
    releaseRunResumeClaimEffect(params) {
        return this.releaseRunResumeClaim(params);
    }
    /**
   * @param {string} runId
   * @param {string} nodeId
   */
    listNodeIterationsEffect(runId, nodeId) {
        return this.listNodeIterations(runId, nodeId);
    }
    /**
   * @param {string} runId
   */
    listNodesEffect(runId) {
        return this.listNodes(runId);
    }
    /**
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   */
    listAttemptsEffect(runId, nodeId, iteration) {
        return this.listAttempts(runId, nodeId, iteration);
    }
    /**
   * @param {string} runId
   */
    listAttemptsForRunEffect(runId) {
        return this.listAttemptsForRun(runId);
    }
    /**
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   */
    listToolCallsEffect(runId, nodeId, iteration) {
        return this.listToolCalls(runId, nodeId, iteration);
    }
    /**
   * @param {string} tableName
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   */
    getRawNodeOutputForIterationEffect(tableName, runId, nodeId, iteration) {
        return this.getRawNodeOutputForIteration(tableName, runId, nodeId, iteration);
    }
    /**
   * @param {Parameters<SmithersDb["insertEventWithNextSeq"]>[0]} row
   */
    insertEventWithNextSeqEffect(row) {
        return this.insertEventWithNextSeq(row);
    }
    /**
   * @param {string} runId
   */
    getLastEventSeqEffect(runId) {
        return this.getLastEventSeq(runId);
    }
    /**
   * @param {string} runId
   * @param {EventHistoryQuery} [query]
   */
    listEventHistoryEffect(runId, query = {}) {
        return this.listEventHistory(runId, query);
    }
    /**
   * @param {string} runId
   * @param {EventHistoryQuery} [query]
   */
    countEventHistoryEffect(runId, query = {}) {
        return this.countEventHistory(runId, query);
    }
    /**
   * @param {string} runId
   * @param {string} type
   */
    listEventsByTypeEffect(runId, type) {
        return this.listEventsByType(runId, type);
    }
    /**
   * @param {string} runId
   */
    listPendingApprovalsEffect(runId) {
        return this.listPendingApprovals(runId);
    }
    /**
   * @param {string} runId
   */
    getLastFrameEffect(runId) {
        return this.getLastFrame(runId);
    }
    /**
   * @param {string} nodeId
   * @param {string} [outputTable]
   */
    listCacheByNodeEffect(nodeId, outputTable, limit = 20) {
        return this.listCacheByNode(nodeId, outputTable, limit);
    }
    listCronsEffect(enabledOnly = true) {
        return this.listCrons(enabledOnly);
    }
    /**
   * @param {string} cronId
   * @param {number} lastRunAtMs
   * @param {number} nextRunAtMs
   * @param {string | null} [errorJson]
   */
    updateCronRunTimeEffect(cronId, lastRunAtMs, nextRunAtMs, errorJson) {
        return this.updateCronRunTime(cronId, lastRunAtMs, nextRunAtMs, errorJson);
    }
    /**
   * @param {string} runId
   * @param {string} [nodeId]
   */
    listScorerResultsEffect(runId, nodeId) {
        return this.listScorerResults(runId, nodeId);
    }
}
