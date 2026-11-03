/**
 * Control-plane and credential schema migrations.
 *
 * This package reserves the migration block immediately after time travel.
 * Hosts compose this set with the journal and run-store sets before opening a
 * shared control database.
 *
 * @since 0.1.0
 */
import * as DatabaseMigrations from "@smthrs/database/Migrations";
import * as Layer from "effect/Layer";
/**
 * The control package's namespaced migration set.
 *
 * @category migrations
 * @since 0.1.0
 */
export declare const set: DatabaseMigrations.MigrationSet;
/**
 * Creates every durable control-plane and credential table.
 *
 * @category migrations
 * @since 0.1.0
 */
export declare const run: import("effect/Effect").Effect<readonly (readonly [id: number, name: string])[], import("effect/sql/Migrator").MigrationError | import("effect/sql/SqlError").SqlError, import("effect/sql/SqlClient").SqlClient>;
/**
 * Layer that runs control migrations before exposing the database to control
 * services.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: Layer.Layer<never, import("effect/sql/Migrator").MigrationError | import("effect/sql/SqlError").SqlError, import("effect/sql/SqlClient").SqlClient>;
