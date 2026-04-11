import {
  integer,
  sqliteTable,
  text,
  primaryKey,
} from "drizzle-orm/sqlite-core";

export const smithersRalph = sqliteTable(
  "_smithers_ralph",
  {
    runId: text("run_id").notNull(),
    ralphId: text("ralph_id").notNull(),
    iteration: integer("iteration").notNull().default(0),
    done: integer("done", { mode: "boolean" }).notNull().default(false),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.ralphId] }),
  }),
);
