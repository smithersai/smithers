import { describe, expect, test } from "bun:test";
import { zodV3ToJsonSchema } from "../src/zodV3Compat";

// Simulate Zod v3 schemas (which use _def with typeName)
function makeV3(typeName: string, extra: Record<string, any> = {}) {
  return { _def: { typeName, ...extra } };
}

describe("zodV3ToJsonSchema", () => {
  test("handles null/undefined input", () => {
    expect(zodV3ToJsonSchema(null)).toEqual({ type: "object" });
    expect(zodV3ToJsonSchema(undefined)).toEqual({ type: "object" });
  });

  test("handles schema without _def", () => {
    expect(zodV3ToJsonSchema({})).toEqual({ type: "object" });
  });

  test("converts ZodString", () => {
    expect(zodV3ToJsonSchema(makeV3("ZodString"))).toEqual({ type: "string" });
  });

  test("converts ZodNumber", () => {
    expect(zodV3ToJsonSchema(makeV3("ZodNumber"))).toEqual({ type: "number" });
  });

  test("converts ZodBoolean", () => {
    expect(zodV3ToJsonSchema(makeV3("ZodBoolean"))).toEqual({ type: "boolean" });
  });

  test("converts ZodArray with inner type", () => {
    const innerType = makeV3("ZodString");
    const result = zodV3ToJsonSchema(makeV3("ZodArray", { type: innerType }));
    expect(result).toEqual({ type: "array", items: { type: "string" } });
  });

  test("converts ZodArray without inner type", () => {
    const result = zodV3ToJsonSchema(makeV3("ZodArray", {}));
    expect(result).toEqual({ type: "array", items: {} });
  });

  test("converts ZodEnum", () => {
    const result = zodV3ToJsonSchema(makeV3("ZodEnum", { values: ["a", "b", "c"] }));
    expect(result).toEqual({ type: "string", enum: ["a", "b", "c"] });
  });

  test("converts ZodLiteral", () => {
    const result = zodV3ToJsonSchema(makeV3("ZodLiteral", { value: "hello" }));
    expect(result).toEqual({ const: "hello" });
  });

  test("converts ZodOptional (unwraps inner)", () => {
    const inner = makeV3("ZodNumber");
    const result = zodV3ToJsonSchema(makeV3("ZodOptional", { innerType: inner }));
    expect(result).toEqual({ type: "number" });
  });

  test("converts ZodDefault (includes default value)", () => {
    const inner = makeV3("ZodString");
    const result = zodV3ToJsonSchema(makeV3("ZodDefault", { innerType: inner, defaultValue: () => "fallback" }));
    expect(result).toEqual({ type: "string", default: "fallback" });
  });

  test("converts ZodNullable", () => {
    const inner = makeV3("ZodString");
    const result = zodV3ToJsonSchema(makeV3("ZodNullable", { innerType: inner }));
    expect(result).toEqual({ type: "string", nullable: true });
  });

  test("converts ZodUnion", () => {
    const options = [makeV3("ZodString"), makeV3("ZodNumber")];
    const result = zodV3ToJsonSchema(makeV3("ZodUnion", { options }));
    expect(result).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
  });

  test("converts ZodObject with required and optional fields", () => {
    const shape = {
      name: makeV3("ZodString"),
      age: makeV3("ZodNumber"),
      bio: makeV3("ZodOptional", { innerType: makeV3("ZodString") }),
      role: makeV3("ZodDefault", { innerType: makeV3("ZodString"), defaultValue: () => "user" }),
    };
    const schema = makeV3("ZodObject", { shape: () => shape });
    const result = zodV3ToJsonSchema(schema);

    expect(result.type).toBe("object");
    expect(result.properties.name).toEqual({ type: "string" });
    expect(result.properties.age).toEqual({ type: "number" });
    expect(result.properties.bio).toEqual({ type: "string" });
    expect(result.properties.role).toEqual({ type: "string", default: "user" });
    expect(result.required).toEqual(["name", "age"]);
  });

  test("converts ZodObject with shape as property (not function) via schema.shape fallback", () => {
    // Zod v3 uses _def.shape() as a function; if the _def.shape is not present
    // but schema.shape is, it falls back
    const schema = {
      _def: { typeName: "ZodObject" },
      shape: { x: makeV3("ZodNumber") },
    };
    const result = zodV3ToJsonSchema(schema);
    expect(result.type).toBe("object");
    expect(result.properties.x).toEqual({ type: "number" });
  });

  test("converts ZodObject with no required fields omits required array", () => {
    const shape = {
      opt: makeV3("ZodOptional", { innerType: makeV3("ZodString") }),
    };
    const result = zodV3ToJsonSchema(makeV3("ZodObject", { shape: () => shape }));
    expect(result.required).toBeUndefined();
  });

  test("converts nested ZodObject", () => {
    const inner = makeV3("ZodObject", {
      shape: () => ({ val: makeV3("ZodNumber") }),
    });
    const outer = makeV3("ZodObject", {
      shape: () => ({ nested: inner }),
    });
    const result = zodV3ToJsonSchema(outer);
    expect(result.properties.nested).toEqual({
      type: "object",
      properties: { val: { type: "number" } },
      required: ["val"],
    });
  });

  test("returns empty object for unknown type", () => {
    expect(zodV3ToJsonSchema(makeV3("ZodSomethingNew"))).toEqual({});
  });
});
