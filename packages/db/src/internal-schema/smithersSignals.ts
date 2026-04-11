import {
  integer,
  sqliteTable,
  text,
  primaryKey,
} from "drizzle-orm/sqlite-core";

export const smithersSignals = sqliteTable(
  "_smithers_signals",
  {
    runId: text("run_id").notNull(),
    seq: integer("seq").notNull(),
    signalName: text("signal_name").notNull(),
    correlationId: text("correlation_id"),
    payloadJson: text("payload_json").notNull(),
    receivedAtMs: integer("received_at_ms").notNull(),
    receivedBy: text("received_by"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.seq] }),
  }),
);
