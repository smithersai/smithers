import {
  integer,
  sqliteTable,
  text,
  primaryKey,
} from "drizzle-orm/sqlite-core";

export const smithersEvents = sqliteTable(
  "_smithers_events",
  {
    runId: text("run_id").notNull(),
    seq: integer("seq").notNull(),
    timestampMs: integer("timestamp_ms").notNull(),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.seq] }),
  }),
);
