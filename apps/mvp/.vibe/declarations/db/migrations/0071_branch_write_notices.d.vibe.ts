import { Effect } from "effect";
import { SqlClient } from "effect/sql";
/** Publication and update receipts use the shared attention lifecycle, independently of agent-answer runs. */
declare const _default: Effect.Effect<void, import("effect/sql/SqlError").SqlError, SqlClient.SqlClient>;
export default _default;
