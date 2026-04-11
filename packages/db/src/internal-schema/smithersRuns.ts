import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const smithersRuns = sqliteTable("_smithers_runs", {
  runId: text("run_id").primaryKey(),
  parentRunId: text("parent_run_id"),
  workflowName: text("workflow_name").notNull(),
  workflowPath: text("workflow_path"),
  workflowHash: text("workflow_hash"),
  status: text("status").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  startedAtMs: integer("started_at_ms"),
  finishedAtMs: integer("finished_at_ms"),
  heartbeatAtMs: integer("heartbeat_at_ms"),
  runtimeOwnerId: text("runtime_owner_id"),
  cancelRequestedAtMs: integer("cancel_requested_at_ms"),
  hijackRequestedAtMs: integer("hijack_requested_at_ms"),
  hijackTarget: text("hijack_target"),
  vcsType: text("vcs_type"),
  vcsRoot: text("vcs_root"),
  vcsRevision: text("vcs_revision"),
  errorJson: text("error_json"),
  configJson: text("config_json"),
});
