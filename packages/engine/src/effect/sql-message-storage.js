import * as Reactivity from "@effect/experimental/Reactivity";
import * as SqlClient from "@effect/sql/SqlClient";
import { SqlError } from "@effect/sql/SqlError";
import * as Statement from "@effect/sql/Statement";
import { Database } from "bun:sqlite";
import { Context, Effect, Layer, ManagedRuntime, Scope } from "effect";
import { camelToSnake } from "@smithers/db/utils/camelToSnake";
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase} BunSQLiteDatabase */
/** @typedef {import("./SqlMessageStorageEventHistoryQuery.ts").SqlMessageStorageEventHistoryQuery} SqlMessageStorageEventHistoryQuery */
/**
 * @typedef {string | number | bigint | boolean | Uint8Array | null | undefined} SqliteParam
 */

const ATTR_DB_SYSTEM_NAME = "db.system.name";
const CREATE_TABLE_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS _smithers_runs (
    run_id TEXT PRIMARY KEY,
    parent_run_id TEXT,
    workflow_name TEXT NOT NULL,
    workflow_path TEXT,
    workflow_hash TEXT,
    status TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER,
    finished_at_ms INTEGER,
    heartbeat_at_ms INTEGER,
    runtime_owner_id TEXT,
    cancel_requested_at_ms INTEGER,
    hijack_requested_at_ms INTEGER,
    hijack_target TEXT,
    vcs_type TEXT,
    vcs_root TEXT,
    vcs_revision TEXT,
    error_json TEXT,
    config_json TEXT
  )`,
    `CREATE INDEX IF NOT EXISTS _smithers_runs_status_heartbeat_idx
    ON _smithers_runs (status, heartbeat_at_ms)`,
    `CREATE TABLE IF NOT EXISTS _smithers_nodes (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL,
    last_attempt INTEGER,
    updated_at_ms INTEGER NOT NULL,
    output_table TEXT NOT NULL,
    label TEXT,
    PRIMARY KEY (run_id, node_id, iteration)
  )`,
    `CREATE TABLE IF NOT EXISTS _smithers_attempts (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL,
    state TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    finished_at_ms INTEGER,
    heartbeat_at_ms INTEGER,
    heartbeat_data_json TEXT,
    error_json TEXT,
    jj_pointer TEXT,
    response_text TEXT,
    jj_cwd TEXT,
    cached INTEGER DEFAULT 0,
    meta_json TEXT,
    PRIMARY KEY (run_id, node_id, iteration, attempt)
  )`,
    `CREATE TABLE IF NOT EXISTS _smithers_frames (
    run_id TEXT NOT NULL,
    frame_no INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    xml_json TEXT NOT NULL,
    xml_hash TEXT NOT NULL,
    encoding TEXT NOT NULL DEFAULT 'full',
    mounted_task_ids_json TEXT,
    task_index_json TEXT,
    note TEXT,
    PRIMARY KEY (run_id, frame_no)
  )`,
    `CREATE TABLE IF NOT EXISTS _smithers_approvals (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    requested_at_ms INTEGER,
    decided_at_ms INTEGER,
    note TEXT,
    decided_by TEXT,
    request_json TEXT,
    decision_json TEXT,
    auto_approved INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (run_id, node_id, iteration)
  )`,
    `CREATE TABLE IF NOT EXISTS _smithers_human_requests (
    request_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schema_json TEXT,
    options_json TEXT,
    response_json TEXT,
    requested_at_ms INTEGER NOT NULL,
    answered_at_ms INTEGER,
    answered_by TEXT,
    timeout_at_ms INTEGER
  )`,
    `CREATE TABLE IF NOT EXISTS _smithers_alerts (
    alert_id TEXT PRIMARY KEY,
    run_id TEXT,
    policy_name TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL,
    fired_at_ms INTEGER NOT NULL,
    resolved_at_ms INTEGER,
    acknowledged_at_ms INTEGER,
    message TEXT NOT NULL,
    details_json TEXT,
    fingerprint TEXT,
    node_id TEXT,
    iteration INTEGER,
    owner TEXT,
    runbook TEXT,
    labels_json TEXT,
    reaction_json TEXT,
    source_event_type TEXT,
    first_fired_at_ms INTEGER,
    last_fired_at_ms INTEGER,
    occurrence_count INTEGER DEFAULT 1,
    silenced_until_ms INTEGER,
    acknowledged_by TEXT,
    resolved_by TEXT
  )`,
    `CREATE TABLE IF NOT EXISTS _smithers_signals (
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    signal_name TEXT NOT NULL,
    correlation_id TEXT,
    payload_json TEXT NOT NULL,
    received_at_ms INTEGER NOT NULL,
    received_by TEXT,
    PRIMARY KEY (run_id, seq)
  )`,
    `CREATE INDEX IF NOT EXISTS _smithers_signals_lookup_idx
    ON _smithers_signals (run_id, signal_name, correlation_id, received_at_ms)`,
    `CREATE TABLE IF NOT EXISTS _smithers_cache (
    cache_key TEXT PRIMARY KEY,
    created_at_ms INTEGER NOT NULL,
    workflow_name TEXT NOT NULL,
    node_id TEXT NOT NULL,
    output_table TEXT NOT NULL,
    schema_sig TEXT NOT NULL,
    agent_sig TEXT,
    tools_sig TEXT,
    jj_pointer TEXT,
    payload_json TEXT NOT NULL
  )`,
    `CREATE TABLE IF NOT EXISTS _smithers_sandboxes (
    run_id TEXT NOT NULL,
    sandbox_id TEXT NOT NULL,
    runtime TEXT NOT NULL DEFAULT 'bubblewrap',
    remote_run_id TEXT,
    workspace_id TEXT,
    container_id TEXT,
    config_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    shipped_at_ms INTEGER,
    completed_at_ms INTEGER,
    bundle_path TEXT,
    PRIMARY KEY (run_id, sandbox_id)
  )`,
    `CREATE TABLE IF NOT EXISTS _smithers_tool_calls (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    tool_name TEXT NOT NULL,
    input_json TEXT,
    output_json TEXT,
    started_at_ms INTEGER NOT NULL,
    finished_at_ms INTEGER,
    status TEXT NOT NULL,
    error_json TEXT,
    PRIMARY KEY (run_id, node_id, iteration, attempt, seq)
  )`,
    `CREATE TABLE IF NOT EXISTS _smithers_events (
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    timestamp_ms INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (run_id, seq)
  )`,
    `CREATE TABLE IF NOT EXISTS _smithers_ralph (
    run_id TEXT NOT NULL,
    ralph_id TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (run_id, ralph_id)
  )`,
    `CREATE TABLE IF NOT EXISTS _smithers_cron (
    cron_id TEXT PRIMARY KEY,
    pattern TEXT NOT NULL,
    workflow_path TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    created_at_ms INTEGER NOT NULL,
    last_run_at_ms INTEGER,
    next_run_at_ms INTEGER,
    error_json TEXT
  )`,
    `CREATE TABLE IF NOT EXISTS _smithers_snapshots (
    run_id TEXT NOT NULL,
    frame_no INTEGER NOT NULL,
    nodes_json TEXT NOT NULL,
    outputs_json TEXT NOT NULL,
    ralph_json TEXT NOT NULL,
    input_json TEXT NOT NULL,
    vcs_pointer TEXT,
    workflow_hash TEXT,
    content_hash TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (run_id, frame_no)
  )`,
    `CREATE TABLE IF NOT EXISTS _smithers_branches (
    run_id TEXT PRIMARY KEY,
    parent_run_id TEXT NOT NULL,
    parent_frame_no INTEGER NOT NULL,
    branch_label TEXT,
    fork_description TEXT,
    created_at_ms INTEGER NOT NULL
  )`,
    `CREATE TABLE IF NOT EXISTS _smithers_vcs_tags (
    run_id TEXT NOT NULL,
    frame_no INTEGER NOT NULL,
    vcs_type TEXT NOT NULL,
    vcs_pointer TEXT NOT NULL,
    vcs_root TEXT,
    jj_operation_id TEXT,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (run_id, frame_no)
  )`,
    `CREATE TABLE IF NOT EXISTS _smithers_vectors (
    id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding BLOB NOT NULL,
    dimensions INTEGER NOT NULL,
    metadata_json TEXT,
    document_id TEXT,
    chunk_index INTEGER,
    created_at_ms INTEGER NOT NULL
  )`,
    `CREATE TABLE IF NOT EXISTS _smithers_scorers (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL DEFAULT 0,
    scorer_id TEXT NOT NULL,
    scorer_name TEXT NOT NULL,
    source TEXT NOT NULL,
    score REAL NOT NULL,
    reason TEXT,
    meta_json TEXT,
    input_json TEXT,
    output_json TEXT,
    latency_ms REAL,
    scored_at_ms INTEGER NOT NULL,
    duration_ms REAL
  )`,
    `CREATE TABLE IF NOT EXISTS _smithers_memory_facts (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    schema_sig TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    ttl_ms INTEGER,
    PRIMARY KEY (namespace, key)
  )`,
    `CREATE TABLE IF NOT EXISTS _smithers_memory_threads (
    thread_id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    title TEXT,
    metadata_json TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,
    `CREATE TABLE IF NOT EXISTS _smithers_memory_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content_json TEXT NOT NULL,
    run_id TEXT,
    node_id TEXT,
    created_at_ms INTEGER NOT NULL
  )`,
];
const MIGRATION_STATEMENTS = [
    `ALTER TABLE _smithers_attempts ADD COLUMN response_text TEXT`,
    `ALTER TABLE _smithers_attempts ADD COLUMN jj_cwd TEXT`,
    `ALTER TABLE _smithers_attempts ADD COLUMN heartbeat_at_ms INTEGER`,
    `ALTER TABLE _smithers_attempts ADD COLUMN heartbeat_data_json TEXT`,
    `ALTER TABLE _smithers_attempts ADD COLUMN cached INTEGER DEFAULT 0`,
    `ALTER TABLE _smithers_attempts ADD COLUMN meta_json TEXT`,
    `ALTER TABLE _smithers_runs ADD COLUMN workflow_hash TEXT`,
    `ALTER TABLE _smithers_runs ADD COLUMN heartbeat_at_ms INTEGER`,
    `ALTER TABLE _smithers_runs ADD COLUMN runtime_owner_id TEXT`,
    `ALTER TABLE _smithers_runs ADD COLUMN cancel_requested_at_ms INTEGER`,
    `ALTER TABLE _smithers_runs ADD COLUMN hijack_requested_at_ms INTEGER`,
    `ALTER TABLE _smithers_runs ADD COLUMN hijack_target TEXT`,
    `ALTER TABLE _smithers_runs ADD COLUMN vcs_type TEXT`,
    `ALTER TABLE _smithers_runs ADD COLUMN vcs_root TEXT`,
    `ALTER TABLE _smithers_runs ADD COLUMN vcs_revision TEXT`,
    `ALTER TABLE _smithers_runs ADD COLUMN parent_run_id TEXT`,
    `ALTER TABLE _smithers_runs ADD COLUMN error_json TEXT`,
    `ALTER TABLE _smithers_runs ADD COLUMN config_json TEXT`,
    `ALTER TABLE _smithers_approvals ADD COLUMN request_json TEXT`,
    `ALTER TABLE _smithers_approvals ADD COLUMN decision_json TEXT`,
    `ALTER TABLE _smithers_approvals ADD COLUMN auto_approved INTEGER NOT NULL DEFAULT 0`,
    `CREATE INDEX IF NOT EXISTS _smithers_runs_parent_idx ON _smithers_runs (parent_run_id)`,
    // Ticket 0001: Alert model extensions
    `ALTER TABLE _smithers_alerts ADD COLUMN fingerprint TEXT`,
    `ALTER TABLE _smithers_alerts ADD COLUMN node_id TEXT`,
    `ALTER TABLE _smithers_alerts ADD COLUMN iteration INTEGER`,
    `ALTER TABLE _smithers_alerts ADD COLUMN owner TEXT`,
    `ALTER TABLE _smithers_alerts ADD COLUMN runbook TEXT`,
    `ALTER TABLE _smithers_alerts ADD COLUMN labels_json TEXT`,
    `ALTER TABLE _smithers_alerts ADD COLUMN reaction_json TEXT`,
    `ALTER TABLE _smithers_alerts ADD COLUMN source_event_type TEXT`,
    `ALTER TABLE _smithers_alerts ADD COLUMN first_fired_at_ms INTEGER`,
    `ALTER TABLE _smithers_alerts ADD COLUMN last_fired_at_ms INTEGER`,
    `ALTER TABLE _smithers_alerts ADD COLUMN occurrence_count INTEGER DEFAULT 1`,
    `ALTER TABLE _smithers_alerts ADD COLUMN silenced_until_ms INTEGER`,
    `ALTER TABLE _smithers_alerts ADD COLUMN acknowledged_by TEXT`,
    `ALTER TABLE _smithers_alerts ADD COLUMN resolved_by TEXT`,
    `CREATE INDEX IF NOT EXISTS _smithers_alerts_fingerprint_idx ON _smithers_alerts (fingerprint)`,
    `CREATE INDEX IF NOT EXISTS _smithers_alerts_run_status_idx ON _smithers_alerts (run_id, status)`,
];
/**
 * @param {string} identifier
 * @returns {string}
 */
function quoteIdentifier(identifier) {
    return `"${identifier.replace(/"/g, "\"\"")}"`;
}
/**
 * @param {string} value
 * @returns {string}
 */
function snakeToCamel(value) {
    return value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}
/**
 * @param {SqliteParam} value
 * @returns {Exclude<SqliteParam, undefined>}
 */
function encodeParam(value) {
    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }
    return value ?? null;
}
/**
 * @template T
 * @param {ReadonlyArray<T>} rows
 * @returns {ReadonlyArray<T>}
 */
function transformRowKeys(rows) {
    return rows.map((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) {
            return row;
        }
        const next = {};
        for (const [key, value] of Object.entries(row)) {
            next[snakeToCamel(key)] = value;
        }
        return next;
    });
}
/**
 * @template T
 * @param {T} row
 * @param {readonly string[]} [booleanColumns]
 * @returns {T}
 */
function applyBooleanColumns(row, booleanColumns) {
    if (!booleanColumns || booleanColumns.length === 0) {
        return row;
    }
    const next = { ...row };
    for (const column of booleanColumns) {
        const current = next[column];
        if (current !== null && current !== undefined) {
            next[column] = Boolean(current);
        }
    }
    return next;
}
/**
 * @param {string} table
 * @param {Record<string, unknown>} row
 * @param {{ orIgnore?: boolean; conflictColumns?: readonly string[]; updateColumns?: readonly string[]; }} [options]
 */
function buildInsertSql(table, row, options) {
    const entries = Object.entries(row).filter(([, value]) => value !== undefined);
    const columns = entries.map(([key]) => camelToSnake(key));
    const params = entries.map(([, value]) => encodeParam(value));
    const tableSql = quoteIdentifier(table);
    const columnSql = columns.map(quoteIdentifier).join(", ");
    const placeholderSql = columns.map(() => "?").join(", ");
    let statement = `INSERT${options?.orIgnore ? " OR IGNORE" : ""} INTO ${tableSql} (${columnSql}) ` +
        `VALUES (${placeholderSql})`;
    if (options?.conflictColumns && options.conflictColumns.length > 0) {
        const conflictSql = options.conflictColumns.map(camelToSnake).map(quoteIdentifier).join(", ");
        const updateColumns = (options.updateColumns ?? Object.keys(row))
            .map(camelToSnake)
            .filter((column) => !options.conflictColumns.includes(snakeToCamel(column)));
        if (updateColumns.length === 0) {
            statement += ` ON CONFLICT (${conflictSql}) DO NOTHING`;
        }
        else {
            const updateSql = updateColumns
                .map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`)
                .join(", ");
            statement += ` ON CONFLICT (${conflictSql}) DO UPDATE SET ${updateSql}`;
        }
    }
    return { statement, params };
}
/**
 * @param {string} table
 * @param {Record<string, unknown>} patch
 * @param {string} whereSql
 * @param {ReadonlyArray<SqliteParam>} [params]
 */
function buildUpdateSql(table, patch, whereSql, params = []) {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (entries.length === 0) {
        return null;
    }
    const setSql = entries
        .map(([key]) => `${quoteIdentifier(camelToSnake(key))} = ?`)
        .join(", ");
    return {
        statement: `UPDATE ${quoteIdentifier(table)} SET ${setSql} WHERE ${whereSql}`,
        params: [
            ...entries.map(([, value]) => encodeParam(value)),
            ...params.map(encodeParam),
        ],
    };
}
/**
 * @param {BunSQLiteDatabase<any> | Database} db
 * @returns {Database}
 */
function resolveSqliteDatabase(db) {
    if (db instanceof Database) {
        return db;
    }
    const candidate = db.session?.client ?? db.$client;
    if (!candidate || typeof candidate.query !== "function" || typeof candidate.run !== "function") {
        throw new TypeError("SqlMessageStorage requires a Bun SQLite client.");
    }
    return candidate;
}
/**
 * @param {Database} sqlite
 * @returns {Connection}
 */
function createConnection(sqlite) {
    /**
   * @param {string} statement
   * @param {ReadonlyArray<unknown>} params
   * @param {(<A extends object>(rows: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined} [transformRows]
   */
    const execute = (statement, params, transformRows) => Effect.withFiberRuntime((fiber) => {
        const useSafeIntegers = Context.get(fiber.currentContext, SqlClient.SafeIntegers);
        try {
            const query = sqlite.query(statement);
            // @ts-ignore bun-types missing safeIntegers()
            query.safeIntegers(useSafeIntegers);
            const rows = (query.all(...params) ?? []);
            return Effect.succeed(transformRows ? transformRows(rows) : rows);
        }
        catch (cause) {
            return Effect.fail(new SqlError({ cause, message: "Failed to execute SQLite statement" }));
        }
    });
    return {
        execute: (statement, params, transformRows) => execute(statement, params, transformRows),
        executeRaw: (statement, params) => execute(statement, params, undefined),
        executeValues: (statement, params) => Effect.withFiberRuntime((fiber) => {
            const useSafeIntegers = Context.get(fiber.currentContext, SqlClient.SafeIntegers);
            try {
                const query = sqlite.query(statement);
                // @ts-ignore bun-types missing safeIntegers()
                query.safeIntegers(useSafeIntegers);
                return Effect.succeed((query.values(...params) ?? []));
            }
            catch (cause) {
                return Effect.fail(new SqlError({ cause, message: "Failed to execute SQLite values statement" }));
            }
        }),
        executeUnprepared: (statement, params, transformRows) => execute(statement, params, transformRows),
        executeStream: () => Effect.dieMessage("executeStream not implemented"),
    };
}
/**
 * @param {Database} sqlite
 * @returns {Effect.Effect<SqlClient.SqlClient, never>}
 */
function makeSqlClientEffect(sqlite) {
    const compiler = Statement.makeCompilerSqlite(camelToSnake);
    const connection = createConnection(sqlite);
    return Effect.gen(function* () {
        const semaphore = yield* Effect.makeSemaphore(1);
        const acquirer = semaphore.withPermits(1)(Effect.succeed(connection));
        const transactionAcquirer = Effect.uninterruptibleMask((restore) => Effect.as(Effect.zipRight(restore(semaphore.take(1)), Effect.tap(Effect.scope, (scope) => Scope.addFinalizer(scope, semaphore.release(1)))), connection));
        const reactivity = yield* Reactivity.make;
        return yield* SqlClient.make({
            acquirer,
            compiler,
            transactionAcquirer,
            spanAttributes: [[ATTR_DB_SYSTEM_NAME, "sqlite"]],
            transformRows: transformRowKeys,
        }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity));
    });
}
/**
 * @param {Database} sqlite
 */
function makeSqlClientLayer(sqlite) {
    return Layer.scoped(SqlClient.SqlClient, makeSqlClientEffect(sqlite));
}
export class SqlMessageStorage {
    sqlite;
    // TODO(Phase 8): Keep this per-DB runtime until the unified runtime can
    // inject a scoped SqlClient without rebuilding the per-connection semaphore.
    runtime;
    tableColumnsCache = new Map();
    /**
   * @param {BunSQLiteDatabase<any> | Database} db
   */
    constructor(db) {
        this.sqlite = resolveSqliteDatabase(db);
        this.runtime = ManagedRuntime.make(makeSqlClientLayer(this.sqlite));
    }
    /**
   * @param {string} table
   * @returns {Set<string>}
   */
    getTableColumns(table) {
        const cached = this.tableColumnsCache.get(table);
        if (cached) {
            return cached;
        }
        const rows = this.sqlite
            .query(`PRAGMA table_info(${quoteIdentifier(table)})`)
            .all();
        const columns = new Set(rows
            .map((row) => (typeof row.name === "string" ? snakeToCamel(row.name) : ""))
            .filter((value) => value.length > 0));
        this.tableColumnsCache.set(table, columns);
        return columns;
    }
    /**
   * @param {string} table
   * @param {Record<string, unknown>} row
   * @returns {Record<string, unknown>}
   */
    filterKnownColumns(table, row) {
        const knownColumns = this.getTableColumns(table);
        return Object.fromEntries(Object.entries(row).filter(([key, value]) => value !== undefined && knownColumns.has(key)));
    }
    /**
   * @template A, E
   * @param {Effect.Effect<A, E, SqlClient.SqlClient>} effect
   * @returns {Promise<A>}
   */
    runEffect(effect) {
        return this.runtime.runPromise(effect);
    }
    /**
   * @template A
   * @param {(connection: Connection) => Effect.Effect<A, SqlError>} f
   * @returns {Promise<A>}
   */
    withConnection(f) {
        return this.runEffect(Effect.flatMap(SqlClient.SqlClient, (client) => Effect.scoped(Effect.flatMap(client.reserve, f))));
    }
    /**
   * @returns {Effect.Effect<void, never>}
   */
    ensureSchemaEffect() {
        const sqlite = this.sqlite;
        return Effect.sync(() => {
            for (const statement of CREATE_TABLE_STATEMENTS) {
                sqlite.run(statement);
            }
            for (const statement of MIGRATION_STATEMENTS) {
                try {
                    sqlite.run(statement);
                }
                catch {
                    // Ignore legacy migration failures for already-applied changes.
                }
            }
            const frameColumns = sqlite
                .query(`PRAGMA table_info("_smithers_frames")`)
                .all();
            if (!frameColumns.some((column) => column.name === "encoding")) {
                try {
                    sqlite.run(`ALTER TABLE _smithers_frames ADD COLUMN encoding TEXT NOT NULL DEFAULT 'full'`);
                }
                catch {
                    // Ignore if another caller added it first.
                }
            }
        });
    }
    /**
   * @returns {Promise<void>}
   */
    ensureSchema() {
        return this.runtime.runPromise(this.ensureSchemaEffect());
    }
    /**
   * @template T
   * @param {string} statement
   * @param {ReadonlyArray<SqliteParam>} [params]
   * @param {{ booleanColumns?: readonly string[] }} [options]
   * @returns {Promise<Array<T>>}
   */
    queryAll(statement, params = [], options) {
        return this.withConnection((connection) => connection
            .execute(statement, params.map(encodeParam), transformRowKeys)
            .pipe(Effect.map((rows) => rows.map((row) => applyBooleanColumns(row, options?.booleanColumns)))));
    }
    /**
   * @template T
   * @param {string} statement
   * @param {ReadonlyArray<SqliteParam>} [params]
   * @param {{ booleanColumns?: readonly string[] }} [options]
   * @returns {Promise<T | undefined>}
   */
    async queryOne(statement, params = [], options) {
        const rows = await this.queryAll(statement, params, options);
        return rows[0];
    }
    /**
   * @param {string} statement
   * @param {ReadonlyArray<SqliteParam>} [params]
   * @returns {Promise<void>}
   */
    execute(statement, params = []) {
        return this.withConnection((connection) => connection.executeRaw(statement, params.map(encodeParam)).pipe(Effect.asVoid));
    }
    /**
   * @param {string} table
   * @param {Record<string, unknown>} row
   * @returns {Promise<void>}
   */
    insertIgnore(table, row) {
        const filteredRow = this.filterKnownColumns(table, row);
        const { statement, params } = buildInsertSql(table, filteredRow, { orIgnore: true });
        return this.execute(statement, params);
    }
    /**
   * @param {string} table
   * @param {Record<string, unknown>} row
   * @param {readonly string[]} conflictColumns
   * @param {readonly string[]} [updateColumns]
   * @returns {Promise<void>}
   */
    upsert(table, row, conflictColumns, updateColumns) {
        const filteredRow = this.filterKnownColumns(table, row);
        const { statement, params } = buildInsertSql(table, filteredRow, {
            conflictColumns,
            updateColumns,
        });
        return this.execute(statement, params);
    }
    /**
   * @param {string} table
   * @param {Record<string, unknown>} patch
   * @param {string} whereSql
   * @param {ReadonlyArray<SqliteParam>} [params]
   * @returns {Promise<void>}
   */
    updateWhere(table, patch, whereSql, params = []) {
        const built = buildUpdateSql(table, this.filterKnownColumns(table, patch), whereSql, params);
        if (!built) {
            return Promise.resolve();
        }
        return this.execute(built.statement, built.params);
    }
    /**
   * @param {string} table
   * @param {string} whereSql
   * @param {ReadonlyArray<SqliteParam>} [params]
   * @returns {Promise<void>}
   */
    deleteWhere(table, whereSql, params = []) {
        return this.execute(`DELETE FROM ${quoteIdentifier(table)} WHERE ${whereSql}`, params);
    }
    /**
   * @param {string} runId
   * @param {SqlMessageStorageEventHistoryQuery} [query]
   * @returns {{ whereSql: string; params: Array<SqliteParam> }}
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
   * @param {SqlMessageStorageEventHistoryQuery} [query]
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
    listEventHistory(runId, query = {}) {
        const limit = Math.max(1, Math.floor(query.limit ?? 200));
        const { whereSql, params } = this.buildEventHistoryWhere(runId, query);
        return this.queryAll(`SELECT * FROM _smithers_events
       WHERE ${whereSql}
       ORDER BY seq ASC
       LIMIT ?`, [...params, limit]);
    }
    /**
   * @param {string} runId
   * @param {SqlMessageStorageEventHistoryQuery} [query]
   * @returns {Promise<number>}
   */
    async countEventHistory(runId, query = {}) {
        const { whereSql, params } = this.buildEventHistoryWhere(runId, query);
        const row = await this.queryOne(`SELECT COUNT(*) AS count
       FROM _smithers_events
       WHERE ${whereSql}`, params);
        return Number(row?.count ?? 0);
    }
    /**
   * @param {string} runId
   * @returns {Promise<number | undefined>}
   */
    async getLastEventSeq(runId) {
        const row = await this.queryOne(`SELECT seq
       FROM _smithers_events
       WHERE run_id = ?
       ORDER BY seq DESC
       LIMIT 1`, [runId]);
        return row?.seq;
    }
    /**
   * @param {string} runId
   * @param {string} type
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
    listEventsByType(runId, type) {
        return this.queryAll(`SELECT *
       FROM _smithers_events
       WHERE run_id = ? AND type = ?
       ORDER BY seq ASC`, [runId, type]);
    }
    /**
   * @param {string} runId
   * @returns {Promise<number | undefined>}
   */
    async getLastSignalSeq(runId) {
        const row = await this.queryOne(`SELECT seq
       FROM _smithers_signals
       WHERE run_id = ?
       ORDER BY seq DESC
       LIMIT 1`, [runId]);
        return row?.seq;
    }
}
/**
 * @param {BunSQLiteDatabase<any> | Database} db
 * @returns {SqlMessageStorage}
 */
export function getSqlMessageStorage(db) {
    return new SqlMessageStorage(db);
}
/**
 * @param {BunSQLiteDatabase<any> | Database} db
 * @returns {Effect.Effect<void, never>}
 */
export function ensureSqlMessageStorageEffect(db) {
    return getSqlMessageStorage(db).ensureSchemaEffect();
}
/**
 * @param {BunSQLiteDatabase<any> | Database} db
 * @returns {Promise<void>}
 */
export function ensureSqlMessageStorage(db) {
    return getSqlMessageStorage(db).ensureSchema();
}
