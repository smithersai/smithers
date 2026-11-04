/**
 * Step cache schema migrations.
 *
 * This package owns two tables and nothing else: the mutable `flows_step_cache`
 * head and the append-only `flows_step_cache_recorded` provenance ledger. It
 * reserves migration id block `2000` so its ids can never collide with the
 * journal's or the run store's — see `@smthrs/database`'s `Migrations` for how
 * the blocks compose.
 *
 * See the {@link https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/docs/concepts/step-keys.md | step-key contract}
 * and {@link https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/journal/docs/README.md | journal architecture}.
 *
 * @since 0.1.0
 */
import * as DatabaseMigrations from "@smthrs/database/Migrations";
import * as Layer from "effect/Layer";
/**
 * The step cache's namespaced migration set, for composition with the other
 * storage packages.
 *
 * @category migrations
 * @since 0.1.0
 */
export declare const set: DatabaseMigrations.MigrationSet;
/**
 * Creates the step cache schema.
 *
 * @category migrations
 * @since 0.1.0
 */
export declare const run: import("effect/Effect").Effect<readonly (readonly [id: number, name: string])[], import("effect/sql/Migrator").MigrationError | import("effect/sql/SqlError").SqlError, import("effect/sql/SqlClient").SqlClient>;
/**
 * Layer that runs step-cache migrations before exposing the database to the
 * cache service.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: Layer.Layer<never, import("effect/sql/Migrator").MigrationError | import("effect/sql/SqlError").SqlError, import("effect/sql/SqlClient").SqlClient>;
