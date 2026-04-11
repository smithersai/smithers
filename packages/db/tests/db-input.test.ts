import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { validateInput } from "../src/input";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { zodToTable } from "../src/zodToTable";

describe("validateInput", () => {
  const inputTable = sqliteTable("input", {
    runId: text("run_id").primaryKey(),
    description: text("description"),
  });

  test("valid input passes", () => {
    const result = validateInput(inputTable, {
      runId: "r1",
      description: "test",
    });
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
  });

  test("input with missing optional field passes", () => {
    const result = validateInput(inputTable, {
      runId: "r1",
    });
    expect(result.ok).toBe(true);
  });

  test("input with wrong type fails", () => {
    const result = validateInput(inputTable, {
      runId: 123, // should be string
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("structured input table from zodToTable({ isInput }) validates without nodeId", () => {
    const structuredInput = zodToTable(
      "input",
      z.object({ description: z.string(), count: z.number() }),
      { isInput: true },
    );
    const result = validateInput(structuredInput, {
      runId: "r1",
      description: "hello",
      count: 5,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
  });

  test("structured input table does not require nodeId or iteration", () => {
    const structuredInput = zodToTable(
      "input",
      z.object({ title: z.string() }),
      { isInput: true },
    );
    // Should pass without nodeId/iteration — they are not columns on input tables
    const result = validateInput(structuredInput, {
      runId: "r1",
      title: "test",
    });
    expect(result.ok).toBe(true);
  });
});
