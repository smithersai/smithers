import { Effect } from "effect";
import { SqlClient } from "effect/sql";
/** GitHub remains authoritative; reconciliation backfills labels for existing rows. */
declare const _default: Effect.Effect<void, import("effect/sql/SqlError").SqlError, SqlClient.SqlClient>;
export default _default;
