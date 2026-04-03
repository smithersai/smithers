import {
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * Drizzle table definition for the `_smithers_scorers` table.
 * Stores individual scorer results for each task execution.
 */
export const smithersScorers = sqliteTable("_smithers_scorers", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  nodeId: text("node_id").notNull(),
  iteration: integer("iteration").notNull().default(0),
  attempt: integer("attempt").notNull().default(0),
  scorerId: text("scorer_id").notNull(),
  scorerName: text("scorer_name").notNull(),
  source: text("source").notNull(), // "live" | "batch"
  score: real("score").notNull(),
  reason: text("reason"),
  metaJson: text("meta_json"),
  inputJson: text("input_json"),
  outputJson: text("output_json"),
  latencyMs: real("latency_ms"),
  scoredAtMs: integer("scored_at_ms").notNull(),
  durationMs: real("duration_ms"),
});
