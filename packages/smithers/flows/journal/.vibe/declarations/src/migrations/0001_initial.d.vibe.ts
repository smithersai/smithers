/**
 * Initial durable journal event schema.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Creates the `flows_journal_events` table and its event-type index.
 *
 * @category migrations
 * @since 0.1.0
 */
export declare const initial: Effect.Effect<void, unknown, SqlClient.SqlClient>;
