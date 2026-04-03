import { describe, expect, test } from "bun:test";

// The parse functions are defined locally in server/index.ts.
// We replicate them here for testing since they aren't exported.
// This tests the logic patterns used in the server.

function parsePositiveInt(raw: string | undefined | null): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || Math.floor(n) !== n) return undefined;
  return n;
}

function parseOptionalInt(raw: string | undefined | null): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.floor(n) !== n) return undefined;
  return n;
}

describe("parsePositiveInt", () => {
  test("parses valid positive integer", () => {
    expect(parsePositiveInt("5")).toBe(5);
    expect(parsePositiveInt("100")).toBe(100);
    expect(parsePositiveInt("1")).toBe(1);
  });

  test("returns undefined for zero", () => {
    expect(parsePositiveInt("0")).toBeUndefined();
  });

  test("returns undefined for negative", () => {
    expect(parsePositiveInt("-1")).toBeUndefined();
  });

  test("returns undefined for float", () => {
    expect(parsePositiveInt("1.5")).toBeUndefined();
  });

  test("returns undefined for NaN", () => {
    expect(parsePositiveInt("abc")).toBeUndefined();
  });

  test("returns undefined for null", () => {
    expect(parsePositiveInt(null)).toBeUndefined();
  });

  test("returns undefined for undefined", () => {
    expect(parsePositiveInt(undefined)).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(parsePositiveInt("")).toBeUndefined();
  });

  test("returns undefined for Infinity", () => {
    expect(parsePositiveInt("Infinity")).toBeUndefined();
  });
});

describe("parseOptionalInt", () => {
  test("parses valid integer", () => {
    expect(parseOptionalInt("5")).toBe(5);
    expect(parseOptionalInt("0")).toBe(0);
    expect(parseOptionalInt("-3")).toBe(-3);
  });

  test("returns undefined for float", () => {
    expect(parseOptionalInt("1.5")).toBeUndefined();
  });

  test("returns undefined for NaN", () => {
    expect(parseOptionalInt("abc")).toBeUndefined();
  });

  test("returns undefined for null", () => {
    expect(parseOptionalInt(null)).toBeUndefined();
  });

  test("returns undefined for undefined", () => {
    expect(parseOptionalInt(undefined)).toBeUndefined();
  });

  test("returns undefined for Infinity", () => {
    expect(parseOptionalInt("Infinity")).toBeUndefined();
  });
});
