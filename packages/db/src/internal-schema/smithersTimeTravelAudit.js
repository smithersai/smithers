import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const smithersTimeTravelAudit = sqliteTable("_smithers_time_travel_audit", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull(),
  fromFrameNo: integer("from_frame_no").notNull(),
  toFrameNo: integer("to_frame_no").notNull(),
  caller: text("caller").notNull(),
  timestampMs: integer("timestamp_ms").notNull(),
  result: text("result").notNull(),
  durationMs: integer("duration_ms"),
});
