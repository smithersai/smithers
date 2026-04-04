import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { zodToOpenAISchema, sanitizeForOpenAI } from "../src/agents/schema";

describe("zodToOpenAISchema", () => {
  test("basic object schema is unchanged", async () => {
    const schema = z.object({ name: z.string() });
    const result = await zodToOpenAISchema(schema);
    expect(result.type).toBe("object");
    expect((result.properties as any)?.name?.type).toBe("string");
  });

  test("passthrough object has type: object", async () => {
    const schema = z.object({ document: z.string() }).passthrough();
    const result = await zodToOpenAISchema(schema);
    expect(result.type).toBe("object");
    expect(result.additionalProperties).toBeDefined();
  });

  test("nested passthrough objects all have type: object", async () => {
    const inner = z.object({ value: z.number() }).passthrough();
    const schema = z.object({ nested: inner }).passthrough();
    const result = await zodToOpenAISchema(schema);
    expect(result.type).toBe("object");
    const nested = (result.properties as any)?.nested;
    expect(nested?.type).toBe("object");
  });

  test("array items with passthrough are fixed", async () => {
    const item = z.object({ id: z.string() }).passthrough();
    const schema = z.object({ items: z.array(item) });
    const result = await zodToOpenAISchema(schema);
    const itemSchema = (result.properties as any)?.items?.items;
    expect(itemSchema?.type).toBe("object");
  });
});

describe("sanitizeForOpenAI", () => {
  test("adds type: object when additionalProperties present but type missing", () => {
    const schema: Record<string, unknown> = {
      additionalProperties: true,
      properties: { foo: { type: "string" } },
    };
    sanitizeForOpenAI(schema);
    expect(schema.type).toBe("object");
  });

  test("does not overwrite existing type", () => {
    const schema: Record<string, unknown> = {
      type: "object",
      additionalProperties: true,
    };
    sanitizeForOpenAI(schema);
    expect(schema.type).toBe("object");
  });

  test("coerces empty object additionalProperties to true", () => {
    const schema: Record<string, unknown> = {
      type: "object",
      additionalProperties: {},
    };
    sanitizeForOpenAI(schema);
    expect(schema.additionalProperties).toBe(true);
  });

  test("leaves non-empty additionalProperties schema alone", () => {
    const subSchema = { type: "string" };
    const schema: Record<string, unknown> = {
      type: "object",
      additionalProperties: subSchema,
    };
    sanitizeForOpenAI(schema);
    expect(schema.additionalProperties).toEqual({ type: "string" });
  });

  test("recursively fixes deeply nested schemas", () => {
    const schema = {
      type: "object" as const,
      properties: {
        level1: {
          properties: {
            level2: {
              additionalProperties: true,
              properties: { deep: { type: "string" } },
            },
          },
        },
      },
    };
    sanitizeForOpenAI(schema);
    expect((schema.properties.level1.properties.level2 as any).type).toBe("object");
  });

  test("handles null and primitive values without throwing", () => {
    expect(() => sanitizeForOpenAI(null)).not.toThrow();
    expect(() => sanitizeForOpenAI(undefined)).not.toThrow();
    expect(() => sanitizeForOpenAI("string")).not.toThrow();
    expect(() => sanitizeForOpenAI(42)).not.toThrow();
  });
});
