import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { zodSchemaToJsonExample } from "@smithers/react/zod-to-example";

function parseExample(schema: z.ZodObject<any>) {
  return JSON.parse(zodSchemaToJsonExample(schema)) as Record<string, any>;
}

describe("zodSchemaToJsonExample edge cases", () => {
  test("generates example for simple string", () => {
    const schema = z.object({ name: z.string() });
    const example = parseExample(schema);
    expect(example).toBeDefined();
    expect(typeof example.name).toBe("string");
  });

  test("generates example for number", () => {
    const schema = z.object({ count: z.number() });
    const example = parseExample(schema);
    expect(typeof example.count).toBe("number");
  });

  test("generates example for boolean", () => {
    const schema = z.object({ active: z.boolean() });
    const example = parseExample(schema);
    expect(typeof example.active).toBe("boolean");
  });

  test("generates example for enum", () => {
    const schema = z.object({ status: z.enum(["active", "inactive"]) });
    const example = parseExample(schema);
    expect(["active", "inactive"]).toContain(example.status);
  });

  test("generates example for array of strings", () => {
    const schema = z.object({ tags: z.array(z.string()) });
    const example = parseExample(schema);
    expect(Array.isArray(example.tags)).toBe(true);
  });

  test("generates example for nested object", () => {
    const schema = z.object({
      user: z.object({
        name: z.string(),
        age: z.number(),
      }),
    });
    const example = parseExample(schema);
    expect(typeof example.user).toBe("object");
    expect(typeof example.user.name).toBe("string");
    expect(typeof example.user.age).toBe("number");
  });

  test("handles optional fields", () => {
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    });
    const example = parseExample(schema);
    expect(typeof example.required).toBe("string");
    // Optional may or may not be present
  });

  test("handles nullable fields", () => {
    const schema = z.object({
      nullable: z.string().nullable(),
    });
    const example = parseExample(schema);
    // Should generate some value (string or null)
    expect(example).toHaveProperty("nullable");
  });

  test("handles description as example hint", () => {
    const schema = z.object({
      email: z.string().describe("user@example.com"),
    });
    const example = parseExample(schema);
    expect(typeof example.email).toBe("string");
  });

  test("generates example for complex schema", () => {
    const schema = z.object({
      title: z.string(),
      score: z.number(),
      tags: z.array(z.string()),
      metadata: z.object({
        created: z.string(),
        active: z.boolean(),
      }),
    });
    const example = parseExample(schema);
    expect(typeof example.title).toBe("string");
    expect(typeof example.score).toBe("number");
    expect(Array.isArray(example.tags)).toBe(true);
    expect(typeof example.metadata.created).toBe("string");
    expect(typeof example.metadata.active).toBe("boolean");
  });
});
