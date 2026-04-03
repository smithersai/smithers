import {
  integer,
  sqliteTable,
  text,
  primaryKey,
} from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// Memory Facts -- (namespace, key) primary key
// ---------------------------------------------------------------------------

export const smithersMemoryFacts = sqliteTable(
  "_smithers_memory_facts",
  {
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    valueJson: text("value_json").notNull(),
    schemaSig: text("schema_sig"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    ttlMs: integer("ttl_ms"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.namespace, t.key] }),
  }),
);

// ---------------------------------------------------------------------------
// Memory Threads
// ---------------------------------------------------------------------------

export const smithersMemoryThreads = sqliteTable("_smithers_memory_threads", {
  threadId: text("thread_id").primaryKey(),
  namespace: text("namespace").notNull(),
  title: text("title"),
  metadataJson: text("metadata_json"),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

// ---------------------------------------------------------------------------
// Memory Messages
// ---------------------------------------------------------------------------

export const smithersMemoryMessages = sqliteTable("_smithers_memory_messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  role: text("role").notNull(),
  contentJson: text("content_json").notNull(),
  runId: text("run_id"),
  nodeId: text("node_id"),
  createdAtMs: integer("created_at_ms").notNull(),
});
