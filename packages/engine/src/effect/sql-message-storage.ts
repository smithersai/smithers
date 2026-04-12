import { Database } from "bun:sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
type SqliteParam = string | number | bigint | boolean | Uint8Array | null | undefined;
export type SqlMessageStorageEventHistoryQuery = {
    afterSeq?: number;
    limit?: number;
    nodeId?: string;
    types?: readonly string[];
    sinceTimestampMs?: number;
};
export declare class SqlMessageStorage {
    readonly sqlite: Database;
    private runtime;
    private tableColumnsCache;
    constructor(db: BunSQLiteDatabase<any> | Database);
    private getTableColumns;
    private filterKnownColumns;
    private runEffect;
    private withConnection;
    ensureSchemaEffect(): Effect.Effect<void, never>;
    ensureSchema(): Promise<void>;
    queryAll<T extends Record<string, unknown>>(statement: string, params?: ReadonlyArray<SqliteParam>, options?: {
        booleanColumns?: readonly string[];
    }): Promise<Array<T>>;
    queryOne<T extends Record<string, unknown>>(statement: string, params?: ReadonlyArray<SqliteParam>, options?: {
        booleanColumns?: readonly string[];
    }): Promise<T | undefined>;
    execute(statement: string, params?: ReadonlyArray<SqliteParam>): Promise<void>;
    insertIgnore(table: string, row: Record<string, unknown>): Promise<void>;
    upsert(table: string, row: Record<string, unknown>, conflictColumns: readonly string[], updateColumns?: readonly string[]): Promise<void>;
    updateWhere(table: string, patch: Record<string, unknown>, whereSql: string, params?: ReadonlyArray<SqliteParam>): Promise<void>;
    deleteWhere(table: string, whereSql: string, params?: ReadonlyArray<SqliteParam>): Promise<void>;
    private buildEventHistoryWhere;
    listEventHistory(runId: string, query?: SqlMessageStorageEventHistoryQuery): Promise<Array<Record<string, unknown>>>;
    countEventHistory(runId: string, query?: SqlMessageStorageEventHistoryQuery): Promise<number>;
    getLastEventSeq(runId: string): Promise<number | undefined>;
    listEventsByType(runId: string, type: string): Promise<Array<Record<string, unknown>>>;
    getLastSignalSeq(runId: string): Promise<number | undefined>;
}
export declare function getSqlMessageStorage(db: BunSQLiteDatabase<any> | Database): SqlMessageStorage;
export declare function ensureSqlMessageStorageEffect(db: BunSQLiteDatabase<any> | Database): Effect.Effect<void, never>;
export declare function ensureSqlMessageStorage(db: BunSQLiteDatabase<any> | Database): Promise<void>;
export {};
