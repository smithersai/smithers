import {
  integer,
  sqliteTable,
  text,
  primaryKey,
} from "drizzle-orm/sqlite-core";

export const smithersNodes = sqliteTable(
  "_smithers_nodes",
  {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    iteration: integer("iteration").notNull().default(0),
    state: text("state").notNull(),
    lastAttempt: integer("last_attempt"),
    updatedAtMs: integer("updated_at_ms").notNull(),
    outputTable: text("output_table").notNull(),
    label: text("label"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.nodeId, t.iteration] }),
  }),
);
