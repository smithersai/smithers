// ---------------------------------------------------------------------------
// OpenAPI JSON Schema → Zod conversion tests
// ---------------------------------------------------------------------------

import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { jsonSchemaToZod, buildOperationSchema } from "../../src/openapi/schema-converter";
import type { OpenApiSpec, SchemaObject, ParameterObject, RequestBodyObject } from "../../src/openapi/types";

const emptySpec: OpenApiSpec = {
  openapi: "3.0.0",
  info: { title: "Test", version: "1.0.0" },
  paths: {},
};

describe("jsonSchemaToZod", () => {
  test("converts string type", () => {
    const schema = jsonSchemaToZod({ type: "string" }, emptySpec);
    expect(schema.parse("hello")).toBe("hello");
    expect(() => schema.parse(123)).toThrow();
  });

  test("converts string with description", () => {
    const schema = jsonSchemaToZod(
      { type: "string", description: "A name" },
      emptySpec,
    );
    expect(schema.parse("foo")).toBe("foo");
  });

  test("converts string with enum", () => {
    const schema = jsonSchemaToZod(
      { type: "string", enum: ["red", "green", "blue"] },
      emptySpec,
    );
    expect(schema.parse("red")).toBe("red");
    expect(() => schema.parse("purple")).toThrow();
  });

  test("converts string with minLength/maxLength", () => {
    const schema = jsonSchemaToZod(
      { type: "string", minLength: 2, maxLength: 5 },
      emptySpec,
    );
    expect(schema.parse("abc")).toBe("abc");
    expect(() => schema.parse("a")).toThrow();
    expect(() => schema.parse("toolong")).toThrow();
  });

  test("converts integer type", () => {
    const schema = jsonSchemaToZod({ type: "integer" }, emptySpec);
    expect(schema.parse(42)).toBe(42);
    expect(() => schema.parse(3.14)).toThrow();
  });

  test("converts number type", () => {
    const schema = jsonSchemaToZod({ type: "number" }, emptySpec);
    expect(schema.parse(3.14)).toBe(3.14);
    expect(schema.parse(42)).toBe(42);
  });

  test("converts number with min/max", () => {
    const schema = jsonSchemaToZod(
      { type: "number", minimum: 0, maximum: 100 },
      emptySpec,
    );
    expect(schema.parse(50)).toBe(50);
    expect(() => schema.parse(-1)).toThrow();
    expect(() => schema.parse(101)).toThrow();
  });

  test("converts boolean type", () => {
    const schema = jsonSchemaToZod({ type: "boolean" }, emptySpec);
    expect(schema.parse(true)).toBe(true);
    expect(schema.parse(false)).toBe(false);
    expect(() => schema.parse("true")).toThrow();
  });

  test("converts array type", () => {
    const schema = jsonSchemaToZod(
      { type: "array", items: { type: "string" } },
      emptySpec,
    );
    expect(schema.parse(["a", "b"])).toEqual(["a", "b"]);
    expect(() => schema.parse([1, 2])).toThrow();
  });

  test("converts object type", () => {
    const schema = jsonSchemaToZod(
      {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          age: { type: "integer" },
        },
      },
      emptySpec,
    );
    expect(schema.parse({ name: "Alice", age: 30 })).toEqual({
      name: "Alice",
      age: 30,
    });
    expect(schema.parse({ name: "Bob" })).toEqual({ name: "Bob" });
    expect(() => schema.parse({ age: 30 })).toThrow();
  });

  test("converts nullable type", () => {
    const schema = jsonSchemaToZod(
      { type: "string", nullable: true },
      emptySpec,
    );
    expect(schema.parse("hello")).toBe("hello");
    expect(schema.parse(null)).toBe(null);
  });

  test("converts schema with default", () => {
    const schema = jsonSchemaToZod(
      { type: "integer", default: 10 },
      emptySpec,
    );
    expect(schema.parse(undefined)).toBe(10);
    expect(schema.parse(5)).toBe(5);
  });

  test("resolves $ref", () => {
    const spec: OpenApiSpec = {
      openapi: "3.0.0",
      info: { title: "Test", version: "1.0.0" },
      components: {
        schemas: {
          Pet: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string" },
            },
          },
        },
      },
      paths: {},
    };
    const schema = jsonSchemaToZod({ $ref: "#/components/schemas/Pet" }, spec);
    expect(schema.parse({ name: "Fido" })).toEqual({ name: "Fido" });
    expect(() => schema.parse({})).toThrow();
  });

  test("handles undefined schema as z.any()", () => {
    const schema = jsonSchemaToZod(undefined, emptySpec);
    expect(schema.parse("anything")).toBe("anything");
    expect(schema.parse(42)).toBe(42);
  });

  test("handles unknown type as z.any()", () => {
    const schema = jsonSchemaToZod(
      { description: "mysterious" } as SchemaObject,
      emptySpec,
    );
    expect(schema.parse("anything")).toBe("anything");
  });

  test("handles nested objects", () => {
    const schema = jsonSchemaToZod(
      {
        type: "object",
        properties: {
          address: {
            type: "object",
            required: ["street"],
            properties: {
              street: { type: "string" },
              city: { type: "string" },
            },
          },
        },
      },
      emptySpec,
    );
    expect(
      schema.parse({ address: { street: "123 Main St", city: "NYC" } }),
    ).toEqual({ address: { street: "123 Main St", city: "NYC" } });
  });

  test("handles array of objects", () => {
    const schema = jsonSchemaToZod(
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "integer" },
            name: { type: "string" },
          },
        },
      },
      emptySpec,
    );
    expect(
      schema.parse([
        { id: 1, name: "A" },
        { id: 2, name: "B" },
      ]),
    ).toEqual([
      { id: 1, name: "A" },
      { id: 2, name: "B" },
    ]);
  });
});

describe("buildOperationSchema", () => {
  test("builds schema from path + query parameters", () => {
    const params: ParameterObject[] = [
      { name: "petId", in: "path", required: true, schema: { type: "string" } },
      { name: "limit", in: "query", schema: { type: "integer" } },
    ];
    const schema = buildOperationSchema(params, undefined, emptySpec);
    expect(schema.parse({ petId: "123" })).toEqual({ petId: "123" });
    expect(schema.parse({ petId: "123", limit: 10 })).toEqual({
      petId: "123",
      limit: 10,
    });
    expect(() => schema.parse({})).toThrow();
  });

  test("builds schema with request body", () => {
    const requestBody: RequestBodyObject = {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string" },
              tag: { type: "string" },
            },
          },
        },
      },
    };
    const schema = buildOperationSchema([], requestBody, emptySpec);
    expect(schema.parse({ body: { name: "Fido" } })).toEqual({
      body: { name: "Fido" },
    });
  });

  test("builds schema with both params and body", () => {
    const params: ParameterObject[] = [
      { name: "ownerId", in: "path", required: true, schema: { type: "string" } },
    ];
    const requestBody: RequestBodyObject = {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string" },
            },
          },
        },
      },
    };
    const schema = buildOperationSchema(params, requestBody, emptySpec);
    expect(
      schema.parse({ ownerId: "owner1", body: { name: "Rex" } }),
    ).toEqual({ ownerId: "owner1", body: { name: "Rex" } });
  });

  test("returns empty object schema when no params or body", () => {
    const schema = buildOperationSchema([], undefined, emptySpec);
    expect(schema.parse({})).toEqual({});
  });

  test("skips cookie parameters", () => {
    const params: ParameterObject[] = [
      { name: "session", in: "cookie", schema: { type: "string" } },
      { name: "id", in: "path", required: true, schema: { type: "string" } },
    ];
    const schema = buildOperationSchema(params, undefined, emptySpec);
    expect(schema.parse({ id: "123" })).toEqual({ id: "123" });
  });
});
