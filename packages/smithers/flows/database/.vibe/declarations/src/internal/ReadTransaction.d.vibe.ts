/** Read transactions a driver opens itself.
 * @since 1.0.0
 */
import type { Effect } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
/**
 * Runs an effect in one read transaction on the client that registered it.
 *
 * @since 1.0.0
 * @private
 */
export type Open = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SqlError, R>;
/** Records how a driver opens a read transaction on `sql`; only drivers call this.
 * @since 1.0.0
 * @private
 */
export declare const register: (sql: SqlClient, open: Open) => void;
/** How the driver that opened `sql` opens a read transaction, if it said.
 * @since 1.0.0
 * @private
 */
export declare const get: (sql: SqlClient) => Open | undefined;
