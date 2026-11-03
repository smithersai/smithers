/**
 * Time-travel schema migrations, as a rung on the shared ladder.
 *
 * Each rung owns fixed DDL. Store construction applies this same set through
 * the shared migrator, which records completed rungs in `flows_migrations`.
 * Add schema changes as new rungs; never grow an already published rung.
 * The journal owns `flows_journal_events`; time travel owns the lineage
 * indexes it adds to that table.
 *
 * @since 0.1.0
 */
import * as DatabaseMigrations from "@smthrs/database/Migrations";
import * as Layer from "effect/Layer";
/**
 * Time travel's namespaced migration set.
 *
 * The block is `5000` — above `@smthrs/plan`'s `4000`, which is what keeps the
 * set runnable on a database the engine ladder already migrated.
 *
 * @category migrations
 * @since 0.1.0
 */
export declare const set: DatabaseMigrations.MigrationSet;
/**
 * The full durable schema an engine WITH time travel needs, in dependency
 * order: everything `@smthrs/engine-store` composes, then this.
 *
 * @category migrations
 * @since 0.1.0
 */
export declare const sets: ReadonlyArray<DatabaseMigrations.MigrationSet>;
/**
 * Creates the complete durable schema for an engine with time travel.
 *
 * @category migrations
 * @since 0.1.0
 */
export declare const run: import("effect/Effect").Effect<readonly (readonly [id: number, name: string])[], import("effect/sql/Migrator").MigrationError | import("effect/sql/SqlError").SqlError, import("effect/sql/SqlClient").SqlClient>;
/**
 * Layer that installs the complete schema before exposing the database.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: Layer.Layer<never, import("effect/sql/Migrator").MigrationError | import("effect/sql/SqlError").SqlError, import("effect/sql/SqlClient").SqlClient>;
