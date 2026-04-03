import { describe, expect, test } from "bun:test";
import { validateInput } from "../src/db/input";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

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
});
