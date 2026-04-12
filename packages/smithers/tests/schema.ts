import { z } from "zod";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const outputSchemas = {
  outputA: z.object({ value: z.number() }),
  outputB: z.object({ value: z.number() }),
  outputC: z.object({ value: z.number() }),
};

export const input = sqliteTable("input", {
  runId: text("run_id").primaryKey(),
  description: text("description"),
});

export const outputA = sqliteTable(
  "output_a",
  {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    iteration: integer("iteration").notNull().default(0),
    value: integer("value"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.nodeId, t.iteration] }),
  }),
);

export const outputB = sqliteTable(
  "output_b",
  {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    iteration: integer("iteration").notNull().default(0),
    value: integer("value"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.nodeId, t.iteration] }),
  }),
);

export const outputC = sqliteTable(
  "output_c",
  {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    iteration: integer("iteration").notNull().default(0),
    value: integer("value"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.nodeId, t.iteration] }),
  }),
);

export const schema = {
  input,
  outputA,
  outputB,
  outputC,
};

export const ddl = `
  CREATE TABLE IF NOT EXISTS input (
    run_id TEXT PRIMARY KEY,
    description TEXT
  );
  CREATE TABLE IF NOT EXISTS output_a (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    value INTEGER,
    PRIMARY KEY (run_id, node_id, iteration)
  );
  CREATE TABLE IF NOT EXISTS output_b (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    value INTEGER,
    PRIMARY KEY (run_id, node_id, iteration)
  );
  CREATE TABLE IF NOT EXISTS output_c (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    value INTEGER,
    PRIMARY KEY (run_id, node_id, iteration)
  );
`;
