import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
export const smithersNodeDiffs = sqliteTable("_smithers_node_diffs", {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    iteration: integer("iteration").notNull(),
    baseRef: text("base_ref").notNull(),
    diffJson: text("diff_json").notNull(),
    computedAtMs: integer("computed_at_ms").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
}, (t) => ({
    pk: primaryKey({ columns: [t.runId, t.nodeId, t.iteration, t.baseRef] }),
}));
