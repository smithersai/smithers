/** @since 0.1.0 */
import * as Layer from "effect/Layer";
import * as Migrator from "effect/sql/Migrator";
/**
 * The migration record {@link run} applies, keyed by migration file name.
 *
 * Exported so a test and the release smoke can assert that every entry is the
 * migration Effect itself in both the ESM and the CommonJS build.
 *
 * @category migrations
 * @since 1.0.0-rc.0
 */
export declare const migrations: {
    "0001_triggers": import("effect/Effect").Effect<void, unknown, import("effect/sql/SqlClient").SqlClient>;
    "0002_reservation_lease": import("effect/Effect").Effect<void, unknown, import("effect/sql/SqlClient").SqlClient>;
    "0003_heartbeat": import("effect/Effect").Effect<void, unknown, import("effect/sql/SqlClient").SqlClient>;
    "0004_fire_run_index": import("effect/Effect").Effect<void, unknown, import("effect/sql/SqlClient").SqlClient>;
};
/**
 * Applies the triggers schema migrations.
 *
 * @category migrations
 * @since 0.1.0
 */
export declare const run: import("effect/Effect").Effect<readonly (readonly [id: number, name: string])[], Migrator.MigrationError | import("effect/sql/SqlError").SqlError, import("effect/sql/SqlClient").SqlClient>;
/**
 * Runs {@link run} once as a layer.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: Layer.Layer<never, Migrator.MigrationError | import("effect/sql/SqlError").SqlError, import("effect/sql/SqlClient").SqlClient>;
