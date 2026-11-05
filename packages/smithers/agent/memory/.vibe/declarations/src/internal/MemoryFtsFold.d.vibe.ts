/**
 * The third memory migration: PostgreSQL FTS folds diacritics like FTS5.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Regenerates the search column of every enabled PostgreSQL FTS table with
 * the current diacritic-folding expression, so text indexed before the fold
 * still matches folded query terms. SQLite's FTS5 tables already fold, and a
 * kind enabled after this migration is created with the current column.
 *
 * @category migrations
 * @since 1.0.0
 */
export declare const ftsFold: Effect.Effect<void, import("effect/sql/SqlError").SqlError, SqlClient.SqlClient>;
