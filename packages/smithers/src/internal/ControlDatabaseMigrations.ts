/**
 * The schema installed before any service opens the shared control database.
 *
 * Memory can be the first CLI command a project runs. Installing every lower
 * block here keeps that command from advancing the migration cursor past
 * control and engine tables that a later command still needs to create.
 *
 * @since 1.0.0
 */

import * as ControlMigrations from "@smthrs/control/Migrations"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as MemoryMigrations from "@smthrs/memory/Migrations"
import * as TimeTravelMigrations from "@smthrs/time-travel/Migrations"
import { Effect } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as HistoryMigrations from "../history/Migrations.ts"

/**
 * Applies the complete shared schema in a single ordered migration pass.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = DatabaseMigrations.layer([
  ...TimeTravelMigrations.sets,
  ControlMigrations.set,
  MemoryMigrations.set,
  HistoryMigrations.set,
  {
    namespace: "trigger-approvals",
    idOffset: DatabaseMigrations.idBlock * 9,
    migrations: {
      "0001_standing_approvals": Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TABLE control_trigger_approvals (
          grant_id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, declaration_digest TEXT NOT NULL,
          plan_digest TEXT NOT NULL, approval_json TEXT NOT NULL, principal_json TEXT NOT NULL,
          granted_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER
        )`
        yield* sql`CREATE INDEX control_trigger_approvals_trigger ON control_trigger_approvals (trigger_id, declaration_digest, plan_digest)`
        yield* sql`CREATE TABLE control_trigger_plan_bindings (
          plan_id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, declaration_digest TEXT NOT NULL
        )`
        yield* sql`CREATE TABLE control_trigger_approval_uses (
          plan_id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, grant_id TEXT NOT NULL,
          used_at_ms INTEGER NOT NULL, FOREIGN KEY (grant_id) REFERENCES control_trigger_approvals(grant_id)
        )`
      })
    }
  }
])
