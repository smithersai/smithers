/**
 * Producer identities retained when compaction deletes event payloads.
 *
 * @since 1.0.0-rc.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Creates the durable compacted-identity index.
 *
 * @category migrations
 * @since 1.0.0-rc.0
 */
export declare const dedup: Effect.Effect<void, unknown, SqlClient.SqlClient>;
