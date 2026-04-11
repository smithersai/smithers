import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const smithersCron = sqliteTable("_smithers_cron", {
  cronId: text("cron_id").primaryKey(),
  pattern: text("pattern").notNull(),
  workflowPath: text("workflow_path").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).default(true),
  createdAtMs: integer("created_at_ms").notNull(),
  lastRunAtMs: integer("last_run_at_ms"),
  nextRunAtMs: integer("next_run_at_ms"),
  errorJson: text("error_json"),
});
