import {
  integer,
  sqliteTable,
  text,
  primaryKey,
} from "drizzle-orm/sqlite-core";

export const smithersSandboxes = sqliteTable(
  "_smithers_sandboxes",
  {
    runId: text("run_id").notNull(),
    sandboxId: text("sandbox_id").notNull(),
    runtime: text("runtime").notNull().default("bubblewrap"),
    remoteRunId: text("remote_run_id"),
    workspaceId: text("workspace_id"),
    containerId: text("container_id"),
    configJson: text("config_json").notNull(),
    status: text("status").notNull().default("pending"),
    shippedAtMs: integer("shipped_at_ms"),
    completedAtMs: integer("completed_at_ms"),
    bundlePath: text("bundle_path"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.sandboxId] }),
  }),
);
