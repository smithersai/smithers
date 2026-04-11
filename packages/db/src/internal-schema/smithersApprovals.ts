import {
  integer,
  sqliteTable,
  text,
  primaryKey,
} from "drizzle-orm/sqlite-core";

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
