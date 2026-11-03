/** @since 0.1.0 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Adds `active_claimed_at_ms`, the lease start of a launch reservation.
 *
 * A named export rather than `export default`: the CommonJS build reads a
 * default import of a sibling module as the whole exports object, so the
 * migrator received `{ default }` instead of this Effect.
 *
 * @category migrations
 * @since 0.1.0
 */
export declare const reservationLease: Effect.Effect<void, unknown, SqlClient.SqlClient>;
