import {
  integer,
  sqliteTable,
  text,
  primaryKey,
} from "drizzle-orm/sqlite-core";

export const smithersToolCalls = sqliteTable(
  "_smithers_tool_calls",
  {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    iteration: integer("iteration").notNull().default(0),
    attempt: integer("attempt").notNull(),
    seq: integer("seq").notNull(),
    toolName: text("tool_name").notNull(),
    inputJson: text("input_json"),
    outputJson: text("output_json"),
    startedAtMs: integer("started_at_ms").notNull(),
    finishedAtMs: integer("finished_at_ms"),
    status: text("status").notNull(),
    errorJson: text("error_json"),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.runId, t.nodeId, t.iteration, t.attempt, t.seq],
    }),
  }),
);
