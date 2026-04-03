import {
  blob,
  integer,
  sqliteTable,
  text,
  primaryKey,
} from "drizzle-orm/sqlite-core";

export const smithersRuns = sqliteTable("_smithers_runs", {
  runId: text("run_id").primaryKey(),
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

export const smithersFrames = sqliteTable(
  "_smithers_frames",
  {
    runId: text("run_id").notNull(),
    frameNo: integer("frame_no").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    xmlJson: text("xml_json").notNull(),
    xmlHash: text("xml_hash").notNull(),
    mountedTaskIdsJson: text("mounted_task_ids_json"),
    taskIndexJson: text("task_index_json"),
    note: text("note"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.frameNo] }),
  }),
);

export const smithersApprovals = sqliteTable(
  "_smithers_approvals",
  {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    iteration: integer("iteration").notNull().default(0),
    status: text("status").notNull(),
    requestedAtMs: integer("requested_at_ms"),
    decidedAtMs: integer("decided_at_ms"),
    note: text("note"),
    decidedBy: text("decided_by"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.nodeId, t.iteration] }),
  }),
);

export const smithersCache = sqliteTable("_smithers_cache", {
  cacheKey: text("cache_key").primaryKey(),
  createdAtMs: integer("created_at_ms").notNull(),
  workflowName: text("workflow_name").notNull(),
  nodeId: text("node_id").notNull(),
  outputTable: text("output_table").notNull(),
  schemaSig: text("schema_sig").notNull(),
  agentSig: text("agent_sig"),
  toolsSig: text("tools_sig"),
  jjPointer: text("jj_pointer"),
  payloadJson: text("payload_json").notNull(),
});

export const smithersToolCalls = sqliteTable(
  "_smithers_tool_calls",
  {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    iteration: integer("iteration").notNull().default(0),
    attempt: integer("attempt").notNull(),
    seq: integer("seq").notNull(),
    toolName: text("tool_name").notNull(),
    inputJson: text("input_json"),
    outputJson: text("output_json"),
    startedAtMs: integer("started_at_ms").notNull(),
    finishedAtMs: integer("finished_at_ms"),
    status: text("status").notNull(),
    errorJson: text("error_json"),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.runId, t.nodeId, t.iteration, t.attempt, t.seq],
    }),
  }),
);

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

export { smithersScorers } from "../scorers/schema";

export {
  smithersMemoryFacts,
  smithersMemoryThreads,
  smithersMemoryMessages,
} from "../memory/schema";

export const smithersVectors = sqliteTable("_smithers_vectors", {
  id: text("id").primaryKey(),
  namespace: text("namespace").notNull(),
  content: text("content").notNull(),
  embedding: blob("embedding").notNull(),
  dimensions: integer("dimensions").notNull(),
  metadataJson: text("metadata_json"),
  documentId: text("document_id"),
  chunkIndex: integer("chunk_index"),
  createdAtMs: integer("created_at_ms").notNull(),
});

export const smithersCron = sqliteTable("_smithers_cron", {
  cronId: text("cron_id").primaryKey(),
  pattern: text("pattern").notNull(),
  workflowPath: text("workflow_path").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).default(true),
  createdAtMs: integer("created_at_ms").notNull(),
  lastRunAtMs: integer("last_run_at_ms"),
  nextRunAtMs: integer("next_run_at_ms"),
  errorJson: text("error_json"),
});
