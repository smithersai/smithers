import {
  integer,
  sqliteTable,
  text,
  primaryKey,
} from "drizzle-orm/sqlite-core";

export const smithersRuns = sqliteTable("_smithers_runs", {
  runId: text("run_id").primaryKey(),
  workflowName: text("workflow_name").notNull(),
  workflowPath: text("workflow_path"),
  status: text("status").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  startedAtMs: integer("started_at_ms"),
  finishedAtMs: integer("finished_at_ms"),
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
    pk: primaryKey({ columns: [t.runId, t.nodeId, t.iteration, t.attempt, t.seq] }),
  }),
);

export const smithersEvents = sqliteTable("_smithers_events", {
  runId: text("run_id").notNull(),
  seq: integer("seq").notNull(),
  timestampMs: integer("timestamp_ms").notNull(),
  type: text("type").notNull(),
  payloadJson: text("payload_json").notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.runId, t.seq] }),
}));
