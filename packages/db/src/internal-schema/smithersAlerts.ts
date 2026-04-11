import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const smithersAlerts = sqliteTable("_smithers_alerts", {
  alertId: text("alert_id").primaryKey(),
  runId: text("run_id"),
  policyName: text("policy_name").notNull(),
  severity: text("severity").notNull(),
  status: text("status").notNull(),
  firedAtMs: integer("fired_at_ms").notNull(),
  resolvedAtMs: integer("resolved_at_ms"),
  acknowledgedAtMs: integer("acknowledged_at_ms"),
  message: text("message").notNull(),
  detailsJson: text("details_json"),
});
