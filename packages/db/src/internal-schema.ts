import {
  blob,
  integer,
  sqliteTable,
  text,
  primaryKey,
} from "drizzle-orm/sqlite-core";

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
    heartbeatAtMs: integer("heartbeat_at_ms"),
    heartbeatDataJson: text("heartbeat_data_json"),
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
    encoding: text("encoding").notNull().default("full"),
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
    requestJson: text("request_json"),
    decisionJson: text("decision_json"),
    autoApproved: integer("auto_approved", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.nodeId, t.iteration] }),
  }),
);

export const smithersHumanRequests = sqliteTable("_smithers_human_requests", {
  requestId: text("request_id").primaryKey(),
  runId: text("run_id").notNull(),
  nodeId: text("node_id").notNull(),
  iteration: integer("iteration").notNull().default(0),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  prompt: text("prompt").notNull(),
  schemaJson: text("schema_json"),
  optionsJson: text("options_json"),
  responseJson: text("response_json"),
  requestedAtMs: integer("requested_at_ms").notNull(),
  answeredAtMs: integer("answered_at_ms"),
  answeredBy: text("answered_by"),
  timeoutAtMs: integer("timeout_at_ms"),
});

export const smithersAlerts = sqliteTable("_smithers_alerts", {
  alertId: text("alert_id").primaryKey(),
  runId: text("run_id"),
  policyName: text("policy_name").notNull(),
  severity: text("severity").notNull(),
  status: text("status").notNull(),
  firedAtMs: integer("fired_at_ms").notNull(),
  resolvedAtMs: integer("resolved_at_ms"),
  acknowledgedAtMs: integer("acknowledged_at_ms"),
  message: text("message").notNull(),
  detailsJson: text("details_json"),
});

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

export { smithersScorers } from "@smithers/scorers/schema";

export {
  smithersMemoryFacts,
  smithersMemoryThreads,
  smithersMemoryMessages,
} from "@smithers/memory/schema";

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
