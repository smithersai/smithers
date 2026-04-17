import * as zod from 'zod';
import { z } from 'zod';
import * as drizzle_orm_bun_sqlite from 'drizzle-orm/bun-sqlite';
import * as _smithers_errors_SmithersError from '@smithers/errors/SmithersError';
import { SmithersError as SmithersError$3 } from '@smithers/errors/SmithersError';
import { Database } from 'bun:sqlite';
import { ManagedRuntime, Effect } from 'effect';
import * as SqlClient from '@effect/sql/SqlClient';
import { SqlError } from '@effect/sql/SqlError';
import * as drizzle_orm from 'drizzle-orm';
import * as drizzle_orm_sqlite_core from 'drizzle-orm/sqlite-core';
import * as drizzle_zod from 'drizzle-zod';
import * as _smithers_driver_OutputSnapshot from '@smithers/driver/OutputSnapshot';
export { smithersMemoryFacts, smithersMemoryMessages, smithersMemoryThreads } from '@smithers/memory/schema';
export { smithersScorers } from '@smithers/scorers/schema';

type SchemaRegistryEntry$1 = {
    table: any;
    zodSchema: zod.ZodObject<any>;
};

type SignalQuery$1 = {
    signalName?: string;
    correlationId?: string | null;
    receivedAfterMs?: number;
    limit?: number;
};

type OutputKey$2 = {
    runId: string;
    nodeId: string;
    iteration?: number;
};

type HumanRequestKind = "ask" | "confirm" | "select" | "json";
type HumanRequestStatus = "pending" | "answered" | "cancelled" | "expired";
type HumanRequestRow$1 = {
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

type EventHistoryQuery$1 = {
    afterSeq?: number;
    limit?: number;
    nodeId?: string;
    types?: readonly string[];
    sinceTimestampMs?: number;
};

type AttemptRow$1 = {
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

declare const DB_ALERT_ALLOWED_STATUSES$1: string[];

type AlertStatus$1 = (typeof DB_ALERT_ALLOWED_STATUSES$1)[number];

declare const DB_ALERT_ALLOWED_SEVERITIES$1: string[];

type AlertSeverity$1 = (typeof DB_ALERT_ALLOWED_SEVERITIES$1)[number];

type AlertRow$1 = {
    alertId: string;
    runId: string | null;
    policyName: string;
    severity: AlertSeverity$1;
    status: AlertStatus$1;
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

type StaleRunRecord$1 = {
    runId: string;
    workflowPath: string | null;
    heartbeatAtMs: number | null;
    runtimeOwnerId: string | null;
    status: string;
};

type SignalRow$1 = {
    runId: string;
    seq: number;
    signalName: string;
    correlationId: string | null;
    payloadJson: string;
    receivedAtMs: number;
    receivedBy: string | null;
};

type RunRow$1 = {
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

type RunAncestryRow$1 = {
    runId: string;
    parentRunId: string | null;
    depth: number;
};

type PendingHumanRequestRow$1 = HumanRequestRow$1 & {
    workflowName: string | null;
    runStatus: string | null;
    nodeLabel: string | null;
};

type NodeRow$1 = {
    runId: string;
    nodeId: string;
    iteration: number;
    state: string;
    lastAttempt: number | null;
    updatedAtMs: number;
    outputTable: string;
    label: string | null;
};

type CacheRow$1 = {
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

type ApprovalRow$1 = {
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

type SqlMessageStorageEventHistoryQuery$1 = {
    afterSeq?: number;
    limit?: number;
    nodeId?: string;
    types?: readonly string[];
    sinceTimestampMs?: number;
};

/**
 * @param {BunSQLiteDatabase<any> | Database} db
 * @returns {SqlMessageStorage}
 */
declare function getSqlMessageStorage(db: BunSQLiteDatabase$2<any> | Database): SqlMessageStorage;
/**
 * @param {BunSQLiteDatabase<any> | Database} db
 * @returns {Effect.Effect<void, never>}
 */
declare function ensureSqlMessageStorageEffect(db: BunSQLiteDatabase$2<any> | Database): Effect.Effect<void, never>;
/**
 * @param {BunSQLiteDatabase<any> | Database} db
 * @returns {Promise<void>}
 */
declare function ensureSqlMessageStorage(db: BunSQLiteDatabase$2<any> | Database): Promise<void>;
declare class SqlMessageStorage {
    /**
   * @param {BunSQLiteDatabase<any> | Database} db
   */
    constructor(db: BunSQLiteDatabase$2<any> | Database);
    sqlite: Database;
    runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, never>;
    tableColumnsCache: Map<any, any>;
    /**
   * @param {string} table
   * @returns {Set<string>}
   */
    getTableColumns(table: string): Set<string>;
    /**
   * @param {string} table
   * @param {Record<string, unknown>} row
   * @returns {Record<string, unknown>}
   */
    filterKnownColumns(table: string, row: Record<string, unknown>): Record<string, unknown>;
    /**
   * @template A, E
   * @param {Effect.Effect<A, E, SqlClient.SqlClient>} effect
   * @returns {Promise<A>}
   */
    runEffect<A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A>;
    /**
   * @template A
   * @param {(connection: Connection) => Effect.Effect<A, SqlError>} f
   * @returns {Promise<A>}
   */
    withConnection<A>(f: (connection: Connection) => Effect.Effect<A, SqlError>): Promise<A>;
    /**
   * @returns {Effect.Effect<void, never>}
   */
    ensureSchemaEffect(): Effect.Effect<void, never>;
    /**
   * @returns {Promise<void>}
   */
    ensureSchema(): Promise<void>;
    /**
   * @template T
   * @param {string} statement
   * @param {ReadonlyArray<SqliteParam>} [params]
   * @param {{ booleanColumns?: readonly string[] }} [options]
   * @returns {Promise<Array<T>>}
   */
    queryAll<T>(statement: string, params?: ReadonlyArray<SqliteParam>, options?: {
        booleanColumns?: readonly string[];
    }): Promise<Array<T>>;
    /**
   * @template T
   * @param {string} statement
   * @param {ReadonlyArray<SqliteParam>} [params]
   * @param {{ booleanColumns?: readonly string[] }} [options]
   * @returns {Promise<T | undefined>}
   */
    queryOne<T>(statement: string, params?: ReadonlyArray<SqliteParam>, options?: {
        booleanColumns?: readonly string[];
    }): Promise<T | undefined>;
    /**
   * @param {string} statement
   * @param {ReadonlyArray<SqliteParam>} [params]
   * @returns {Promise<void>}
   */
    execute(statement: string, params?: ReadonlyArray<SqliteParam>): Promise<void>;
    /**
   * @param {string} table
   * @param {Record<string, unknown>} row
   * @returns {Promise<void>}
   */
    insertIgnore(table: string, row: Record<string, unknown>): Promise<void>;
    /**
   * @param {string} table
   * @param {Record<string, unknown>} row
   * @param {readonly string[]} conflictColumns
   * @param {readonly string[]} [updateColumns]
   * @returns {Promise<void>}
   */
    upsert(table: string, row: Record<string, unknown>, conflictColumns: readonly string[], updateColumns?: readonly string[]): Promise<void>;
    /**
   * @param {string} table
   * @param {Record<string, unknown>} patch
   * @param {string} whereSql
   * @param {ReadonlyArray<SqliteParam>} [params]
   * @returns {Promise<void>}
   */
    updateWhere(table: string, patch: Record<string, unknown>, whereSql: string, params?: ReadonlyArray<SqliteParam>): Promise<void>;
    /**
   * @param {string} table
   * @param {string} whereSql
   * @param {ReadonlyArray<SqliteParam>} [params]
   * @returns {Promise<void>}
   */
    deleteWhere(table: string, whereSql: string, params?: ReadonlyArray<SqliteParam>): Promise<void>;
    /**
   * @param {string} runId
   * @param {SqlMessageStorageEventHistoryQuery} [query]
   * @returns {{ whereSql: string; params: Array<SqliteParam> }}
   */
    buildEventHistoryWhere(runId: string, query?: SqlMessageStorageEventHistoryQuery): {
        whereSql: string;
        params: Array<SqliteParam>;
    };
    /**
   * @param {string} runId
   * @param {SqlMessageStorageEventHistoryQuery} [query]
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
    listEventHistory(runId: string, query?: SqlMessageStorageEventHistoryQuery): Promise<Array<Record<string, unknown>>>;
    /**
   * @param {string} runId
   * @param {SqlMessageStorageEventHistoryQuery} [query]
   * @returns {Promise<number>}
   */
    countEventHistory(runId: string, query?: SqlMessageStorageEventHistoryQuery): Promise<number>;
    /**
   * @param {string} runId
   * @returns {Promise<number | undefined>}
   */
    getLastEventSeq(runId: string): Promise<number | undefined>;
    /**
   * @param {string} runId
   * @param {string} type
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
    listEventsByType(runId: string, type: string): Promise<Array<Record<string, unknown>>>;
    /**
   * @param {string} runId
   * @returns {Promise<number | undefined>}
   */
    getLastSignalSeq(runId: string): Promise<number | undefined>;
}
type BunSQLiteDatabase$2 = drizzle_orm_bun_sqlite.BunSQLiteDatabase;
type SqlMessageStorageEventHistoryQuery = SqlMessageStorageEventHistoryQuery$1;
type SqliteParam = string | number | bigint | boolean | Uint8Array | null | undefined;

/** @typedef {import("./adapter/AlertRow.ts").AlertRow} AlertRow */
/** @typedef {import("./adapter/AlertStatus.ts").AlertStatus} AlertStatus */
/** @typedef {import("./adapter/AttemptRow.ts").AttemptRow} AttemptRow */
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase} BunSQLiteDatabase */
/** @typedef {import("./adapter/EventHistoryQuery.ts").EventHistoryQuery} EventHistoryQuery */
/** @typedef {import("./adapter/HumanRequestRow.ts").HumanRequestRow} HumanRequestRow */
/** @typedef {import("./output/OutputKey.ts").OutputKey} OutputKey */
/**
 * @template A, E
 * @typedef {Effect.Effect<A, E> & PromiseLike<A>} RunnableEffect
 */
/** @typedef {import("./adapter/SignalQuery.ts").SignalQuery} SignalQuery */
/** @typedef {import("@smithers/errors/SmithersError").SmithersError} SmithersError */
declare const DB_ALERT_ID_MAX_LENGTH: 256;
declare const DB_ALERT_POLICY_NAME_MAX_LENGTH: 256;
declare const DB_ALERT_MESSAGE_MAX_LENGTH: 4096;
declare const DB_ALERT_ALLOWED_SEVERITIES: string[];
declare const DB_ALERT_ALLOWED_STATUSES: string[];
declare const DB_RUN_ID_MAX_LENGTH: 256;
declare const DB_RUN_WORKFLOW_NAME_MAX_LENGTH: 256;
declare const DB_RUN_ALLOWED_STATUSES: string[];
declare class SmithersDb$1 {
    /**
   * @param {BunSQLiteDatabase<any>} db
   */
    constructor(db: BunSQLiteDatabase$1<any>);
    db: any;
    internalStorage: SqlMessageStorage;
    reconstructedFrameXmlCache: Map<any, any>;
    transactionDepth: number;
    transactionOwnerThread: null;
    transactionTail: Promise<void>;
    /**
   * @param {string} runId
   * @param {number} frameNo
   * @returns {string}
   */
    frameCacheKey(runId: string, frameNo: number): string;
    /**
   * @param {string} runId
   * @param {number} frameNo
   * @returns {string | undefined}
   */
    getCachedFrameXml(runId: string, frameNo: number): string | undefined;
    /**
   * @param {string} runId
   * @param {number} frameNo
   * @param {string} xmlJson
   */
    rememberFrameXml(runId: string, frameNo: number, xmlJson: string): void;
    /**
   * @param {string} runId
   */
    clearFrameCacheForRun(runId: string): void;
    /**
   * @param {string} queryString
   */
    rawQuery(queryString: string): RunnableEffect<any, unknown>;
    /**
   * @param {string} currentFiberThread
   * @returns {boolean}
   */
    ownsActiveTransaction(currentFiberThread: string): boolean;
    /**
   * @template A
   * @param {string} label
   * @param {() => PromiseLike<A>} operation
   * @returns {RunnableEffect<A>}
   */
    read<A>(label: string, operation: () => PromiseLike<A>): RunnableEffect<A>;
    /**
   * @template A
   * @param {string} label
   * @param {() => PromiseLike<A>} operation
   * @returns {RunnableEffect<A>}
   */
    write<A>(label: string, operation: () => PromiseLike<A>): RunnableEffect<A>;
    getSqliteTransactionClient(): Effect.Effect<any, _smithers_errors_SmithersError.SmithersError, never>;
    acquireTransactionTurn(): Effect.Effect<undefined, _smithers_errors_SmithersError.SmithersError, never>;
    /**
   * @template A
   * @param {string} writeGroup
   * @param {Effect.Effect<A, SmithersError>} operation
   * @returns {RunnableEffect<A>}
   */
    withTransactionEffect<A>(writeGroup: string, operation: Effect.Effect<A, SmithersError$2>): RunnableEffect<A>;
    /**
   * @template A
   * @param {string} writeGroup
   * @param {Effect.Effect<A, SmithersError>} operation
   * @returns {Promise<A>}
   */
    withTransaction<A>(writeGroup: string, operation: Effect.Effect<A, SmithersError$2>): Promise<A>;
    /**
   * @param {any} row
   */
    insertRun(row: any): any;
    /**
   * @param {string} runId
   * @param {any} patch
   */
    updateRun(runId: string, patch: any): any;
    /**
   * @param {string} runId
   * @param {any} patch
   */
    updateRunEffect(runId: string, patch: any): any;
    /**
   * @param {string} runId
   * @param {string} runtimeOwnerId
   * @param {number} heartbeatAtMs
   */
    heartbeatRun(runId: string, runtimeOwnerId: string, heartbeatAtMs: number): any;
    /**
   * @param {string} runId
   * @param {number} cancelRequestedAtMs
   */
    requestRunCancel(runId: string, cancelRequestedAtMs: number): any;
    /**
   * @param {string} runId
   * @param {number} hijackRequestedAtMs
   * @param {string | null} [hijackTarget]
   */
    requestRunHijack(runId: string, hijackRequestedAtMs: number, hijackTarget?: string | null): any;
    /**
   * @param {string} runId
   */
    clearRunHijack(runId: string): any;
    /**
   * @param {string} runId
   */
    getRun(runId: string): any;
    /**
   * @param {string} runId
   */
    listRunAncestry(runId: string, limit?: number): any;
    /**
   * @param {string} parentRunId
   */
    getLatestChildRun(parentRunId: string): any;
    /**
   * @param {string} [status]
   */
    listRuns(limit?: number, status?: string): any;
    /**
   * @param {number} staleBeforeMs
   */
    listStaleRunningRuns(staleBeforeMs: number, limit?: number): any;
    /**
   * @param {{ runId: string; expectedStatus?: string; expectedRuntimeOwnerId: string | null; expectedHeartbeatAtMs: number | null; staleBeforeMs: number; claimOwnerId: string; claimHeartbeatAtMs: number; requireStale?: boolean; }} params
   */
    claimRunForResume(params: {
        runId: string;
        expectedStatus?: string;
        expectedRuntimeOwnerId: string | null;
        expectedHeartbeatAtMs: number | null;
        staleBeforeMs: number;
        claimOwnerId: string;
        claimHeartbeatAtMs: number;
        requireStale?: boolean;
    }): any;
    /**
   * @param {{ runId: string; claimOwnerId: string; restoreRuntimeOwnerId: string | null; restoreHeartbeatAtMs: number | null; }} params
   */
    releaseRunResumeClaim(params: {
        runId: string;
        claimOwnerId: string;
        restoreRuntimeOwnerId: string | null;
        restoreHeartbeatAtMs: number | null;
    }): any;
    /**
   * @param {{ runId: string; expectedRuntimeOwnerId: string; expectedHeartbeatAtMs: number | null; patch: any; }} params
   */
    updateClaimedRun(params: {
        runId: string;
        expectedRuntimeOwnerId: string;
        expectedHeartbeatAtMs: number | null;
        patch: any;
    }): any;
    /**
   * @param {any} row
   */
    insertNode(row: any): any;
    /**
   * @param {any} row
   */
    insertNodeEffect(row: any): any;
    /**
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   */
    getNode(runId: string, nodeId: string, iteration: number): any;
    /**
   * @param {string} runId
   * @param {string} nodeId
   */
    listNodeIterations(runId: string, nodeId: string): any;
    /**
   * @param {string} runId
   */
    listNodes(runId: string): any;
    /**
   * @param {any} table
   * @param {OutputKey} key
   * @param {Record<string, unknown>} payload
   */
    upsertOutputRow(table: any, key: OutputKey$1, payload: Record<string, unknown>): any;
    /**
   * @param {any} table
   * @param {OutputKey} key
   * @param {Record<string, unknown>} payload
   */
    upsertOutputRowEffect(table: any, key: OutputKey$1, payload: Record<string, unknown>): any;
    /**
   * @param {string} tableName
   * @param {OutputKey} key
   */
    deleteOutputRow(tableName: string, key: OutputKey$1): any;
    /**
   * @param {string} tableName
   * @param {OutputKey} key
   */
    deleteOutputRowEffect(tableName: string, key: OutputKey$1): any;
    /**
   * @param {string} tableName
   * @param {string} runId
   * @param {string} nodeId
   */
    getRawNodeOutput(tableName: string, runId: string, nodeId: string): RunnableEffect<any, any>;
    /**
   * @param {string} tableName
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   */
    getRawNodeOutputForIteration(tableName: string, runId: string, nodeId: string, iteration: number): RunnableEffect<any, any>;
    /**
   * @param {any} row
   */
    insertAttempt(row: any): any;
    /**
   * @param {any} row
   */
    insertAttemptEffect(row: any): any;
    /**
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   * @param {number} attempt
   * @param {any} patch
   */
    updateAttempt(runId: string, nodeId: string, iteration: number, attempt: number, patch: any): any;
    /**
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   * @param {number} attempt
   * @param {any} patch
   */
    updateAttemptEffect(runId: string, nodeId: string, iteration: number, attempt: number, patch: any): any;
    /**
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   * @param {number} attempt
   * @param {number} heartbeatAtMs
   * @param {string | null} heartbeatDataJson
   */
    heartbeatAttempt(runId: string, nodeId: string, iteration: number, attempt: number, heartbeatAtMs: number, heartbeatDataJson: string | null): any;
    /**
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   * @returns {RunnableEffect<AttemptRow[]>}
   */
    listAttempts(runId: string, nodeId: string, iteration: number): RunnableEffect<AttemptRow[]>;
    /**
   * @param {string} runId
   * @returns {RunnableEffect<AttemptRow[]>}
   */
    listAttemptsForRun(runId: string): RunnableEffect<AttemptRow[]>;
    /**
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   * @param {number} attempt
   * @returns {RunnableEffect<AttemptRow | undefined>}
   */
    getAttempt(runId: string, nodeId: string, iteration: number, attempt: number): RunnableEffect<AttemptRow | undefined>;
    /**
   * @param {string} runId
   * @returns {RunnableEffect<AttemptRow[]>}
   */
    listInProgressAttempts(runId: string): RunnableEffect<AttemptRow[]>;
    /**
   * @returns {RunnableEffect<any[]>}
   */
    listAllInProgressAttempts(): RunnableEffect<any[]>;
    /**
   * @param {string} runId
   * @param {number} frameNo
   * @param {number} [limit]
   */
    listFrameChainDesc(runId: string, frameNo: number, limit?: number): any;
    /**
   * @param {string} runId
   * @param {number} frameNo
   */
    reconstructFrameXml(runId: string, frameNo: number, localCache?: Map<any, any>): Effect.Effect<any, unknown, unknown>;
    /**
   * @param {any} row
   */
    inflateFrameRow(row: any, localCache?: Map<any, any>): Effect.Effect<any, unknown, unknown>;
    /**
   * @param {any} row
   */
    insertFrame(row: any): RunnableEffect<void, unknown>;
    /**
   * @param {any} row
   */
    insertFrameEffect(row: any): RunnableEffect<void, unknown>;
    /**
   * @param {string} runId
   */
    getLastFrame(runId: string): RunnableEffect<any, unknown>;
    /**
   * @param {any} row
   */
    insertOrUpdateApproval(row: any): any;
    /**
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   */
    getApproval(runId: string, nodeId: string, iteration: number): any;
    /**
   * @param {HumanRequestRow} row
   */
    insertHumanRequest(row: HumanRequestRow): any;
    /**
   * @param {string} requestId
   */
    getHumanRequest(requestId: string): any;
    /**
   * @param {string} requestId
   */
    reopenHumanRequest(requestId: string): any;
    expireStaleHumanRequests(nowMs?: number): any;
    listPendingHumanRequests(nowMs?: number): RunnableEffect<any, unknown>;
    /**
   * @param {string} requestId
   * @param {string} responseJson
   * @param {number} answeredAtMs
   * @param {string | null} [answeredBy]
   */
    answerHumanRequest(requestId: string, responseJson: string, answeredAtMs: number, answeredBy?: string | null): any;
    /**
   * @param {string} requestId
   */
    cancelHumanRequest(requestId: string): any;
    /**
   * @param {AlertRow} row
   */
    insertAlert(row: AlertRow): Promise<any>;
    /**
   * @param {string} alertId
   */
    getAlert(alertId: string): any;
    /**
   * @param {readonly AlertStatus[]} [statuses]
   */
    listAlerts(limit?: number, statuses?: readonly AlertStatus[]): any;
    /**
   * @param {string} alertId
   */
    acknowledgeAlert(alertId: string, acknowledgedAtMs?: number): Promise<any>;
    /**
   * @param {string} alertId
   */
    resolveAlert(alertId: string, resolvedAtMs?: number): Promise<any>;
    /**
   * @param {string} alertId
   */
    silenceAlert(alertId: string): Promise<any>;
    /**
   * @param {{ runId: string; signalName: string; correlationId: string | null; payloadJson: string; receivedAtMs: number; receivedBy?: string | null; }} row
   */
    insertSignalWithNextSeq(row: {
        runId: string;
        signalName: string;
        correlationId: string | null;
        payloadJson: string;
        receivedAtMs: number;
        receivedBy?: string | null;
    }): RunnableEffect<any, _smithers_errors_SmithersError.SmithersError>;
    /**
   * @param {string} runId
   */
    getLastSignalSeq(runId: string): any;
    /**
   * @param {string} runId
   * @param {SignalQuery} [query]
   */
    listSignals(runId: string, query?: SignalQuery): any;
    /**
   * @param {any} row
   */
    insertToolCall(row: any): any;
    /**
   * @param {any} row
   */
    upsertSandbox(row: any): any;
    /**
   * @param {string} runId
   * @param {string} sandboxId
   */
    getSandbox(runId: string, sandboxId: string): any;
    /**
   * @param {string} runId
   */
    listSandboxes(runId: string): any;
    /**
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   */
    listToolCalls(runId: string, nodeId: string, iteration: number): any;
    /**
   * @param {any} row
   */
    insertEvent(row: any): any;
    /**
   * @param {{ runId: string; timestampMs: number; type: string; payloadJson: string; }} row
   */
    insertEventWithNextSeq(row: {
        runId: string;
        timestampMs: number;
        type: string;
        payloadJson: string;
    }): RunnableEffect<any, _smithers_errors_SmithersError.SmithersError>;
    /**
   * @param {string} runId
   */
    getLastEventSeq(runId: string): any;
    /**
   * @param {string} runId
   * @param {EventHistoryQuery} [query]
   * @returns {{ whereSql: string; params: Array<string | number> }}
   */
    buildEventHistoryWhere(runId: string, query?: EventHistoryQuery): {
        whereSql: string;
        params: Array<string | number>;
    };
    /**
   * @param {string} runId
   * @param {EventHistoryQuery} [query]
   */
    listEventHistory(runId: string, query?: EventHistoryQuery): any;
    /**
   * @param {string} runId
   * @param {EventHistoryQuery} [query]
   */
    countEventHistory(runId: string, query?: EventHistoryQuery): any;
    /**
   * @param {string} runId
   * @param {number} afterSeq
   */
    listEvents(runId: string, afterSeq: number, limit?: number): any;
    /**
   * @param {string} runId
   * @param {string} type
   */
    listEventsByType(runId: string, type: string): any;
    /**
   * @param {any} row
   */
    insertOrUpdateRalph(row: any): any;
    /**
   * @param {string} runId
   */
    listRalph(runId: string): any;
    /**
   * @param {string} runId
   */
    listPendingApprovals(runId: string): any;
    listAllPendingApprovals(): any;
    /**
   * @param {string} workflowName
   * @param {string} nodeId
   */
    listApprovalHistoryForNode(workflowName: string, nodeId: string, limit?: number): any;
    /**
   * @param {string} runId
   * @param {string} ralphId
   */
    getRalph(runId: string, ralphId: string): any;
    /**
   * @param {any} row
   */
    insertCache(row: any): any;
    /**
   * @param {any} row
   */
    insertCacheEffect(row: any): any;
    /**
   * @param {string} cacheKey
   */
    getCache(cacheKey: string): any;
    /**
   * @param {{ runId: string; nodeId: string; iteration: number; baseRef: string; diffJson: string; computedAtMs: number; sizeBytes: number; }} row
   */
    upsertNodeDiffCache(row: {
        runId: string;
        nodeId: string;
        iteration: number;
        baseRef: string;
        diffJson: string;
        computedAtMs: number;
        sizeBytes: number;
    }): any;
    /**
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   * @param {string} baseRef
   */
    getNodeDiffCache(runId: string, nodeId: string, iteration: number, baseRef: string): any;
    /**
   * @param {string} [runId]
   */
    countNodeDiffCacheRows(runId?: string): RunnableEffect<number, unknown>;
    /**
   * @param {string} runId
   * @param {number} targetFrameNo
   */
    invalidateNodeDiffsAfterFrame(runId: string, targetFrameNo: number): RunnableEffect<number, unknown>;
    /**
   * @param {string} nodeId
   * @param {string} [outputTable]
   */
    listCacheByNode(nodeId: string, outputTable?: string, limit?: number): any;
    /**
   * @param {string} runId
   * @param {number} frameNo
   */
    deleteFramesAfter(runId: string, frameNo: number): RunnableEffect<void, unknown>;
    /**
   * @param {string} runId
   * @param {number} limit
   * @param {number} [afterFrameNo]
   */
    listFrames(runId: string, limit: number, afterFrameNo?: number): RunnableEffect<any[], unknown>;
    /**
   * @param {string} runId
   */
    countNodesByState(runId: string): any;
    /**
   * @param {any} row
   */
    upsertCron(row: any): any;
    listCrons(enabledOnly?: boolean): any;
    /**
   * @param {string} cronId
   * @param {number} lastRunAtMs
   * @param {number} nextRunAtMs
   * @param {string | null} [errorJson]
   */
    updateCronRunTime(cronId: string, lastRunAtMs: number, nextRunAtMs: number, errorJson?: string | null): any;
    /**
   * @param {string} cronId
   */
    deleteCron(cronId: string): any;
    /**
   * @param {any} row
   */
    insertScorerResult(row: any): any;
    /**
   * @param {string} runId
   * @param {string} [nodeId]
   */
    listScorerResults(runId: string, nodeId?: string): any;
    /**
   * @param {string} runId
   */
    getRunEffect(runId: string): any;
    /**
   * @param {string} [status]
   */
    listRunsEffect(limit?: number, status?: string): any;
    /**
   * @param {number} staleBeforeMs
   */
    listStaleRunningRunsEffect(staleBeforeMs: number, limit?: number): any;
    /**
   * @param {Parameters<SmithersDb["claimRunForResume"]>[0]} params
   */
    claimRunForResumeEffect(params: Parameters<SmithersDb$1["claimRunForResume"]>[0]): any;
    /**
   * @param {Parameters<SmithersDb["releaseRunResumeClaim"]>[0]} params
   */
    releaseRunResumeClaimEffect(params: Parameters<SmithersDb$1["releaseRunResumeClaim"]>[0]): any;
    /**
   * @param {string} runId
   * @param {string} nodeId
   */
    listNodeIterationsEffect(runId: string, nodeId: string): any;
    /**
   * @param {string} runId
   */
    listNodesEffect(runId: string): any;
    /**
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   */
    listAttemptsEffect(runId: string, nodeId: string, iteration: number): any;
    /**
   * @param {string} runId
   */
    listAttemptsForRunEffect(runId: string): any;
    /**
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   */
    listToolCallsEffect(runId: string, nodeId: string, iteration: number): any;
    /**
   * @param {string} tableName
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   */
    getRawNodeOutputForIterationEffect(tableName: string, runId: string, nodeId: string, iteration: number): RunnableEffect<any, any>;
    /**
   * @param {Parameters<SmithersDb["insertEventWithNextSeq"]>[0]} row
   */
    insertEventWithNextSeqEffect(row: Parameters<SmithersDb$1["insertEventWithNextSeq"]>[0]): RunnableEffect<any, _smithers_errors_SmithersError.SmithersError>;
    /**
   * @param {string} runId
   */
    getLastEventSeqEffect(runId: string): any;
    /**
   * @param {string} runId
   * @param {EventHistoryQuery} [query]
   */
    listEventHistoryEffect(runId: string, query?: EventHistoryQuery): any;
    /**
   * @param {string} runId
   * @param {EventHistoryQuery} [query]
   */
    countEventHistoryEffect(runId: string, query?: EventHistoryQuery): any;
    /**
   * @param {string} runId
   * @param {string} type
   */
    listEventsByTypeEffect(runId: string, type: string): any;
    /**
   * @param {string} runId
   */
    listPendingApprovalsEffect(runId: string): any;
    /**
   * @param {string} runId
   */
    getLastFrameEffect(runId: string): RunnableEffect<any, unknown>;
    /**
   * @param {string} nodeId
   * @param {string} [outputTable]
   */
    listCacheByNodeEffect(nodeId: string, outputTable?: string, limit?: number): any;
    listCronsEffect(enabledOnly?: boolean): any;
    /**
   * @param {string} cronId
   * @param {number} lastRunAtMs
   * @param {number} nextRunAtMs
   * @param {string | null} [errorJson]
   */
    updateCronRunTimeEffect(cronId: string, lastRunAtMs: number, nextRunAtMs: number, errorJson?: string | null): any;
    /**
   * @param {string} runId
   * @param {string} [nodeId]
   */
    listScorerResultsEffect(runId: string, nodeId?: string): any;
}
type AlertSeverity = AlertSeverity$1;
type ApprovalRow = ApprovalRow$1;
type CacheRow = CacheRow$1;
type NodeRow = NodeRow$1;
type PendingHumanRequestRow = PendingHumanRequestRow$1;
type RunAncestryRow = RunAncestryRow$1;
type RunRow = RunRow$1;
type SignalRow = SignalRow$1;
type StaleRunRecord = StaleRunRecord$1;
type AlertRow = AlertRow$1;
type AlertStatus = AlertStatus$1;
type AttemptRow = AttemptRow$1;
type BunSQLiteDatabase$1 = drizzle_orm_bun_sqlite.BunSQLiteDatabase;
type EventHistoryQuery = EventHistoryQuery$1;
type HumanRequestRow = HumanRequestRow$1;
type OutputKey$1 = OutputKey$2;
type RunnableEffect<A, E> = Effect.Effect<A, E> & PromiseLike<A>;
type SignalQuery = SignalQuery$1;
type SmithersError$2 = _smithers_errors_SmithersError.SmithersError;

/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase} BunSQLiteDatabase */
/** @typedef {import("@smithers/errors/SmithersError").SmithersError} SmithersError */
/**
 * @param {BunSQLiteDatabase<any>} db
 * @returns {Effect.Effect<void, SmithersError>}
 */
declare function ensureSmithersTablesEffect(db: BunSQLiteDatabase<any>): Effect.Effect<void, SmithersError$1>;
/**
 * @param {BunSQLiteDatabase<any>} db
 */
declare function ensureSmithersTables(db: BunSQLiteDatabase<any>): void;
type BunSQLiteDatabase = drizzle_orm_bun_sqlite.BunSQLiteDatabase;
type SmithersError$1 = _smithers_errors_SmithersError.SmithersError;

type JsonBounds$2 = {
    maxArrayLength?: number;
    maxBytes?: number;
    maxDepth?: number;
    maxStringLength?: number;
};

/**
 * @param {string} field
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {string}
 */
declare function assertMaxStringLength(field: string, value: unknown, maxLength: number): string;

/**
 * @param {string} field
 * @param {unknown} value
 * @param {number} maxLength
 */
declare function assertOptionalStringMaxLength(field: string, value: unknown, maxLength: number): void;

/**
 * @param {string} field
 * @param {unknown} value
 * @param {number} maxLength
 */
declare function assertOptionalArrayMaxLength(field: string, value: unknown, maxLength: number): void;

/**
 * @param {string} field
 * @param {unknown} value
 * @returns {number}
 */
declare function assertPositiveFiniteNumber(field: string, value: unknown): number;

/**
 * @param {string} field
 * @param {unknown} value
 * @returns {number}
 */
declare function assertPositiveFiniteInteger(field: string, value: unknown): number;

/**
 * @param {string} field
 * @param {string | ArrayBuffer | ArrayBufferView} value
 * @param {number} maxBytes
 * @returns {number}
 */
declare function assertMaxBytes(field: string, value: string | ArrayBuffer | ArrayBufferView, maxBytes: number): number;

/**
 * @param {string} field
 * @param {unknown} value
 * @param {number} maxDepth
 */
declare function assertMaxJsonDepth(field: string, value: unknown, maxDepth: number): void;

/**
 * @param {string} field
 * @param {unknown} value
 * @param {JsonBounds} bounds
 * @returns {string}
 */
declare function assertJsonPayloadWithinBounds(field: string, value: unknown, bounds: JsonBounds$1): string;
type JsonBounds$1 = JsonBounds$2;

type JsonBounds = JsonBounds$2;

type JsonPathSegment$1 = string | number;

type JsonPath$1 = JsonPathSegment$1[];

type FrameEncoding$1 = "full" | "delta" | "keyframe";

type FrameDeltaOp$1 = {
    op: "set";
    path: JsonPath$1;
    value: unknown;
    nodeId?: string;
} | {
    op: "insert";
    path: JsonPath$1;
    value: unknown;
    nodeId?: string;
} | {
    op: "remove";
    path: JsonPath$1;
    nodeId?: string;
};

type FrameDelta$1 = {
    version: 1;
    ops: FrameDeltaOp$1[];
};

/**
 * @param {unknown} value
 * @returns {FrameEncoding}
 */
declare function normalizeFrameEncoding(value: unknown): FrameEncoding;
/**
 * @param {string} deltaJson
 * @returns {FrameDelta}
 */
declare function parseFrameDelta(deltaJson: string): FrameDelta;
/**
 * @param {FrameDelta} delta
 * @returns {string}
 */
declare function serializeFrameDelta(delta: FrameDelta): string;
/**
 * @param {string} previousXmlJson
 * @param {string} nextXmlJson
 * @returns {FrameDelta}
 */
declare function encodeFrameDelta(previousXmlJson: string, nextXmlJson: string): FrameDelta;
/**
 * @param {string} previousXmlJson
 * @param {FrameDelta} delta
 * @returns {string}
 */
declare function applyFrameDelta(previousXmlJson: string, delta: FrameDelta): string;
/**
 * @param {string} previousXmlJson
 * @param {string} deltaJson
 * @returns {string}
 */
declare function applyFrameDeltaJson(previousXmlJson: string, deltaJson: string): string;
/** @typedef {import("./frame-codec/FrameDelta.ts").FrameDelta} FrameDelta */
/** @typedef {import("./frame-codec/FrameDeltaOp.ts").FrameDeltaOp} FrameDeltaOp */
/** @typedef {import("./frame-codec/FrameEncoding.ts").FrameEncoding} FrameEncoding */
/** @typedef {import("./frame-codec/JsonPath.ts").JsonPath} JsonPath */
/** @typedef {import("./frame-codec/JsonPathSegment.ts").JsonPathSegment} JsonPathSegment */
declare const FRAME_KEYFRAME_INTERVAL: 50;
type FrameDelta = FrameDelta$1;
type FrameDeltaOp = FrameDeltaOp$1;
type FrameEncoding = FrameEncoding$1;
type JsonPath = JsonPath$1;
type JsonPathSegment = JsonPathSegment$1;

/** @typedef {import("drizzle-orm").Table} Table */
/**
 * @param {Table} table
 * @param {unknown} payload
 * @returns {{ ok: boolean; data?: any; error?: z.ZodError; }}
 */
declare function validateInput(table: Table$2, payload: unknown): {
    ok: boolean;
    data?: any;
    error?: z.ZodError;
};
type Table$2 = drizzle_orm.Table;

declare const smithersRuns: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_runs";
    schema: undefined;
    columns: {
        runId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "run_id";
            tableName: "_smithers_runs";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        parentRunId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "parent_run_id";
            tableName: "_smithers_runs";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        workflowName: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "workflow_name";
            tableName: "_smithers_runs";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        workflowPath: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "workflow_path";
            tableName: "_smithers_runs";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        workflowHash: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "workflow_hash";
            tableName: "_smithers_runs";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        status: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "status";
            tableName: "_smithers_runs";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        createdAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "created_at_ms";
            tableName: "_smithers_runs";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        startedAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "started_at_ms";
            tableName: "_smithers_runs";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        finishedAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "finished_at_ms";
            tableName: "_smithers_runs";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        heartbeatAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "heartbeat_at_ms";
            tableName: "_smithers_runs";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        runtimeOwnerId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "runtime_owner_id";
            tableName: "_smithers_runs";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        cancelRequestedAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "cancel_requested_at_ms";
            tableName: "_smithers_runs";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        hijackRequestedAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "hijack_requested_at_ms";
            tableName: "_smithers_runs";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        hijackTarget: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "hijack_target";
            tableName: "_smithers_runs";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        vcsType: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "vcs_type";
            tableName: "_smithers_runs";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        vcsRoot: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "vcs_root";
            tableName: "_smithers_runs";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        vcsRevision: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "vcs_revision";
            tableName: "_smithers_runs";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        errorJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "error_json";
            tableName: "_smithers_runs";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        configJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "config_json";
            tableName: "_smithers_runs";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
    };
    dialect: "sqlite";
}>;
declare const smithersNodes: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_nodes";
    schema: undefined;
    columns: {
        runId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "run_id";
            tableName: "_smithers_nodes";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        nodeId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "node_id";
            tableName: "_smithers_nodes";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        iteration: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "iteration";
            tableName: "_smithers_nodes";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        state: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "state";
            tableName: "_smithers_nodes";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        lastAttempt: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "last_attempt";
            tableName: "_smithers_nodes";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        updatedAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "updated_at_ms";
            tableName: "_smithers_nodes";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        outputTable: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "output_table";
            tableName: "_smithers_nodes";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        label: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "label";
            tableName: "_smithers_nodes";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
    };
    dialect: "sqlite";
}>;
declare const smithersAttempts: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_attempts";
    schema: undefined;
    columns: {
        runId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "run_id";
            tableName: "_smithers_attempts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        nodeId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "node_id";
            tableName: "_smithers_attempts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        iteration: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "iteration";
            tableName: "_smithers_attempts";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        attempt: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "attempt";
            tableName: "_smithers_attempts";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        state: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "state";
            tableName: "_smithers_attempts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        startedAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "started_at_ms";
            tableName: "_smithers_attempts";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        finishedAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "finished_at_ms";
            tableName: "_smithers_attempts";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        heartbeatAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "heartbeat_at_ms";
            tableName: "_smithers_attempts";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        heartbeatDataJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "heartbeat_data_json";
            tableName: "_smithers_attempts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        errorJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "error_json";
            tableName: "_smithers_attempts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        jjPointer: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "jj_pointer";
            tableName: "_smithers_attempts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        cached: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "cached";
            tableName: "_smithers_attempts";
            dataType: "boolean";
            columnType: "SQLiteBoolean";
            data: boolean;
            driverParam: number;
            notNull: false;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        metaJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "meta_json";
            tableName: "_smithers_attempts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        responseText: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "response_text";
            tableName: "_smithers_attempts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        jjCwd: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "jj_cwd";
            tableName: "_smithers_attempts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
    };
    dialect: "sqlite";
}>;
declare const smithersFrames: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_frames";
    schema: undefined;
    columns: {
        runId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "run_id";
            tableName: "_smithers_frames";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        frameNo: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "frame_no";
            tableName: "_smithers_frames";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        createdAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "created_at_ms";
            tableName: "_smithers_frames";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        xmlJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "xml_json";
            tableName: "_smithers_frames";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        xmlHash: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "xml_hash";
            tableName: "_smithers_frames";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        encoding: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "encoding";
            tableName: "_smithers_frames";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        mountedTaskIdsJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "mounted_task_ids_json";
            tableName: "_smithers_frames";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        taskIndexJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "task_index_json";
            tableName: "_smithers_frames";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        note: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "note";
            tableName: "_smithers_frames";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
    };
    dialect: "sqlite";
}>;
declare const smithersApprovals: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_approvals";
    schema: undefined;
    columns: {
        runId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "run_id";
            tableName: "_smithers_approvals";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        nodeId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "node_id";
            tableName: "_smithers_approvals";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        iteration: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "iteration";
            tableName: "_smithers_approvals";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        status: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "status";
            tableName: "_smithers_approvals";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        requestedAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "requested_at_ms";
            tableName: "_smithers_approvals";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        decidedAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "decided_at_ms";
            tableName: "_smithers_approvals";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        note: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "note";
            tableName: "_smithers_approvals";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        decidedBy: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "decided_by";
            tableName: "_smithers_approvals";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        requestJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "request_json";
            tableName: "_smithers_approvals";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        decisionJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "decision_json";
            tableName: "_smithers_approvals";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        autoApproved: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "auto_approved";
            tableName: "_smithers_approvals";
            dataType: "boolean";
            columnType: "SQLiteBoolean";
            data: boolean;
            driverParam: number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "sqlite";
}>;
declare const smithersHumanRequests: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_human_requests";
    schema: undefined;
    columns: {
        requestId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "request_id";
            tableName: "_smithers_human_requests";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        runId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "run_id";
            tableName: "_smithers_human_requests";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        nodeId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "node_id";
            tableName: "_smithers_human_requests";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        iteration: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "iteration";
            tableName: "_smithers_human_requests";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        kind: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "kind";
            tableName: "_smithers_human_requests";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        status: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "status";
            tableName: "_smithers_human_requests";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        prompt: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "prompt";
            tableName: "_smithers_human_requests";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        schemaJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "schema_json";
            tableName: "_smithers_human_requests";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        optionsJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "options_json";
            tableName: "_smithers_human_requests";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        responseJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "response_json";
            tableName: "_smithers_human_requests";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        requestedAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "requested_at_ms";
            tableName: "_smithers_human_requests";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        answeredAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "answered_at_ms";
            tableName: "_smithers_human_requests";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        answeredBy: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "answered_by";
            tableName: "_smithers_human_requests";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        timeoutAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "timeout_at_ms";
            tableName: "_smithers_human_requests";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "sqlite";
}>;
declare const smithersAlerts: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_alerts";
    schema: undefined;
    columns: {
        alertId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "alert_id";
            tableName: "_smithers_alerts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        runId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "run_id";
            tableName: "_smithers_alerts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        policyName: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "policy_name";
            tableName: "_smithers_alerts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        severity: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "severity";
            tableName: "_smithers_alerts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        status: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "status";
            tableName: "_smithers_alerts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        firedAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "fired_at_ms";
            tableName: "_smithers_alerts";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        resolvedAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "resolved_at_ms";
            tableName: "_smithers_alerts";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        acknowledgedAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "acknowledged_at_ms";
            tableName: "_smithers_alerts";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        message: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "message";
            tableName: "_smithers_alerts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        detailsJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "details_json";
            tableName: "_smithers_alerts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        fingerprint: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "fingerprint";
            tableName: "_smithers_alerts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        nodeId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "node_id";
            tableName: "_smithers_alerts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        iteration: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "iteration";
            tableName: "_smithers_alerts";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        owner: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "owner";
            tableName: "_smithers_alerts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        runbook: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "runbook";
            tableName: "_smithers_alerts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        labelsJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "labels_json";
            tableName: "_smithers_alerts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        reactionJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "reaction_json";
            tableName: "_smithers_alerts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        sourceEventType: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "source_event_type";
            tableName: "_smithers_alerts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        firstFiredAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "first_fired_at_ms";
            tableName: "_smithers_alerts";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        lastFiredAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "last_fired_at_ms";
            tableName: "_smithers_alerts";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        occurrenceCount: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "occurrence_count";
            tableName: "_smithers_alerts";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        silencedUntilMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "silenced_until_ms";
            tableName: "_smithers_alerts";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        acknowledgedBy: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "acknowledged_by";
            tableName: "_smithers_alerts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        resolvedBy: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "resolved_by";
            tableName: "_smithers_alerts";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
    };
    dialect: "sqlite";
}>;
declare const smithersSignals: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_signals";
    schema: undefined;
    columns: {
        runId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "run_id";
            tableName: "_smithers_signals";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        seq: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "seq";
            tableName: "_smithers_signals";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        signalName: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "signal_name";
            tableName: "_smithers_signals";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        correlationId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "correlation_id";
            tableName: "_smithers_signals";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        payloadJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "payload_json";
            tableName: "_smithers_signals";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        receivedAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "received_at_ms";
            tableName: "_smithers_signals";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        receivedBy: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "received_by";
            tableName: "_smithers_signals";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
    };
    dialect: "sqlite";
}>;
declare const smithersCache: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_cache";
    schema: undefined;
    columns: {
        cacheKey: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "cache_key";
            tableName: "_smithers_cache";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        createdAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "created_at_ms";
            tableName: "_smithers_cache";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        workflowName: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "workflow_name";
            tableName: "_smithers_cache";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        nodeId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "node_id";
            tableName: "_smithers_cache";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        outputTable: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "output_table";
            tableName: "_smithers_cache";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        schemaSig: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "schema_sig";
            tableName: "_smithers_cache";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        agentSig: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "agent_sig";
            tableName: "_smithers_cache";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        toolsSig: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "tools_sig";
            tableName: "_smithers_cache";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        jjPointer: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "jj_pointer";
            tableName: "_smithers_cache";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        payloadJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "payload_json";
            tableName: "_smithers_cache";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
    };
    dialect: "sqlite";
}>;
declare const smithersNodeDiffs: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_node_diffs";
    schema: undefined;
    columns: {
        runId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "run_id";
            tableName: "_smithers_node_diffs";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        nodeId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "node_id";
            tableName: "_smithers_node_diffs";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        iteration: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "iteration";
            tableName: "_smithers_node_diffs";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        baseRef: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "base_ref";
            tableName: "_smithers_node_diffs";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        diffJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "diff_json";
            tableName: "_smithers_node_diffs";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        computedAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "computed_at_ms";
            tableName: "_smithers_node_diffs";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        sizeBytes: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "size_bytes";
            tableName: "_smithers_node_diffs";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "sqlite";
}>;
declare const smithersTimeTravelAudit: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_time_travel_audit";
    schema: undefined;
    columns: {
        id: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "id";
            tableName: "_smithers_time_travel_audit";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        runId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "run_id";
            tableName: "_smithers_time_travel_audit";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        fromFrameNo: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "from_frame_no";
            tableName: "_smithers_time_travel_audit";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        toFrameNo: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "to_frame_no";
            tableName: "_smithers_time_travel_audit";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        caller: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "caller";
            tableName: "_smithers_time_travel_audit";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        timestampMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "timestamp_ms";
            tableName: "_smithers_time_travel_audit";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        result: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "result";
            tableName: "_smithers_time_travel_audit";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        durationMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "duration_ms";
            tableName: "_smithers_time_travel_audit";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "sqlite";
}>;
declare const smithersSandboxes: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_sandboxes";
    schema: undefined;
    columns: {
        runId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "run_id";
            tableName: "_smithers_sandboxes";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        sandboxId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "sandbox_id";
            tableName: "_smithers_sandboxes";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        runtime: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "runtime";
            tableName: "_smithers_sandboxes";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        remoteRunId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "remote_run_id";
            tableName: "_smithers_sandboxes";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        workspaceId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "workspace_id";
            tableName: "_smithers_sandboxes";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        containerId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "container_id";
            tableName: "_smithers_sandboxes";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        configJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "config_json";
            tableName: "_smithers_sandboxes";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        status: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "status";
            tableName: "_smithers_sandboxes";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        shippedAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "shipped_at_ms";
            tableName: "_smithers_sandboxes";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        completedAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "completed_at_ms";
            tableName: "_smithers_sandboxes";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        bundlePath: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "bundle_path";
            tableName: "_smithers_sandboxes";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
    };
    dialect: "sqlite";
}>;
declare const smithersToolCalls: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_tool_calls";
    schema: undefined;
    columns: {
        runId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "run_id";
            tableName: "_smithers_tool_calls";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        nodeId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "node_id";
            tableName: "_smithers_tool_calls";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        iteration: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "iteration";
            tableName: "_smithers_tool_calls";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        attempt: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "attempt";
            tableName: "_smithers_tool_calls";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        seq: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "seq";
            tableName: "_smithers_tool_calls";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        toolName: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "tool_name";
            tableName: "_smithers_tool_calls";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        inputJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "input_json";
            tableName: "_smithers_tool_calls";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        outputJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "output_json";
            tableName: "_smithers_tool_calls";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        startedAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "started_at_ms";
            tableName: "_smithers_tool_calls";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        finishedAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "finished_at_ms";
            tableName: "_smithers_tool_calls";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        status: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "status";
            tableName: "_smithers_tool_calls";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        errorJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "error_json";
            tableName: "_smithers_tool_calls";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
    };
    dialect: "sqlite";
}>;
declare const smithersEvents: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_events";
    schema: undefined;
    columns: {
        runId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "run_id";
            tableName: "_smithers_events";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        seq: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "seq";
            tableName: "_smithers_events";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        timestampMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "timestamp_ms";
            tableName: "_smithers_events";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        type: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "type";
            tableName: "_smithers_events";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        payloadJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "payload_json";
            tableName: "_smithers_events";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
    };
    dialect: "sqlite";
}>;
declare const smithersRalph: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_ralph";
    schema: undefined;
    columns: {
        runId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "run_id";
            tableName: "_smithers_ralph";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        ralphId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "ralph_id";
            tableName: "_smithers_ralph";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        iteration: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "iteration";
            tableName: "_smithers_ralph";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        done: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "done";
            tableName: "_smithers_ralph";
            dataType: "boolean";
            columnType: "SQLiteBoolean";
            data: boolean;
            driverParam: number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        updatedAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "updated_at_ms";
            tableName: "_smithers_ralph";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "sqlite";
}>;

declare const smithersVectors: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_vectors";
    schema: undefined;
    columns: {
        id: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "id";
            tableName: "_smithers_vectors";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        namespace: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "namespace";
            tableName: "_smithers_vectors";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        content: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "content";
            tableName: "_smithers_vectors";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        embedding: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "embedding";
            tableName: "_smithers_vectors";
            dataType: "json";
            columnType: "SQLiteBlobJson";
            data: unknown;
            driverParam: Buffer<ArrayBufferLike>;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        dimensions: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "dimensions";
            tableName: "_smithers_vectors";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        metadataJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "metadata_json";
            tableName: "_smithers_vectors";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        documentId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "document_id";
            tableName: "_smithers_vectors";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        chunkIndex: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "chunk_index";
            tableName: "_smithers_vectors";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        createdAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "created_at_ms";
            tableName: "_smithers_vectors";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "sqlite";
}>;
declare const smithersCron: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_cron";
    schema: undefined;
    columns: {
        cronId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "cron_id";
            tableName: "_smithers_cron";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        pattern: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "pattern";
            tableName: "_smithers_cron";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        workflowPath: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "workflow_path";
            tableName: "_smithers_cron";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        enabled: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "enabled";
            tableName: "_smithers_cron";
            dataType: "boolean";
            columnType: "SQLiteBoolean";
            data: boolean;
            driverParam: number;
            notNull: false;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        createdAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "created_at_ms";
            tableName: "_smithers_cron";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        lastRunAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "last_run_at_ms";
            tableName: "_smithers_cron";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        nextRunAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "next_run_at_ms";
            tableName: "_smithers_cron";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        errorJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "error_json";
            tableName: "_smithers_cron";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
    };
    dialect: "sqlite";
}>;

/** @typedef {import("drizzle-orm").AnyColumn} AnyColumn */
/** @typedef {import("./output/OutputKey.ts").OutputKey} OutputKey */
/** @typedef {import("drizzle-orm").Table} Table */
/**
 * @param {Table} table
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @param {unknown} payload
 */
declare function buildOutputRow(table: Table$1, runId: string, nodeId: string, iteration: number, payload: unknown): {
    runId: string;
    nodeId: string;
    iteration: number;
    payload: {} | null;
} | {
    runId: string;
    nodeId: string;
    iteration: number;
    payload?: undefined;
};
/**
 * @param {unknown} payload
 */
declare function stripAutoColumns(payload: unknown): unknown;
/**
 * @param {Table} table
 * @returns {{ runId: AnyColumn; nodeId: AnyColumn; iteration?: AnyColumn; }}
 */
declare function getKeyColumns(table: Table$1): {
    runId: AnyColumn;
    nodeId: AnyColumn;
    iteration?: AnyColumn;
};
/**
 * @param {Table} table
 * @param {OutputKey} key
 */
declare function buildKeyWhere(table: Table$1, key: OutputKey): drizzle_orm.SQL<unknown> | undefined;
/**
 * @template T
 * @param {any} db
 * @param {Table} table
 * @param {OutputKey} key
 * @returns {Effect.Effect<T | undefined, SmithersError>}
 */
declare function selectOutputRowEffect<T>(db: any, table: Table$1, key: OutputKey): Effect.Effect<T | undefined, SmithersError$3>;
/**
 * @template T
 * @param {any} db
 * @param {Table} table
 * @param {OutputKey} key
 * @returns {Promise<T | undefined>}
 */
declare function selectOutputRow<T>(db: any, table: Table$1, key: OutputKey): Promise<T | undefined>;
/**
 * @param {any} db
 * @param {Table} table
 * @param {OutputKey} key
 * @param {Record<string, unknown>} payload
 * @returns {Effect.Effect<void, SmithersError>}
 */
declare function upsertOutputRowEffect(db: any, table: Table$1, key: OutputKey, payload: Record<string, unknown>): Effect.Effect<void, SmithersError$3>;
/**
 * @param {any} db
 * @param {Table} table
 * @param {OutputKey} key
 * @param {Record<string, unknown>} payload
 * @returns {Promise<void>}
 */
declare function upsertOutputRow(db: any, table: Table$1, key: OutputKey, payload: Record<string, unknown>): Promise<void>;
/**
 * @param {Table} table
 * @param {unknown} payload
 * @returns {{ ok: boolean; data?: any; error?: z.ZodError; }}
 */
declare function validateOutput(table: Table$1, payload: unknown): {
    ok: boolean;
    data?: any;
    error?: z.ZodError;
};
/**
 * @param {Table} table
 * @param {unknown} payload
 * @returns {{ ok: boolean; data?: any; error?: z.ZodError; }}
 */
declare function validateExistingOutput(table: Table$1, payload: unknown): {
    ok: boolean;
    data?: any;
    error?: z.ZodError;
};
/**
 * Creates a Zod schema for agent output by removing runId, nodeId, iteration
 * (which are auto-populated by smithers)
 */
declare function getAgentOutputSchema(table: any): z.ZodObject<{
    [x: string]: z.ZodUUID | z.ZodNumber | z.ZodTuple<[z.ZodNumber, z.ZodNumber], null> | z.ZodTuple<[z.ZodNumber, z.ZodNumber, z.ZodNumber], null> | z.ZodDate | z.ZodType<Buffer<ArrayBufferLike>, unknown, z.core.$ZodTypeInternals<Buffer<ArrayBufferLike>, unknown>> | z.ZodArray<z.ZodNumber | z.ZodString | z.ZodBoolean | z.ZodBigInt | z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>> | z.ZodType<any, any, z.core.$ZodTypeInternals<any, any>> | z.ZodObject<{
        [x: string]: z.ZodNumber | z.ZodString | z.ZodBoolean | z.ZodBigInt | z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    }, {
        out: {};
        in: {};
    }> | z.ZodString | z.ZodBoolean | z.ZodType<drizzle_zod.Json, unknown, z.core.$ZodTypeInternals<drizzle_zod.Json, unknown>> | z.ZodInt | z.ZodBigInt | z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>> | z.ZodOptional<z.ZodUUID | z.ZodNumber | z.ZodTuple<[z.ZodNumber, z.ZodNumber], null> | z.ZodTuple<[z.ZodNumber, z.ZodNumber, z.ZodNumber], null> | z.ZodDate | z.ZodType<Buffer<ArrayBufferLike>, unknown, z.core.$ZodTypeInternals<Buffer<ArrayBufferLike>, unknown>> | z.ZodArray<z.ZodNumber | z.ZodString | z.ZodBoolean | z.ZodBigInt | z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>> | z.ZodType<any, any, z.core.$ZodTypeInternals<any, any>> | z.ZodObject<{
        [x: string]: z.ZodNumber | z.ZodString | z.ZodBoolean | z.ZodBigInt | z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    }, {
        out: {};
        in: {};
    }> | z.ZodString | z.ZodBoolean | z.ZodType<drizzle_zod.Json, unknown, z.core.$ZodTypeInternals<drizzle_zod.Json, unknown>> | z.ZodInt | z.ZodBigInt | z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>> | z.ZodOptional<z.ZodNullable<z.ZodUUID | z.ZodNumber | z.ZodTuple<[z.ZodNumber, z.ZodNumber], null> | z.ZodTuple<[z.ZodNumber, z.ZodNumber, z.ZodNumber], null> | z.ZodDate | z.ZodType<Buffer<ArrayBufferLike>, unknown, z.core.$ZodTypeInternals<Buffer<ArrayBufferLike>, unknown>> | z.ZodArray<z.ZodNumber | z.ZodString | z.ZodBoolean | z.ZodBigInt | z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>> | z.ZodType<any, any, z.core.$ZodTypeInternals<any, any>> | z.ZodObject<{
        [x: string]: z.ZodNumber | z.ZodString | z.ZodBoolean | z.ZodBigInt | z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    }, {
        out: {};
        in: {};
    }> | z.ZodString | z.ZodBoolean | z.ZodType<drizzle_zod.Json, unknown, z.core.$ZodTypeInternals<drizzle_zod.Json, unknown>> | z.ZodInt | z.ZodBigInt | z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>>>;
}, z.core.$strip>;
/**
 * Describes a schema as a JSON Schema string for agent prompts.
 * Prefers the original Zod schema's `.toJSONSchema()` (Zod 4) which preserves
 * field descriptions. Falls back to deriving from the Drizzle table.
 */
declare function describeSchemaShape(tableOrSchema: any, zodSchema: any): string;
type AnyColumn = drizzle_orm.AnyColumn;
type OutputKey = OutputKey$2;
type Table$1 = drizzle_orm.Table;

/** @typedef {import("drizzle-orm").Table} Table */
/**
 * @param {Table} table
 * @returns {string}
 */
declare function schemaSignature(table: Table): string;
type Table = drizzle_orm.Table;

/**
 * @param {any} db
 * @param {any} inputTable
 * @param {string} runId
 * @returns {Effect.Effect<any, SmithersError>}
 */
declare function loadInputEffect(db: any, inputTable: any, runId: string): Effect.Effect<any, SmithersError$3>;
/**
 * @param {any} db
 * @param {any} inputTable
 * @param {string} runId
 * @returns {Promise<any>}
 */
declare function loadInput(db: any, inputTable: any, runId: string): Promise<any>;
/**
 * @param {any} db
 * @param {Record<string, any>} schema
 * @param {string} runId
 * @returns {Effect.Effect<OutputSnapshot, SmithersError>}
 */
declare function loadOutputsEffect(db: any, schema: Record<string, any>, runId: string): Effect.Effect<OutputSnapshot, SmithersError$3>;
/**
 * @param {any} db
 * @param {Record<string, any>} schema
 * @param {string} runId
 * @returns {Promise<OutputSnapshot>}
 */
declare function loadOutputs(db: any, schema: Record<string, any>, runId: string): Promise<OutputSnapshot>;
type OutputSnapshot = _smithers_driver_OutputSnapshot.OutputSnapshot;

type NodeDiffCacheRow$1 = {
    runId: string;
    nodeId: string;
    iteration: number;
    baseRef: string;
    diffJson: string;
    computedAtMs: number;
    sizeBytes: number;
};

declare class NodeDiffTooLargeError extends Error {
    constructor(sizeBytes: any);
    code: string;
    sizeBytes: any;
}
declare class NodeDiffCache {
    /**
   * @param {{ runId: string; nodeId: string; iteration: number; baseRef: string; }} key
   */
    static keyString(key: {
        runId: string;
        nodeId: string;
        iteration: number;
        baseRef: string;
    }): string;
    constructor(adapter: any, logger?: {});
    /** @type {SmithersDb} */
    adapter: SmithersDb;
    /** @type {{ warn?: (message: string, details?: Record<string, unknown>) => void }} */
    logger: {
        warn?: (message: string, details?: Record<string, unknown>) => void;
    };
    /**
   * @param {{ runId: string; nodeId: string; iteration: number; baseRef: string; }} key
   * @returns {Promise<{ bundle: any; sizeBytes: number; } | null>}
   */
    get(key: {
        runId: string;
        nodeId: string;
        iteration: number;
        baseRef: string;
    }): Promise<{
        bundle: any;
        sizeBytes: number;
    } | null>;
    /**
   * @param {{ runId: string; nodeId: string; iteration: number; baseRef: string; }} key
   * @param {() => Promise<any>} compute
   */
    getOrCompute(key: {
        runId: string;
        nodeId: string;
        iteration: number;
        baseRef: string;
    }, compute: () => Promise<any>): Promise<any>;
    /**
   * @param {string} runId
   * @param {number} targetFrameNo
   */
    invalidateAfterFrame(runId: string, targetFrameNo: number): RunnableEffect<number, unknown>;
    /**
   * @param {string} [runId]
   */
    countRows(runId?: string): RunnableEffect<number, unknown>;
}
type SmithersDb = SmithersDb$1;
type NodeDiffCacheRow = NodeDiffCacheRow$1;
/** @typedef {import("@smithers/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("../adapter/NodeDiffCacheRow.ts").NodeDiffCacheRow} NodeDiffCacheRow */
declare const NODE_DIFF_MAX_BYTES: number;

/**
 * Unwraps Zod wrapper types (nullable, optional, default) to get the base type.
 */
declare function unwrapZodType(t: any): any;

type SqliteWriteRetryOptions$2 = {
    label?: string;
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
};

/**
 * @param {unknown} error
 * @returns {boolean}
 */
declare function isRetryableSqliteWriteError(error: unknown): boolean;

/**
 * @template A
 * @param {() => Effect.Effect<A, SmithersError>} operation
 * @param {SqliteWriteRetryOptions} [opts]
 * @returns {Effect.Effect<A, SmithersError>}
 */
declare function withSqliteWriteRetryEffect<A>(operation: () => Effect.Effect<A, SmithersError>, opts?: SqliteWriteRetryOptions$1): Effect.Effect<A, SmithersError>;
type SmithersError = _smithers_errors_SmithersError.SmithersError;
type SqliteWriteRetryOptions$1 = SqliteWriteRetryOptions$2;

/**
 * @template A
 * @param {() => A | PromiseLike<A>} operation
 * @param {SqliteWriteRetryOptions} [opts]
 * @returns {Promise<A>}
 */
declare function withSqliteWriteRetry<A>(operation: () => A | PromiseLike<A>, opts?: SqliteWriteRetryOptions): Promise<A>;

type SqliteWriteRetryOptions = SqliteWriteRetryOptions$2;

/**
 * Generates a CREATE TABLE IF NOT EXISTS SQL statement from a Zod schema.
 * Used for runtime table creation without Drizzle migrations.
 */
declare function zodToCreateTableSQL(tableName: any, schema: any, opts: any): string;

/**
 * Generates a Drizzle sqliteTable from a Zod object schema.
 *
 * Each Zod field is mapped to a SQLite column:
 * - z.string() / z.enum() -> text column
 * - z.number() -> integer column
 * - z.boolean() -> integer column with boolean mode
 * - z.array() / z.object() / complex -> text column with json mode
 *
 * All tables include standard smithers key columns:
 * runId, nodeId, iteration with a composite primary key.
 */
declare function zodToTable(tableName: any, schema: any, opts: any): drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: any;
    schema: undefined;
    columns: {
        [x: string]: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: string;
            tableName: any;
            dataType: drizzle_orm.ColumnDataType;
            columnType: string;
            data: unknown;
            driverParam: unknown;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: string[] | undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "sqlite";
}>;

/**
 * Converts a camelCase string to snake_case.
 */
declare function camelToSnake(str: any): any;

type SchemaRegistryEntry = SchemaRegistryEntry$1;

export { type AlertRow, type AlertSeverity, type AlertStatus, type AnyColumn, type ApprovalRow, type AttemptRow, type CacheRow, DB_ALERT_ALLOWED_SEVERITIES, DB_ALERT_ALLOWED_STATUSES, DB_ALERT_ID_MAX_LENGTH, DB_ALERT_MESSAGE_MAX_LENGTH, DB_ALERT_POLICY_NAME_MAX_LENGTH, DB_RUN_ALLOWED_STATUSES, DB_RUN_ID_MAX_LENGTH, DB_RUN_WORKFLOW_NAME_MAX_LENGTH, type EventHistoryQuery, FRAME_KEYFRAME_INTERVAL, type FrameDelta, type FrameDeltaOp, type FrameEncoding, type HumanRequestRow, type JsonBounds, type JsonPath, type JsonPathSegment, NODE_DIFF_MAX_BYTES, NodeDiffCache, type NodeDiffCacheRow, NodeDiffTooLargeError, type NodeRow, type OutputSnapshot, type PendingHumanRequestRow, type RunAncestryRow, type RunRow, type RunnableEffect, type SchemaRegistryEntry, type SignalQuery, type SignalRow, SmithersDb$1 as SmithersDb, SqlMessageStorage, type SqlMessageStorageEventHistoryQuery, type SqliteParam, type SqliteWriteRetryOptions, type StaleRunRecord, applyFrameDelta, applyFrameDeltaJson, assertJsonPayloadWithinBounds, assertMaxBytes, assertMaxJsonDepth, assertMaxStringLength, assertOptionalArrayMaxLength, assertOptionalStringMaxLength, assertPositiveFiniteInteger, assertPositiveFiniteNumber, buildKeyWhere, buildOutputRow, camelToSnake, describeSchemaShape, encodeFrameDelta, ensureSmithersTables, ensureSmithersTablesEffect, ensureSqlMessageStorage, ensureSqlMessageStorageEffect, getAgentOutputSchema, getKeyColumns, getSqlMessageStorage, isRetryableSqliteWriteError, loadInput, loadInputEffect, loadOutputs, loadOutputsEffect, normalizeFrameEncoding, parseFrameDelta, schemaSignature, selectOutputRow, selectOutputRowEffect, serializeFrameDelta, smithersAlerts, smithersApprovals, smithersAttempts, smithersCache, smithersCron, smithersEvents, smithersFrames, smithersHumanRequests, smithersNodeDiffs, smithersNodes, smithersRalph, smithersRuns, smithersSandboxes, smithersSignals, smithersTimeTravelAudit, smithersToolCalls, smithersVectors, stripAutoColumns, unwrapZodType, upsertOutputRow, upsertOutputRowEffect, validateExistingOutput, validateInput, validateOutput, withSqliteWriteRetry, withSqliteWriteRetryEffect, zodToCreateTableSQL, zodToTable };
