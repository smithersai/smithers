/**
 * Hardening for the append-only persisted plan schema.
 *
 * The initial migration protected node and edge rows from UPDATE and DELETE,
 * and allowed a plan row to move only to a later generation with the same
 * approved base digest. Three gaps remained. Deleting the plan row stranded
 * immutable child rows, `flow` and `created_at_ms` could be rewritten during a
 * forward update, and two nodes could claim the same plan ordinal. This
 * migration closes those gaps with a plan-row delete trigger, a stricter
 * forward-only trigger, and a unique ordinal index.
 *
 * It deliberately adds no foreign keys from `flows_plan_edges`. SQLite cannot
 * add a constraint to an existing table, rebuilding it would require deleting
 * rows the append-only triggers forbid, and a foreign key without
 * `PRAGMA foreign_keys = ON` would be unenforced decoration.
 *
 * This package reserves migration id block `4000`, so this migration is id
 * `4002`. See `@smthrs/database`'s `Migrations` for namespaced composition.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Pins plan identity and timestamps, forbids plan deletion, and makes node
 * order unique inside each plan.
 *
 * @private
 * @since 0.1.0
 * @slop
 */
export const appendOnlyHardening: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TRIGGER flows_plans_no_delete BEFORE DELETE ON flows_plans
    BEGIN SELECT RAISE(ABORT, 'flows_plans is append-only'); END`

  yield* sql`DROP TRIGGER flows_plans_forward_only`

  yield* sql`CREATE TRIGGER flows_plans_forward_only BEFORE UPDATE ON flows_plans
    WHEN NEW.generation <= OLD.generation OR
      NEW.base_digest <> OLD.base_digest OR
      NEW.flow <> OLD.flow OR
      NEW.created_at_ms <> OLD.created_at_ms
    BEGIN SELECT RAISE(ABORT, 'a plan only grows'); END`

  yield* sql`CREATE UNIQUE INDEX flows_plan_nodes_ordinal ON flows_plan_nodes (plan_id, ordinal)`
})
