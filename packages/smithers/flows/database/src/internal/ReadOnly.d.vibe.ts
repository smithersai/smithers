/** Clients a driver opened for reading only.
 * @since 1.0.0
 */
import type { SqlClient } from "effect/sql/SqlClient";
/** Records that the driver opened `sql` read-only; only drivers call this.
 * @since 1.0.0
 * @private
 */
export declare const mark: (sql: SqlClient) => void;
/** Whether a driver opened `sql` read-only.
 * @since 1.0.0
 * @private
 */
export declare const has: (sql: SqlClient) => boolean;
