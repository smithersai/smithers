/**
 * Memory schema migrations on the shared Smithers database ladder.
 *
 * Standalone stores install only this set. Hosts sharing a file with the
 * durable engine and control plane compose those lower blocks before this
 * set, so every table and its migration identity are committed together.
 *
 * @since 1.0.0
 */
import * as DatabaseMigrations from "@smthrs/database/Migrations";
import * as Layer from "effect/Layer";
/**
 * Memory's authoritative schema, in the block following the control plane.
 *
 * @category migrations
 * @since 1.0.0
 */
export declare const set: DatabaseMigrations.MigrationSet;
/**
 * Applies the memory schema and records it atomically in `flows_migrations`.
 *
 * @category migrations
 * @since 1.0.0
 */
export declare const run: import("effect/Effect").Effect<readonly (readonly [id: number, name: string])[], import("effect/sql/Migrator").MigrationError | import("effect/sql/SqlError").SqlError, import("effect/sql/SqlClient").SqlClient>;
/**
 * Installs the memory schema before exposing the database to memory services.
 *
 * @category layers
 * @since 1.0.0
 */
export declare const layer: Layer.Layer<never, import("effect/sql/Migrator").MigrationError | import("effect/sql/SqlError").SqlError, import("effect/sql/SqlClient").SqlClient>;
