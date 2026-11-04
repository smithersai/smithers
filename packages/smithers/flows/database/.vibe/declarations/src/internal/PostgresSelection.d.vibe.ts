/** Native configuration selection shared by Node and Bun.
 * @since 1.0.0
 */
import { Layer } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
/** Recognizes PostgreSQL connection strings.
 * @since 1.0.0
 * @private
 */
export declare const isUrl: (value: string) => boolean;
/** Where a filename's store lives on PostgreSQL: the connection URL (without
 * its `schema` parameter) and the schema the store's tables are in, or
 * `undefined` for a store SQLite keeps.
 * Explicit URLs select one schema; environment selection preserves each local store's identity.
 * Only Smithers' own settings select PostgreSQL: `SMITHERS_POSTGRES_URL`, or the generic
 * `DATABASE_URL` when `SMITHERS_BACKEND=postgres` asks for it.
 * @since 1.0.0
 * @private
 */
export declare const location: (filename: string) => {
    readonly url: string;
    readonly schema: string;
} | undefined;
/** The PostgreSQL client for a filename {@link location} places on PostgreSQL.
 * The driver loads only then: `@effect/sql-pg` is an optional peer, absent
 * where every store stays on SQLite.
 * @since 1.0.0
 * @private
 */
export declare const layer: (filename: string, readOnly?: boolean) => Layer.Layer<SqlClient> | undefined;
