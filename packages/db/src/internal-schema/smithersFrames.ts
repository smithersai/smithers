import {
  integer,
  sqliteTable,
  text,
  primaryKey,
} from "drizzle-orm/sqlite-core";

export const smithersFrames = sqliteTable(
  "_smithers_frames",
  {
    runId: text("run_id").notNull(),
    frameNo: integer("frame_no").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    xmlJson: text("xml_json").notNull(),
    xmlHash: text("xml_hash").notNull(),
    encoding: text("encoding").notNull().default("full"),
    mountedTaskIdsJson: text("mounted_task_ids_json"),
    taskIndexJson: text("task_index_json"),
    note: text("note"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.frameNo] }),
  }),
);
