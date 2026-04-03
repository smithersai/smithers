import { describe, expect, test } from "bun:test";
import {
  selectOutputRow,
  upsertOutputRow,
  getKeyColumns,
  getAgentOutputSchema,
  validateOutput,
  validateExistingOutput,
} from "../src/db/output";
import { zodToTable } from "../src/zodToTable";
import { zodToCreateTableSQL } from "../src/zodToCreateTableSQL";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

function createTableAndDb(name: string, zodSchema: z.ZodObject<any>) {
  const table = zodToTable(name, zodSchema);
  const sqlite = new Database(":memory:");
  sqlite.exec(zodToCreateTableSQL(name, zodSchema));
  const db = drizzle(sqlite, { schema: { [name]: table } });
  return { table, db, sqlite };
}

describe("output row roundtrip", () => {
  test("upsert then select returns the same data", async () => {
    const { table, db, sqlite } = createTableAndDb(
      "results",
      z.object({ summary: z.string(), score: z.number() }),
    );
    try {
      await upsertOutputRow(db, table, { runId: "r1", nodeId: "n1", iteration: 0 }, {
        summary: "Test result",
        score: 95,
      });

      const row = await selectOutputRow<any>(db, table, {
        runId: "r1",
        nodeId: "n1",
        iteration: 0,
      });

      expect(row).toBeDefined();
      expect(row!.summary).toBe("Test result");
      expect(row!.score).toBe(95);
      expect(row!.runId).toBe("r1");
      expect(row!.nodeId).toBe("n1");
    } finally {
      sqlite.close();
    }
  });

  test("upsert overwrites existing row on conflict", async () => {
    const { table, db, sqlite } = createTableAndDb(
      "results",
      z.object({ value: z.number() }),
    );
    try {
      const key = { runId: "r1", nodeId: "n1", iteration: 0 };
      await upsertOutputRow(db, table, key, { value: 1 });
      await upsertOutputRow(db, table, key, { value: 2 });

      const row = await selectOutputRow<any>(db, table, key);
      expect(row!.value).toBe(2);
    } finally {
      sqlite.close();
    }
  });

  test("select returns undefined for missing row", async () => {
    const { table, db, sqlite } = createTableAndDb(
      "results",
      z.object({ value: z.number() }),
    );
    try {
      const row = await selectOutputRow<any>(db, table, {
        runId: "nonexistent",
        nodeId: "n1",
        iteration: 0,
      });
      expect(row).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  test("multiple rows with different nodeIds", async () => {
    const { table, db, sqlite } = createTableAndDb(
      "results",
      z.object({ label: z.string() }),
    );
    try {
      await upsertOutputRow(
        db,
        table,
        { runId: "r1", nodeId: "a", iteration: 0 },
        { label: "first" },
      );
      await upsertOutputRow(
        db,
        table,
        { runId: "r1", nodeId: "b", iteration: 0 },
        { label: "second" },
      );

      const rowA = await selectOutputRow<any>(db, table, {
        runId: "r1",
        nodeId: "a",
        iteration: 0,
      });
      const rowB = await selectOutputRow<any>(db, table, {
        runId: "r1",
        nodeId: "b",
        iteration: 0,
      });

      expect(rowA!.label).toBe("first");
      expect(rowB!.label).toBe("second");
    } finally {
      sqlite.close();
    }
  });

  test("multiple iterations for same nodeId", async () => {
    const { table, db, sqlite } = createTableAndDb(
      "results",
      z.object({ attempt: z.number() }),
    );
    try {
      await upsertOutputRow(
        db,
        table,
        { runId: "r1", nodeId: "n1", iteration: 0 },
        { attempt: 1 },
      );
      await upsertOutputRow(
        db,
        table,
        { runId: "r1", nodeId: "n1", iteration: 1 },
        { attempt: 2 },
      );

      const row0 = await selectOutputRow<any>(db, table, {
        runId: "r1",
        nodeId: "n1",
        iteration: 0,
      });
      const row1 = await selectOutputRow<any>(db, table, {
        runId: "r1",
        nodeId: "n1",
        iteration: 1,
      });

      expect(row0!.attempt).toBe(1);
      expect(row1!.attempt).toBe(2);
    } finally {
      sqlite.close();
    }
  });
});

describe("getAgentOutputSchema", () => {
  test("strips system columns from schema", () => {
    const { table } = createTableAndDb(
      "test",
      z.object({ title: z.string(), count: z.number() }),
    );
    const agentSchema = getAgentOutputSchema(table);
    const shape = agentSchema.shape;
    expect(shape).toHaveProperty("title");
    expect(shape).toHaveProperty("count");
    expect(shape).not.toHaveProperty("runId");
    expect(shape).not.toHaveProperty("nodeId");
    expect(shape).not.toHaveProperty("iteration");
  });
});

describe("validateOutput edge cases", () => {
  test("validates optional fields", () => {
    const zodSchema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    });
    const { table } = createTableAndDb("test", zodSchema);
    const result = validateOutput(table, {
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      required: "value",
      // optional field omitted
    });
    expect(result.ok).toBe(true);
  });

  test("rejects wrong type for field", () => {
    const zodSchema = z.object({ count: z.number() });
    const { table } = createTableAndDb("test", zodSchema);
    const result = validateOutput(table, {
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      count: "not a number",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});
