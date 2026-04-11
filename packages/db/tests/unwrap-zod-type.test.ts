import { describe, expect, test } from "bun:test";
import { unwrapZodType } from "../src/unwrapZodType";
import { z } from "zod";

describe("unwrapZodType", () => {
  test("returns string type unchanged", () => {
    const t = z.string();
    const result = unwrapZodType(t);
    expect(result).toBe(t);
  });

  test("returns number type unchanged", () => {
    const t = z.number();
    const result = unwrapZodType(t);
    expect(result).toBe(t);
  });

  test("returns boolean type unchanged", () => {
    const t = z.boolean();
    const result = unwrapZodType(t);
    expect(result).toBe(t);
  });

  test("unwraps optional to inner type", () => {
    const inner = z.string();
    const wrapped = inner.optional();
    const result = unwrapZodType(wrapped);
    // Result should be the string type, not the optional wrapper
    const resultDef = (result as any)._zod?.def ?? (result as any)._def;
    const typeName = resultDef?.type ?? resultDef?.typeName;
    expect(typeName === "string" || typeName === "ZodString").toBe(true);
  });

  test("unwraps nullable to inner type", () => {
    const inner = z.number();
    const wrapped = inner.nullable();
    const result = unwrapZodType(wrapped);
    const resultDef = (result as any)._zod?.def ?? (result as any)._def;
    const typeName = resultDef?.type ?? resultDef?.typeName;
    expect(typeName === "number" || typeName === "ZodNumber").toBe(true);
  });

  test("unwraps deeply nested optional/nullable", () => {
    const inner = z.boolean();
    const wrapped = inner.optional().nullable();
    const result = unwrapZodType(wrapped);
    const resultDef = (result as any)._zod?.def ?? (result as any)._def;
    const typeName = resultDef?.type ?? resultDef?.typeName;
    expect(typeName === "boolean" || typeName === "ZodBoolean").toBe(true);
  });

  test("returns null/undefined as-is", () => {
    expect(unwrapZodType(null)).toBeNull();
    expect(unwrapZodType(undefined)).toBeUndefined();
  });

  test("returns object type unchanged", () => {
    const t = z.object({ a: z.string() });
    const result = unwrapZodType(t);
    expect(result).toBe(t);
  });

  test("returns array type unchanged", () => {
    const t = z.array(z.string());
    const result = unwrapZodType(t);
    expect(result).toBe(t);
  });

  test("unwraps default to inner type", () => {
    const inner = z.string();
    const wrapped = inner.default("hello");
    const result = unwrapZodType(wrapped);
    const resultDef = (result as any)._zod?.def ?? (result as any)._def;
    const typeName = resultDef?.type ?? resultDef?.typeName;
    expect(typeName === "string" || typeName === "ZodString").toBe(true);
  });
});
