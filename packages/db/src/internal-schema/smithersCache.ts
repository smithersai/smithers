import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
