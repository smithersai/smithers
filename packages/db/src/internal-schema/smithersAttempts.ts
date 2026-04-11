import {
  integer,
  sqliteTable,
  text,
  primaryKey,
} from "drizzle-orm/sqlite-core";

export const smithersAttempts = sqliteTable(
  "_smithers_attempts",
  {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    iteration: integer("iteration").notNull().default(0),
    attempt: integer("attempt").notNull(),
    state: text("state").notNull(),
    startedAtMs: integer("started_at_ms").notNull(),
    finishedAtMs: integer("finished_at_ms"),
    heartbeatAtMs: integer("heartbeat_at_ms"),
    heartbeatDataJson: text("heartbeat_data_json"),
    errorJson: text("error_json"),
    jjPointer: text("jj_pointer"),
    cached: integer("cached", { mode: "boolean" }).default(false),
    metaJson: text("meta_json"),
    responseText: text("response_text"),
    jjCwd: text("jj_cwd"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.nodeId, t.iteration, t.attempt] }),
  }),
);
