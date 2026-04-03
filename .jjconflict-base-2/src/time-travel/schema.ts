import {
  integer,
  sqliteTable,
  text,
  primaryKey,
} from "drizzle-orm/sqlite-core";

/**
 * Full state snapshot captured at each frame commit.
 * PK: (run_id, frame_no)
 */
export const smithersSnapshots = sqliteTable(
  "_smithers_snapshots",
  {
    runId: text("run_id").notNull(),
    frameNo: integer("frame_no").notNull(),
    nodesJson: text("nodes_json").notNull(),
    outputsJson: text("outputs_json").notNull(),
    ralphJson: text("ralph_json").notNull(),
    inputJson: text("input_json").notNull(),
    vcsPointer: text("vcs_pointer"),
    workflowHash: text("workflow_hash"),
    contentHash: text("content_hash").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.frameNo] }),
  }),
);

/**
 * Parent-child fork relationships between runs.
 * PK: run_id (the child run)
 */
export const smithersBranches = sqliteTable("_smithers_branches", {
  runId: text("run_id").primaryKey(),
  parentRunId: text("parent_run_id").notNull(),
  parentFrameNo: integer("parent_frame_no").notNull(),
  branchLabel: text("branch_label"),
  forkDescription: text("fork_description"),
  createdAtMs: integer("created_at_ms").notNull(),
});

/**
 * VCS revision metadata per snapshot.
 * PK: (run_id, frame_no)
 */
export const smithersVcsTags = sqliteTable(
  "_smithers_vcs_tags",
  {
    runId: text("run_id").notNull(),
    frameNo: integer("frame_no").notNull(),
    vcsType: text("vcs_type").notNull(),
    vcsPointer: text("vcs_pointer").notNull(),
    vcsRoot: text("vcs_root"),
    jjOperationId: text("jj_operation_id"),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.frameNo] }),
  }),
);
