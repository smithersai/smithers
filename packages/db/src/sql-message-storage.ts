import * as Reactivity from "@effect/experimental/Reactivity";
import * as SqlClient from "@effect/sql/SqlClient";
import type { Connection } from "@effect/sql/SqlConnection";
import { SqlError } from "@effect/sql/SqlError";
import * as Statement from "@effect/sql/Statement";
import { Database } from "bun:sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Context, Effect, Layer, ManagedRuntime, Scope } from "effect";
import { camelToSnake } from "./utils/camelToSnake";

type SqliteParam =
  | string
  | number
  | bigint
  | boolean
  | Uint8Array
  | null
  | undefined;

export type SqlMessageStorageEventHistoryQuery = {
  afterSeq?: number;
  limit?: number;
  nodeId?: string;
  types?: readonly string[];
  sinceTimestampMs?: number;
};

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
] as const;

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
] as const;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function encodeParam(value: SqliteParam): Exclude<SqliteParam, undefined> {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return value ?? null;
}

function transformRowKeys<T extends object>(rows: ReadonlyArray<T>): ReadonlyArray<T> {
  return rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return row;
    }
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      next[snakeToCamel(key)] = value;
    }
    return next as T;
  });
}

function applyBooleanColumns<T extends Record<string, unknown>>(
  row: T,
  booleanColumns?: readonly string[],
): T {
  if (!booleanColumns || booleanColumns.length === 0) {
    return row;
  }
  const next: Record<string, unknown> = { ...row };
  for (const column of booleanColumns) {
    const current = next[column];
    if (current !== null && current !== undefined) {
      next[column] = Boolean(current);
    }
  }
  return next as T;
}

function buildInsertSql(
  table: string,
  row: Record<string, unknown>,
  options?: {
    orIgnore?: boolean;
    conflictColumns?: readonly string[];
    updateColumns?: readonly string[];
  },
) {
  const entries = Object.entries(row).filter(([, value]) => value !== undefined);
  const columns = entries.map(([key]) => camelToSnake(key));
  const params = entries.map(([, value]) => encodeParam(value as SqliteParam));
  const tableSql = quoteIdentifier(table);
  const columnSql = columns.map(quoteIdentifier).join(", ");
  const placeholderSql = columns.map(() => "?").join(", ");
  let statement =
    `INSERT${options?.orIgnore ? " OR IGNORE" : ""} INTO ${tableSql} (${columnSql}) ` +
    `VALUES (${placeholderSql})`;

  if (options?.conflictColumns && options.conflictColumns.length > 0) {
    const conflictSql = options.conflictColumns.map(camelToSnake).map(quoteIdentifier).join(", ");
    const updateColumns = (options.updateColumns ?? Object.keys(row))
      .map(camelToSnake)
      .filter((column) => !options.conflictColumns!.includes(snakeToCamel(column)));
    if (updateColumns.length === 0) {
      statement += ` ON CONFLICT (${conflictSql}) DO NOTHING`;
    } else {
      const updateSql = updateColumns
        .map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`)
        .join(", ");
      statement += ` ON CONFLICT (${conflictSql}) DO UPDATE SET ${updateSql}`;
    }
  }

  return { statement, params };
}

function buildUpdateSql(
  table: string,
  patch: Record<string, unknown>,
  whereSql: string,
  params: ReadonlyArray<SqliteParam> = [],
) {
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
      ...entries.map(([, value]) => encodeParam(value as SqliteParam)),
      ...params.map(encodeParam),
    ],
  };
}

function resolveSqliteDatabase(
  db: BunSQLiteDatabase<any> | Database,
): Database {
  if (db instanceof Database) {
    return db;
  }
  const candidate = (db as any).session?.client ?? (db as any).$client;
  if (!candidate || typeof candidate.query !== "function" || typeof candidate.run !== "function") {
    throw new TypeError("SqlMessageStorage requires a Bun SQLite client.");
  }
  return candidate as Database;
}

function createConnection(
  sqlite: Database,
): Connection {
  const execute = (
    statement: string,
    params: ReadonlyArray<unknown>,
    transformRows?: (<A extends object>(rows: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined,
  ) =>
    Effect.withFiberRuntime<ReadonlyArray<any>, SqlError>((fiber) => {
      const useSafeIntegers = Context.get(fiber.currentContext, SqlClient.SafeIntegers);
      try {
        const query = sqlite.query(statement);
        // @ts-ignore bun-types missing safeIntegers()
        query.safeIntegers(useSafeIntegers);
        const rows = (query.all(...(params as any)) ?? []) as ReadonlyArray<any>;
        return Effect.succeed(transformRows ? transformRows(rows) : rows);
      } catch (cause) {
        return Effect.fail(
          new SqlError({ cause, message: "Failed to execute SQLite statement" }),
        );
      }
    });

  return {
    execute: (statement, params, transformRows) =>
      execute(statement, params, transformRows),
    executeRaw: (statement, params) => execute(statement, params, undefined),
    executeValues: (statement, params) =>
      Effect.withFiberRuntime<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>((fiber) => {
        const useSafeIntegers = Context.get(fiber.currentContext, SqlClient.SafeIntegers);
        try {
          const query = sqlite.query(statement);
          // @ts-ignore bun-types missing safeIntegers()
          query.safeIntegers(useSafeIntegers);
          return Effect.succeed((query.values(...(params as any)) ?? []) as ReadonlyArray<ReadonlyArray<unknown>>);
        } catch (cause) {
          return Effect.fail(
            new SqlError({ cause, message: "Failed to execute SQLite values statement" }),
          );
        }
      }),
    executeUnprepared: (statement, params, transformRows) =>
      execute(statement, params, transformRows),
    executeStream: () => Effect.dieMessage("executeStream not implemented"),
  };
}

function makeSqlClientEffect(
  sqlite: Database,
): Effect.Effect<SqlClient.SqlClient, never> {
  const compiler = Statement.makeCompilerSqlite(camelToSnake);
  const connection = createConnection(sqlite);
  return Effect.gen(function* () {
    const semaphore = yield* Effect.makeSemaphore(1);
    const acquirer = semaphore.withPermits(1)(Effect.succeed(connection));
    const transactionAcquirer = Effect.uninterruptibleMask((restore) =>
      Effect.as(
        Effect.zipRight(
          restore(semaphore.take(1)),
          Effect.tap(
            Effect.scope,
            (scope) => Scope.addFinalizer(scope, semaphore.release(1)),
          ),
        ),
        connection,
      ),
    );
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

function makeSqlClientLayer(sqlite: Database) {
  return Layer.scoped(SqlClient.SqlClient, makeSqlClientEffect(sqlite));
}

export class SqlMessageStorage {
  readonly sqlite: Database;
  // TODO(Phase 8): Keep this per-DB runtime until the unified runtime can
  // inject a scoped SqlClient without rebuilding the per-connection semaphore.
  private runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, never>;
  private tableColumnsCache = new Map<string, Set<string>>();

  constructor(db: BunSQLiteDatabase<any> | Database) {
    this.sqlite = resolveSqliteDatabase(db);
    this.runtime = ManagedRuntime.make(makeSqlClientLayer(this.sqlite));
  }

  private getTableColumns(table: string): Set<string> {
    const cached = this.tableColumnsCache.get(table);
    if (cached) {
      return cached;
    }
    const rows = this.sqlite
      .query(`PRAGMA table_info(${quoteIdentifier(table)})`)
      .all() as ReadonlyArray<{ name?: string }>;
    const columns = new Set(
      rows
        .map((row) => (typeof row.name === "string" ? snakeToCamel(row.name) : ""))
        .filter((value) => value.length > 0),
    );
    this.tableColumnsCache.set(table, columns);
    return columns;
  }

  private filterKnownColumns(
    table: string,
    row: Record<string, unknown>,
  ): Record<string, unknown> {
    const knownColumns = this.getTableColumns(table);
    return Object.fromEntries(
      Object.entries(row).filter(([key, value]) => value !== undefined && knownColumns.has(key)),
    );
  }

  private runEffect<A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> {
    return this.runtime.runPromise(effect);
  }

  private withConnection<A>(
    f: (connection: Connection) => Effect.Effect<A, SqlError>,
  ): Promise<A> {
    return this.runEffect(
      Effect.flatMap(SqlClient.SqlClient, (client) =>
        Effect.scoped(Effect.flatMap(client.reserve, f)),
      ),
    );
  }

  ensureSchemaEffect(): Effect.Effect<void, never> {
    const sqlite = this.sqlite;
    return Effect.sync(() => {
      for (const statement of CREATE_TABLE_STATEMENTS) {
        sqlite.run(statement);
      }
      for (const statement of MIGRATION_STATEMENTS) {
        try {
          sqlite.run(statement);
        } catch {
          // Ignore legacy migration failures for already-applied changes.
        }
      }

      const frameColumns = sqlite
        .query(`PRAGMA table_info("_smithers_frames")`)
        .all() as ReadonlyArray<{ name?: string }>;
      if (!frameColumns.some((column) => column.name === "encoding")) {
        try {
          sqlite.run(
            `ALTER TABLE _smithers_frames ADD COLUMN encoding TEXT NOT NULL DEFAULT 'full'`,
          );
        } catch {
          // Ignore if another caller added it first.
        }
      }
    });
  }

  ensureSchema(): Promise<void> {
    return this.runtime.runPromise(this.ensureSchemaEffect());
  }

  queryAll<T extends Record<string, unknown>>(
    statement: string,
    params: ReadonlyArray<SqliteParam> = [],
    options?: { booleanColumns?: readonly string[] },
  ): Promise<Array<T>> {
    return this.withConnection((connection) =>
      connection
        .execute(
          statement,
          params.map(encodeParam),
          transformRowKeys,
        )
        .pipe(
          Effect.map((rows) =>
            rows.map((row) => applyBooleanColumns(row as T, options?.booleanColumns)),
          ),
        ),
    ) as Promise<Array<T>>;
  }

  async queryOne<T extends Record<string, unknown>>(
    statement: string,
    params: ReadonlyArray<SqliteParam> = [],
    options?: { booleanColumns?: readonly string[] },
  ): Promise<T | undefined> {
    const rows = await this.queryAll<T>(statement, params, options);
    return rows[0];
  }

  execute(
    statement: string,
    params: ReadonlyArray<SqliteParam> = [],
  ): Promise<void> {
    return this.withConnection((connection) =>
      connection.executeRaw(statement, params.map(encodeParam)).pipe(Effect.asVoid),
    );
  }

  insertIgnore(
    table: string,
    row: Record<string, unknown>,
  ): Promise<void> {
    const filteredRow = this.filterKnownColumns(table, row);
    const { statement, params } = buildInsertSql(table, filteredRow, { orIgnore: true });
    return this.execute(statement, params);
  }

  upsert(
    table: string,
    row: Record<string, unknown>,
    conflictColumns: readonly string[],
    updateColumns?: readonly string[],
  ): Promise<void> {
    const filteredRow = this.filterKnownColumns(table, row);
    const { statement, params } = buildInsertSql(table, filteredRow, {
      conflictColumns,
      updateColumns,
    });
    return this.execute(statement, params);
  }

  updateWhere(
    table: string,
    patch: Record<string, unknown>,
    whereSql: string,
    params: ReadonlyArray<SqliteParam> = [],
  ): Promise<void> {
    const built = buildUpdateSql(
      table,
      this.filterKnownColumns(table, patch),
      whereSql,
      params,
    );
    if (!built) {
      return Promise.resolve();
    }
    return this.execute(built.statement, built.params);
  }

  deleteWhere(
    table: string,
    whereSql: string,
    params: ReadonlyArray<SqliteParam> = [],
  ): Promise<void> {
    return this.execute(
      `DELETE FROM ${quoteIdentifier(table)} WHERE ${whereSql}`,
      params,
    );
  }

  private buildEventHistoryWhere(
    runId: string,
    query: SqlMessageStorageEventHistoryQuery = {},
  ): { whereSql: string; params: Array<SqliteParam> } {
    const clauses: string[] = ["run_id = ?", "seq > ?"];
    const params: Array<SqliteParam> = [runId, query.afterSeq ?? -1];

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

  listEventHistory(
    runId: string,
    query: SqlMessageStorageEventHistoryQuery = {},
  ): Promise<Array<Record<string, unknown>>> {
    const limit = Math.max(1, Math.floor(query.limit ?? 200));
    const { whereSql, params } = this.buildEventHistoryWhere(runId, query);
    return this.queryAll(
      `SELECT * FROM _smithers_events
       WHERE ${whereSql}
       ORDER BY seq ASC
       LIMIT ?`,
      [...params, limit],
    );
  }

  async countEventHistory(
    runId: string,
    query: SqlMessageStorageEventHistoryQuery = {},
  ): Promise<number> {
    const { whereSql, params } = this.buildEventHistoryWhere(runId, query);
    const row = await this.queryOne<{ count: number | string }>(
      `SELECT COUNT(*) AS count
       FROM _smithers_events
       WHERE ${whereSql}`,
      params,
    );
    return Number(row?.count ?? 0);
  }

  async getLastEventSeq(runId: string): Promise<number | undefined> {
    const row = await this.queryOne<{ seq: number }>(
      `SELECT seq
       FROM _smithers_events
       WHERE run_id = ?
       ORDER BY seq DESC
       LIMIT 1`,
      [runId],
    );
    return row?.seq;
  }

  listEventsByType(
    runId: string,
    type: string,
  ): Promise<Array<Record<string, unknown>>> {
    return this.queryAll(
      `SELECT *
       FROM _smithers_events
       WHERE run_id = ? AND type = ?
       ORDER BY seq ASC`,
      [runId, type],
    );
  }

  async getLastSignalSeq(runId: string): Promise<number | undefined> {
    const row = await this.queryOne<{ seq: number }>(
      `SELECT seq
       FROM _smithers_signals
       WHERE run_id = ?
       ORDER BY seq DESC
       LIMIT 1`,
      [runId],
    );
    return row?.seq;
  }
}

export function getSqlMessageStorage(
  db: BunSQLiteDatabase<any> | Database,
): SqlMessageStorage {
  return new SqlMessageStorage(db);
}

export function ensureSqlMessageStorageEffect(
  db: BunSQLiteDatabase<any> | Database,
): Effect.Effect<void, never> {
  return getSqlMessageStorage(db).ensureSchemaEffect();
}

export function ensureSqlMessageStorage(
  db: BunSQLiteDatabase<any> | Database,
): Promise<void> {
  return getSqlMessageStorage(db).ensureSchema();
}
