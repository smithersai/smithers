/**
 * @smthrs/database public API.
 *
 * This entry point is the write boundary plus the PostgreSQL adapter, and it
 * stays browser-bundleable: `PostgresDatabase` takes its `@effect/sql-pg`
 * driver from the caller, so the root imports no socket code. The SQLite
 * drivers are platform-specific and live under explicit subpaths, the way
 * `effect` keeps platform packages out of its own root: the Node driver is
 * `node:sqlite` through `@effect/sql-sqlite-node`.
 *
 * ```ts
 * import * as Pg from "@effect/sql-pg"
 * import { DurableWriter, PostgresDatabase } from "@smthrs/database"
 * import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
 * ```
 *
 * @since 0.1.0
 */
/**
 * @category services
 * @since 0.1.0
 */
export * as DurableWriter from "./DurableWriter.ts";
/**
 * @category metrics
 * @since 0.1.0
 */
export * as DatabaseMetrics from "./DatabaseMetrics.ts";
/**
 * @category migrations
 * @since 0.1.0
 */
export * as Migrations from "./Migrations.ts";
/**
 * @category models
 * @since 1.0.0
 */
export * as UnsupportedBackend from "./UnsupportedBackend.ts";
/**
 * @category drivers
 * @since 1.0.0
 */
export * as PostgresDatabase from "./postgres/PostgresDatabase.ts";
/** @category testing
 * @since 1.0.0
 */
export * as TestSchemas from "./TestSchemas.ts";
