/**
 * Run and attempt schema migrations.
 *
 * This package owns `flows_runs` and `flows_attempts`. It reserves migration
 * id block `1000` so its ids can never collide with the journal's or the step
 * cache's — see `@smthrs/database`'s `Migrations` for how the blocks compose.
 *
 * The SQL `RunStore` arbitrates ownership through `@smthrs/journal`'s
 * `SqlConsensus`, whose lease table the journal's migration set creates, so
 * {@link run} and {@link layer} install the journal's set ahead of this one.
 * Journal inserts also drive the run progress trigger, so journal migrations
 * must precede this set. {@link set} owns run-store schema for compositions that list
 * every set themselves, such as `@smthrs/engine-store/Migrations`.
 *
 * @since 0.1.0
 */
import * as DatabaseMigrations from "@smthrs/database/Migrations";
import * as Layer from "effect/Layer";
/**
 * The run store's namespaced migration set, for composition with the other
 * storage packages.
 *
 * @category migrations
 * @since 0.1.0
 */
export declare const set: DatabaseMigrations.MigrationSet;
/**
 * Creates the run and attempt schema, and the journal schema whose consensus
 * lease table the SQL `RunStore` fences through.
 *
 * @category migrations
 * @since 0.1.0
 */
export declare const run: import("effect/Effect").Effect<readonly (readonly [id: number, name: string])[], import("effect/sql/Migrator").MigrationError | import("effect/sql/SqlError").SqlError, import("effect/sql/SqlClient").SqlClient>;
/**
 * Layer that runs run-store migrations before exposing the database to the run
 * and attempt services.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: Layer.Layer<never, import("effect/sql/Migrator").MigrationError | import("effect/sql/SqlError").SqlError, import("effect/sql/SqlClient").SqlClient>;
