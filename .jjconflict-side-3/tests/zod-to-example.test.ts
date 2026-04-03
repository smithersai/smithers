import { describe, expect, test } from "bun:test";
import { zodSchemaToJsonExample } from "../src/zod-to-example";
import { z } from "zod";

describe("zodSchemaToJsonExample", () => {
  test("generates example for string field", () => {
    const schema = z.object({ name: z.string() });
    const result = JSON.parse(zodSchemaToJsonExample(schema));
    expect(result.name).toBe("string");
  });

  test("generates example for number field", () => {
    const schema = z.object({ count: z.number() });
    const result = JSON.parse(zodSchemaToJsonExample(schema));
    expect(result.count).toBe(0);
  });

  test("generates example for boolean field", () => {
    const schema = z.object({ active: z.boolean() });
    const result = JSON.parse(zodSchemaToJsonExample(schema));
    expect(result.active).toBe(false);
  });

  test("generates example for array field", () => {
    const schema = z.object({ tags: z.array(z.string()) });
    const result = JSON.parse(zodSchemaToJsonExample(schema));
    expect(Array.isArray(result.tags)).toBe(true);
  });

  test("generates example for enum field", () => {
    const schema = z.object({ status: z.enum(["active", "inactive"]) });
    const result = JSON.parse(zodSchemaToJsonExample(schema));
    expect(result.status).toBe("active");
  });

  test("generates example for nested object", () => {
    const schema = z.object({
      meta: z.object({ key: z.string(), val: z.number() }),
    });
    const result = JSON.parse(zodSchemaToJsonExample(schema));
    expect(result.meta).toBeObject();
    expect(result.meta.key).toBe("string");
    expect(result.meta.val).toBe(0);
  });

  test("generates example for nullable field", () => {
    const schema = z.object({ name: z.string().nullable() });
    const result = JSON.parse(zodSchemaToJsonExample(schema));
    // Should unwrap to the inner type example
    expect(typeof result.name).toBe("string");
  });

  test("generates example for optional field", () => {
    const schema = z.object({ name: z.string().optional() });
    const result = JSON.parse(zodSchemaToJsonExample(schema));
    expect(typeof result.name).toBe("string");
  });

  test("uses description as string value when available", () => {
    const schema = z.object({
      name: z.string().describe("The user's full name"),
    });
    const result = JSON.parse(zodSchemaToJsonExample(schema));
    expect(result.name).toBe("The user's full name");
  });

  test("generates example for complex schema", () => {
    const schema = z.object({
      title: z.string(),
      priority: z.number(),
      done: z.boolean(),
      tags: z.array(z.string()),
      metadata: z.object({ source: z.string() }),
    });
    const result = JSON.parse(zodSchemaToJsonExample(schema));
    expect(result).toHaveProperty("title");
    expect(result).toHaveProperty("priority");
    expect(result).toHaveProperty("done");
    expect(result).toHaveProperty("tags");
    expect(result).toHaveProperty("metadata");
  });

  test("produces valid JSON output", () => {
    const schema = z.object({
      a: z.string(),
      b: z.number(),
      c: z.boolean(),
    });
    const jsonStr = zodSchemaToJsonExample(schema);
    expect(() => JSON.parse(jsonStr)).not.toThrow();
  });

  test("handles empty object schema", () => {
    const schema = z.object({});
    const result = JSON.parse(zodSchemaToJsonExample(schema));
    expect(result).toEqual({});
  });
});
