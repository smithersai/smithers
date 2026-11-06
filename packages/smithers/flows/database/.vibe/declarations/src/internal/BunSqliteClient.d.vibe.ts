/**
 * Bun SQLite client whose raw writes report affected rows.
 *
 * Adapted from `@effect/sql-sqlite-bun@4.0.4` `SqliteClient.make`. That driver
 * runs every statement through `.all()`, so `.raw` on INSERT, UPDATE and
 * DELETE yields `[]` and `DurableWriter.affectedRows` fails `unsupported`
 * (issue #2419). Like `@effect/sql-sqlite-node`, a statement without result
 * columns runs through `.run()` here and `.raw` returns
 * `{ changes, lastInsertRowid }`. Everything else follows the upstream file:
 * the open and its PRAGMAs fail as a typed `SqlError`, a `file:` name opens as
 * a URI, the WAL switch is retried for the busy timeout, and a failed COMMIT
 * is rolled back before the connection is lent again. Delete this module once
 * the upstream driver reports affected rows. `BunSqliteClient.test.ts`
 * measures it over a `bun:sqlite` shim; `NativeBunSqliteClient.test.ts` and
 * agent/memory `NativeBunAffectedRows.test.ts` run it under real Bun.
 *
 * @since 1.0.0
 */
import type { SqliteClientConfig } from "@effect/sql-sqlite-bun/SqliteClient";
import * as Layer from "effect/Layer";
import * as Client from "effect/sql/SqlClient";
import { SqlError } from "effect/sql/SqlError";
/** Provides the Bun `SqlClient`; `.raw` on a write returns `{ changes, lastInsertRowid }`.
 * @since 1.0.0
 * @category layers
 */
export declare const layer: (config: SqliteClientConfig) => Layer.Layer<Client.SqlClient, SqlError>;
