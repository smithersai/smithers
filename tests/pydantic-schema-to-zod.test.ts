import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { pydanticSchemaToZod } from "../src/external/json-schema-to-zod";
import { zodToTable } from "../src/zodToTable";
import { zodToCreateTableSQL } from "../src/zodToCreateTableSQL";

describe("pydanticSchemaToZod", () => {
  test("basic types: string, int, float, bool", () => {
    const schema = pydanticSchemaToZod({
      type: "object",
      properties: {
        name: { type: "string", title: "Name" },
        age: { type: "integer", title: "Age" },
        height: { type: "number", title: "Height" },
        active: { type: "boolean", title: "Active" },
      },
      required: ["name", "age", "height", "active"],
      title: "Person",
    });

    const result = schema.parse({
      name: "Alice",
      age: 30,
      height: 5.6,
      active: true,
    });
    expect(result.name).toBe("Alice");
    expect(result.age).toBe(30);
    expect(result.height).toBe(5.6);
    expect(result.active).toBe(true);
  });

  test("array of strings", () => {
    const schema = pydanticSchemaToZod({
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["tags"],
    });

    const result = schema.parse({ tags: ["a", "b", "c"] });
    expect(result.tags).toEqual(["a", "b", "c"]);
  });

  test("enum", () => {
    const schema = pydanticSchemaToZod({
      type: "object",
      properties: {
        severity: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["severity"],
    });

    expect(schema.parse({ severity: "high" }).severity).toBe("high");
    expect(() => schema.parse({ severity: "invalid" })).toThrow();
  });

  test("optional via anyOf + null (Pydantic pattern) → nullable", () => {
    const schema = pydanticSchemaToZod({
      type: "object",
      properties: {
        note: {
          anyOf: [{ type: "string" }, { type: "null" }],
          default: null,
        },
      },
      required: ["note"],
    });

    expect(schema.parse({ note: "hello" }).note).toBe("hello");
    expect(schema.parse({ note: null }).note).toBeNull();
  });

  test("nested object via $defs + $ref", () => {
    // Pydantic pattern for nested models
    const schema = pydanticSchemaToZod({
      type: "object",
      properties: {
        author: { $ref: "#/$defs/Author" },
      },
      required: ["author"],
      $defs: {
        Author: {
          type: "object",
          properties: {
            name: { type: "string" },
            email: { type: "string" },
          },
          required: ["name", "email"],
        },
      },
    });

    const result = schema.parse({
      author: { name: "Alice", email: "alice@example.com" },
    });
    expect(result.author.name).toBe("Alice");
  });

  test("optional field (not in required) → .optional()", () => {
    const schema = pydanticSchemaToZod({
      type: "object",
      properties: {
        name: { type: "string" },
        nickname: { type: "string" },
      },
      required: ["name"],
      // nickname is NOT required → .optional()
    });

    expect(schema.parse({ name: "Alice" })).toEqual({ name: "Alice" });
    expect(schema.parse({ name: "Alice", nickname: "Al" }).nickname).toBe("Al");
  });

  test("array of objects", () => {
    const schema = pydanticSchemaToZod({
      type: "object",
      properties: {
        issues: {
          type: "array",
          items: {
            type: "object",
            properties: {
              file: { type: "string" },
              line: { type: "integer" },
            },
            required: ["file", "line"],
          },
        },
      },
      required: ["issues"],
    });

    const result = schema.parse({
      issues: [{ file: "main.ts", line: 42 }],
    });
    expect(result.issues[0].file).toBe("main.ts");
  });

  test("round-trip: zodToTable produces correct column types", () => {
    const schema = pydanticSchemaToZod({
      type: "object",
      properties: {
        summary: { type: "string" },
        count: { type: "integer" },
        score: { type: "number" },
        passed: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["summary", "count", "score", "passed", "tags"],
    });

    // Should not throw — schema is a valid ZodObject
    const table = zodToTable("test_output", schema);
    expect(table).toBeDefined();

    // SQL should have correct column types
    const sql = zodToCreateTableSQL("test_output", schema);
    expect(sql).toContain('"summary" TEXT');
    expect(sql).toContain('"count" INTEGER');
    expect(sql).toContain('"score" INTEGER'); // number → INTEGER in sqlite
    expect(sql).toContain('"passed" INTEGER'); // boolean → INTEGER
    expect(sql).toContain('"tags" TEXT');      // array → TEXT (json)
  });

  test("real Pydantic output: Research model", () => {
    // This is what Pydantic v2 actually outputs for:
    // class Research(BaseModel):
    //     summary: str
    //     key_points: list[str]
    //     confidence: float
    //     notes: Optional[str] = None
    const schema = pydanticSchemaToZod({
      type: "object",
      properties: {
        summary: { type: "string", title: "Summary" },
        key_points: {
          items: { type: "string" },
          title: "Key Points",
          type: "array",
        },
        confidence: { title: "Confidence", type: "number" },
        notes: {
          anyOf: [{ type: "string" }, { type: "null" }],
          default: null,
          title: "Notes",
        },
      },
      required: ["summary", "key_points", "confidence", "notes"],
      title: "Research",
    });

    const result = schema.parse({
      summary: "AI is transforming software",
      key_points: ["LLMs", "orchestration"],
      confidence: 0.95,
      notes: null,
    });
    expect(result.summary).toBe("AI is transforming software");
    expect(result.key_points).toEqual(["LLMs", "orchestration"]);
    expect(result.notes).toBeNull();

    // Table should map correctly
    const sql = zodToCreateTableSQL("research", schema);
    expect(sql).toContain('"summary" TEXT');
    expect(sql).toContain('"key_points" TEXT'); // array → json text
    expect(sql).toContain('"confidence" INTEGER');
  });
});
