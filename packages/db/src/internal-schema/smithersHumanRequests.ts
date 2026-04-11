import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const smithersHumanRequests = sqliteTable("_smithers_human_requests", {
  requestId: text("request_id").primaryKey(),
  runId: text("run_id").notNull(),
  nodeId: text("node_id").notNull(),
  iteration: integer("iteration").notNull().default(0),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  prompt: text("prompt").notNull(),
  schemaJson: text("schema_json"),
  optionsJson: text("options_json"),
  responseJson: text("response_json"),
  requestedAtMs: integer("requested_at_ms").notNull(),
  answeredAtMs: integer("answered_at_ms"),
  answeredBy: text("answered_by"),
  timeoutAtMs: integer("timeout_at_ms"),
});
