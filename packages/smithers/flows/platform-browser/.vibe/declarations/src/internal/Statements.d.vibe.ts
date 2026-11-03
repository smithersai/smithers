/**
 * Runs SQL on an open wa-sqlite database: the one statement loop
 * `BrowserSqlite.make` and the shared database's connection both use.
 *
 * @since 1.0.0
 */
import { SqlError } from "effect/sql/SqlError";
/**
 * An open wa-sqlite database: the API built from the module, and the
 * database handle `open_v2` returned.
 *
 * @category models
 * @since 1.0.0
 */
export interface Database {
    readonly sqlite3: SQLiteAPI;
    readonly db: number;
}
/**
 * A `SqlError` for a failure of `operation`, classified by SQLite's result
 * code when `cause` carries one.
 *
 * @category errors
 * @since 1.0.0
 */
export declare const failed: (cause: unknown, message: string, operation: string) => SqlError;
/**
 * One entry of a script: `sql`, which may hold several statements, and the
 * `params` bound to each of them.
 *
 * @category models
 * @since 1.0.0
 */
export interface Entry {
    readonly sql: string;
    readonly params: ReadonlyArray<unknown>;
}
/**
 * What {@link runEach} and {@link runAll} tell their caller about each
 * statement: `before` runs once the statement is prepared and before it
 * steps, with whether it is the last statement of the script and the rows
 * the earlier ones returned, one array per entry; `after` runs once it
 * completes. What either throws ends the run.
 *
 * @category models
 * @since 1.0.0
 */
export interface Hooks {
    readonly before?: (statement: {
        readonly last: boolean;
        readonly results: ReadonlyArray<ReadonlyArray<unknown>>;
    }) => Promise<void>;
    readonly after?: () => Promise<void>;
}
/**
 * Runs each entry of `entries` in order, every statement of its `sql` with
 * its `params`, and collects the rows each entry's statements return, as
 * objects keyed by column name or as arrays: one array per entry. `columns`
 * is `0` when no statement had result columns. A statement SQLite refuses
 * ends the run: the entries after it never run. `hooks` see each statement
 * before it steps and after it completes.
 *
 * @category running
 * @since 1.0.0
 */
export declare const runEach: ({ db, sqlite3 }: Database, entries: ReadonlyArray<Entry>, shape: "object" | "array", hooks?: Hooks) => Promise<{
    readonly results: Array<Array<unknown>>;
    readonly columns: number;
}>;
/**
 * Runs every statement in `sql`, binding `params` to each, and collects the
 * rows of those that return any: {@link runEach} of one entry.
 *
 * @category running
 * @since 1.0.0
 */
export declare const runAll: (database: Database, sql: string, params: ReadonlyArray<unknown>, shape: "object" | "array", hooks?: Hooks) => Promise<{
    readonly rows: Array<unknown>;
    readonly columns: number;
}>;
