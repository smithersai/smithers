/** @since 1.0.0-rc.0 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Creates `flows_scheduler_heartbeat`, one row per scheduler host holding the
 * last poll it recorded, so a listing can say whether anything is listening.
 *
 * A named export rather than `export default`: the CommonJS build reads a
 * default import of a sibling module as the whole exports object, so the
 * migrator received `{ default }` instead of this Effect.
 *
 * @category migrations
 * @since 1.0.0-rc.0
 */
export declare const schedulerHeartbeat: Effect.Effect<void, unknown, SqlClient.SqlClient>;
