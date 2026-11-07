/**
 * Journal schema migrations.
 *
 * The journal owns four tables: `flows_journal_events` and its event-type
 * index in `0001_initial`, `flows_journal_checkpoints` in
 * `0002_checkpoints`, the bounded startup ordering index in
 * `0003_startup_index`, compacted producer identities in `0004_dedup`, the
 * per-run exact event-type cursor index in `0005_run_event_type`, and the
 * `SqlConsensus` lease table `flows_consensus_leases` in `0006_consensus`. Run
 * and attempt state migrate from `@smthrs/run-store`, the step cache from
 * `@smthrs/step-cache`, and the durable deferred/clock tables from
 * `@smthrs/engine-store`; an application composes those sets with this one
 * through `@smthrs/database`'s `Migrations.layer`.
 *
 * @since 0.1.0
 */
import * as DatabaseMigrations from "@smthrs/database/Migrations";
import * as Layer from "effect/Layer";
/**
 * The journal's namespaced migration set, for composition with the other
 * storage packages.
 *
 * @category migrations
 * @since 0.1.0
 */
export declare const set: DatabaseMigrations.MigrationSet;
/**
 * Creates the journal's authoritative durable schema.
 *
 * @category migrations
 * @since 0.1.0
 */
export declare const run: import("effect/Effect").Effect<readonly (readonly [id: number, name: string])[], import("effect/sql/Migrator").MigrationError | import("effect/sql/SqlError").SqlError, import("effect/sql/SqlClient").SqlClient>;
/**
 * Layer that runs journal migrations before exposing the database to journal
 * services.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: Layer.Layer<never, import("effect/sql/Migrator").MigrationError | import("effect/sql/SqlError").SqlError, import("effect/sql/SqlClient").SqlClient>;
