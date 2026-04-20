import { describe, expect, test } from "bun:test";
import { getKeyColumns, buildKeyWhere, validateOutput, validateExistingOutput, getAgentOutputSchema, describeSchemaShape, } from "../src/output.js";
import { zodToTable } from "../src/zodToTable.js";
import { zodToCreateTableSQL } from "../src/zodToCreateTableSQL.js";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
/**
 * @param {string} name
 * @param {z.ZodObject<any>} schema
 */
function createTableAndDb(name, schema) {
    const table = zodToTable(name, schema);
    const sqlite = new Database(":memory:");
    sqlite.exec(zodToCreateTableSQL(name, schema));
    const db = drizzle(sqlite, { schema: { [name]: table } });
    return { table, db, sqlite };
}
describe("getKeyColumns", () => {
    test("returns key columns from standard table", () => {
        const { table } = createTableAndDb("test", z.object({ val: z.string() }));
        const keys = getKeyColumns(table);
        expect(keys.runId).toBeDefined();
        expect(keys.nodeId).toBeDefined();
        expect(keys.iteration).toBeDefined();
    });
});
describe("validateOutput", () => {
    test("valid output passes validation", () => {
        const schema = z.object({ title: z.string() });
        const { table } = createTableAndDb("test", schema);
        const result = validateOutput(table, {
            runId: "r1",
            nodeId: "n1",
            iteration: 0,
            title: "hello",
        });
        expect(result.ok).toBe(true);
        expect(result.data).toBeDefined();
    });
    test("invalid output fails validation", () => {
        const schema = z.object({ title: z.string() });
        const { table } = createTableAndDb("test", schema);
        const result = validateOutput(table, {
            runId: "r1",
            nodeId: "n1",
            iteration: 0,
            title: 123, // wrong type
        });
        expect(result.ok).toBe(false);
        expect(result.error).toBeDefined();
    });
});
describe("validateExistingOutput", () => {
    test("valid existing output passes", () => {
        const schema = z.object({ value: z.number() });
        const { table } = createTableAndDb("test", schema);
        const result = validateExistingOutput(table, {
            runId: "r1",
            nodeId: "n1",
            iteration: 0,
            value: 42,
        });
        expect(result.ok).toBe(true);
    });
});
describe("getAgentOutputSchema", () => {
    test("removes system columns", () => {
        const schema = z.object({
            title: z.string(),
            score: z.number(),
        });
        const { table } = createTableAndDb("test", schema);
        const agentSchema = getAgentOutputSchema(table);
        const shape = agentSchema.shape;
        expect(shape).not.toHaveProperty("runId");
        expect(shape).not.toHaveProperty("nodeId");
        expect(shape).not.toHaveProperty("iteration");
        expect(shape).toHaveProperty("title");
        expect(shape).toHaveProperty("score");
    });
});
describe("describeSchemaShape", () => {
    test("describes Zod schema fields", () => {
        const schema = z.object({
            name: z.string(),
            count: z.number(),
        });
        const description = describeSchemaShape(schema);
        expect(typeof description).toBe("string");
        const parsed = JSON.parse(description);
        expect(parsed).toBeDefined();
    });
  test("describes Drizzle table via agent schema", () => {
    const zodSchema = z.object({ summary: z.string() });
    const { table } = createTableAndDb("test", zodSchema);
    const description = describeSchemaShape(table);
    expect(typeof description).toBe("string");
  });

  test("describes arrays and booleans with concrete types", () => {
    const schema = z.object({
      summary: z.string(),
      filesChanged: z.array(z.string()),
      testsWritten: z.array(z.string()),
      testRunOutput: z.string(),
      allTestsPassing: z.boolean(),
    });

    const description = describeSchemaShape(schema);
    const parsed = JSON.parse(description);

    expect(parsed.properties.filesChanged.type).toBe("array");
    expect(parsed.properties.filesChanged.items.type).toBe("string");
    expect(parsed.properties.testsWritten.type).toBe("array");
    expect(parsed.properties.testsWritten.items.type).toBe("string");
    expect(parsed.properties.allTestsPassing.type).toBe("boolean");
  });
});
