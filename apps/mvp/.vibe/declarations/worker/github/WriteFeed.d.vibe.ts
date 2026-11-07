import { Effect } from "effect";
import { SqlClient } from "effect/sql";
/**
 * Fold a write's actual receipt into its person's notification in the same transaction as admission or settlement;
 * replays change nothing. A branch's write opens its branch; a new issue opens the issue once GitHub has it, else the
 * repository's issues.
 */
export declare const fold: (id: string) => Effect.Effect<number, import("effect/sql/SqlError").SqlError, SqlClient.SqlClient>;
