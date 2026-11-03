import { Effect } from "effect";
import { SqlClient } from "effect/sql";
/** A kept rate limit belongs to the quota that refused it, not a later authenticated read. */
declare const _default: Effect.Effect<void, import("effect/sql/SqlError").SqlError, SqlClient.SqlClient>;
export default _default;
