import { describe, expect, test } from "bun:test";
import { isRef, resolveRef, deref } from "../src/openapi/ref-resolver";

// ---------------------------------------------------------------------------
// isRef — type guard for $ref objects
// ---------------------------------------------------------------------------

describe("isRef", () => {
  test("returns true for valid $ref object", () => {
    expect(isRef({ $ref: "#/components/schemas/Foo" })).toBe(true);
  });

  test("returns false for non-object", () => {
    expect(isRef(null)).toBe(false);
    expect(isRef(undefined)).toBe(false);
    expect(isRef("string")).toBe(false);
    expect(isRef(42)).toBe(false);
  });

  test("returns false for object without $ref", () => {
    expect(isRef({ type: "string" })).toBe(false);
    expect(isRef({})).toBe(false);
  });

  test("returns false when $ref is not a string", () => {
    expect(isRef({ $ref: 42 })).toBe(false);
    expect(isRef({ $ref: null })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveRef — JSON pointer resolution
// ---------------------------------------------------------------------------

describe("resolveRef", () => {
  const spec = {
    components: {
      schemas: {
        User: {
          type: "object",
          properties: { name: { type: "string" } },
        },
        "Complex/Name": {
          type: "object",
          properties: { id: { type: "integer" } },
        },
      },
      parameters: {
        PageSize: { in: "query", name: "pageSize", schema: { type: "integer" } },
      },
    },
  } as any;

  test("resolves simple schema reference", () => {
    const result = resolveRef(spec, "#/components/schemas/User");
    expect(result).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
    });
  });

  test("resolves parameter reference", () => {
    const result = resolveRef<{ name: string }>(
      spec,
      "#/components/parameters/PageSize",
    );
    expect(result.name).toBe("pageSize");
  });

  test("handles ~1 encoding for forward slash in path", () => {
    const result = resolveRef(spec, "#/components/schemas/Complex~1Name");
    expect(result).toEqual({
      type: "object",
      properties: { id: { type: "integer" } },
    });
  });

  test("throws for non-local reference (no #/ prefix)", () => {
    expect(() => resolveRef(spec, "external.yaml#/Foo")).toThrow(
      "Unsupported $ref format",
    );
  });

  test("throws for unresolvable path", () => {
    expect(() =>
      resolveRef(spec, "#/components/schemas/DoesNotExist"),
    ).toThrow("Could not resolve $ref");
  });

  test("resolves to root-level properties", () => {
    const specWithInfo = { info: { title: "My API", version: "1.0" } } as any;
    const result = resolveRef<{ title: string; version: string }>(
      specWithInfo,
      "#/info",
    );
    expect(result.title).toBe("My API");
  });
});

// ---------------------------------------------------------------------------
// deref — one-level indirection resolver
// ---------------------------------------------------------------------------

describe("deref", () => {
  const spec = {
    components: {
      schemas: {
        Pet: { type: "object", properties: { breed: { type: "string" } } },
      },
    },
  } as any;

  test("resolves $ref to referenced schema", () => {
    const result = deref<{
      type: string;
      properties: { breed: { type: string } };
    }>(spec, { $ref: "#/components/schemas/Pet" });
    expect(result).toEqual({
      type: "object",
      properties: { breed: { type: "string" } },
    });
  });

  test("returns non-ref value as-is", () => {
    const schema = { type: "string", maxLength: 100 };
    const result = deref(spec, schema as any);
    expect(result).toBe(schema);
  });

  test("returns primitive values as-is", () => {
    expect(deref(spec, "hello" as any)).toBe("hello");
    expect(deref(spec, 42 as any)).toBe(42);
  });
});
