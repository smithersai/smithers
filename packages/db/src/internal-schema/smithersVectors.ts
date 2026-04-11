import {
  blob,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

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
