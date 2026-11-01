/**
 * What an alarm's failure log says beyond the failure's tag: enough to name
 * a failed schema migration and the database's answer, without quoting a
 * flow's content.
 *
 * A flow step's failure may quote a prompt or a provider, so for most
 * failures the log keeps the tag alone. A migration is different: its
 * statements and the server's answer to them are the engine's own schema
 * text. For a `MigrationError` the detail names the migration, the statement
 * that failed and the database's message. For any failure that reached the
 * database it names the SQL error's kind and SQLSTATE code, which carry no
 * content, and for a lost or refused connection the driver's text for it. A data exception (SQLSTATE class `22`) quotes the value it
 * rejected, so its message is left out even under a migration.
 *
 * @since 1.0.0
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
/**
 * The detail for a failed alarm's log line and span, from its `cause` and
 * `statement`, the text of the last SQL statement that failed during it
 * ({@link withFailedStatement}):
 *
 * - `db.error`: the SQL error's kind (`ConnectionError`, `SqlSyntaxError`, ...);
 * - `db.error.message`: for a `ConnectionError`, the driver's text for it
 *   (`PgConnection: Connection closed`), which carries no content;
 * - `db.response.status_code`: its SQLSTATE code;
 * - under a `MigrationError` only: `db.migration` (`<id>_<name>`),
 *   `db.migration.kind`, `error.message` (the migration error's own text),
 *   `db.error.message` (the database's message) and `db.query.text`
 *   (`statement`).
 *
 * @category telemetry
 * @since 1.0.0
 */
export declare const detail: (cause: Cause.Cause<unknown>, statement: string | undefined) => Readonly<Record<string, string>>;
/**
 * Runs `effect` under the current tracer, keeping the last few client spans
 * it opens, and answers its exit with the text (`db.query.text`) of the last
 * SQL statement whose span ended in failure, if any. Every span still goes to
 * the current tracer unchanged.
 *
 * @category telemetry
 * @since 1.0.0
 */
export declare const withFailedStatement: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<readonly [Exit.Exit<A, E>, string | undefined], never, R>;
