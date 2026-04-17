import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { buildOutputSchemaDescriptor } from "../src/output-schema-descriptor.js";

describe("buildOutputSchemaDescriptor", () => {
  test("maps primitive string fields", () => {
    const descriptor = buildOutputSchemaDescriptor(z.object({ a: z.string() }));
    expect(descriptor.fields).toEqual([
      {
        name: "a",
        type: "string",
        optional: false,
        nullable: false,
      },
    ]);
  });

  test("marks optional fields", () => {
    const descriptor = buildOutputSchemaDescriptor(
      z.object({ a: z.string().optional() }),
    );
    expect(descriptor.fields[0]?.optional).toBe(true);
  });

  test("marks nullable fields", () => {
    const descriptor = buildOutputSchemaDescriptor(
      z.object({ a: z.string().nullable() }),
    );
    expect(descriptor.fields[0]?.nullable).toBe(true);
  });

  test("preserves field descriptions", () => {
    const descriptor = buildOutputSchemaDescriptor(
      z.object({ a: z.string().describe("help") }),
    );
    expect(descriptor.fields[0]?.description).toBe("help");
  });

  test("maps enum values", () => {
    const descriptor = buildOutputSchemaDescriptor(
      z.object({ a: z.enum(["x", "y"]) }),
    );
    expect(descriptor.fields[0]).toMatchObject({
      type: "string",
      enum: ["x", "y"],
    });
  });

  test("maps constrained numbers as number", () => {
    const descriptor = buildOutputSchemaDescriptor(
      z.object({ a: z.number().int().min(0).max(100) }),
    );
    expect(descriptor.fields[0]?.type).toBe("number");
  });

  test("maps arrays", () => {
    const descriptor = buildOutputSchemaDescriptor(
      z.object({ a: z.array(z.string()) }),
    );
    expect(descriptor.fields[0]?.type).toBe("array");
  });

  test("maps nested objects as object", () => {
    const descriptor = buildOutputSchemaDescriptor(
      z.object({ a: z.object({ b: z.string() }) }),
    );
    expect(descriptor.fields[0]?.type).toBe("object");
  });

  test("maps unsupported unions to unknown and emits warning", () => {
    const warnings: Array<{ code: string; field: string; construct: string }> = [];
    const descriptor = buildOutputSchemaDescriptor(
      z.object({ a: z.union([z.string(), z.number()]) }),
      {
        onWarning: (warning) => warnings.push(warning),
      },
    );

    expect(descriptor.fields[0]?.type).toBe("unknown");
    expect(warnings).toEqual([
      expect.objectContaining({
        code: "SchemaConversionError",
        field: "a",
        construct: "union",
      }),
    ]);
  });

  test("supports empty objects", () => {
    const descriptor = buildOutputSchemaDescriptor(z.object({}));
    expect(descriptor.fields).toEqual([]);
  });

  test("keeps declared field order for large schemas", () => {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (let index = 0; index < 100; index += 1) {
      shape[`field_${index}`] = z.string();
    }

    const descriptor = buildOutputSchemaDescriptor(z.object(shape));
    expect(descriptor.fields).toHaveLength(100);
    expect(descriptor.fields.map((field) => field.name)).toEqual(
      Array.from({ length: 100 }, (_, index) => `field_${index}`),
    );
  });

  test("maps record fields to object with helper description", () => {
    const descriptor = buildOutputSchemaDescriptor(
      z.object({ a: z.record(z.string(), z.any()) }),
    );

    expect(descriptor.fields[0]?.type).toBe("object");
    expect(descriptor.fields[0]?.description).toContain("Record");
  });
});
