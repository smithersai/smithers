/**
 * Durable journal checkpoints and the compaction floor.
 *
 * One row per `(run_id, seq)`: the caller-captured state that replays the run
 * from `seq` without the entries before it. `compacted_at_ms` is NULL until a
 * compaction has truncated the entries strictly below `seq`; the largest
 * compacted `seq` per run is the run's compaction floor, and reads whose
 * cursor starts below it fail with `compacted` instead of returning a
 * silently shortened history.
 *
 * Prior art: Temporal's mutable state is exactly this shape, a durable
 * snapshot pinned to a history offset (`last_first_event_id` in
 * `reference/temporal/proto/internal/temporal/server/api/persistence/v1/executions.proto`),
 * with history below it never replayed.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Creates the `flows_journal_checkpoints` table.
 *
 * @category migrations
 * @since 0.1.0
 */
export declare const checkpoints: Effect.Effect<void, unknown, SqlClient.SqlClient>;
