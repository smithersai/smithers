import { describe, expect, test } from "bun:test";
import { truncateToBytes, safeJson } from "../src/tools/logToolCall";

describe("truncateToBytes", () => {
  test("returns text unchanged when within limit", () => {
    expect(truncateToBytes("hello", 100)).toBe("hello");
  });

  test("truncates to exact byte count for ASCII", () => {
    const result = truncateToBytes("abcdefghij", 5);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(5);
    expect(result).toBe("abcde");
  });

  test("handles empty string", () => {
    expect(truncateToBytes("", 10)).toBe("");
  });

  test("handles zero maxBytes", () => {
    expect(truncateToBytes("hello", 0)).toBe("");
  });

  test("handles multi-byte UTF-8 characters", () => {
    // Japanese characters are 3 bytes each in UTF-8
    const text = "あいう"; // 9 bytes
    const result = truncateToBytes(text, 6);
    // Should truncate cleanly at character boundary (2 chars = 6 bytes)
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(6);
  });

  test("handles emoji (4-byte UTF-8)", () => {
    const text = "😀😁😂"; // 4 bytes each = 12 bytes
    const result = truncateToBytes(text, 8);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(8);
  });
});

describe("safeJson", () => {
  test("returns JSON when within limit", () => {
    const result = safeJson({ key: "value" }, 1000);
    expect(result).toEqual({
      json: '{"key":"value"}',
      truncated: false,
    });
  });

  test("returns null JSON for null input", () => {
    expect(safeJson(null, 100)).toEqual({
      json: "null",
      truncated: false,
    });
  });

  test("returns null JSON for undefined input", () => {
    expect(safeJson(undefined, 100)).toEqual({
      json: "null",
      truncated: false,
    });
  });

  test("truncates large JSON and wraps in truncation envelope", () => {
    const large = { data: "x".repeat(1000) };
    const result = safeJson(large, 50);
    expect(result.truncated).toBe(true);
    const parsed = JSON.parse(result.json);
    expect(parsed.truncated).toBe(true);
    expect(typeof parsed.bytes).toBe("number");
    expect(typeof parsed.preview).toBe("string");
  });

  test("reports correct byte count in truncation envelope", () => {
    const data = "a".repeat(200);
    const json = JSON.stringify(data);
    const expectedBytes = Buffer.byteLength(json, "utf8");
    const result = safeJson(data, 50);
    const parsed = JSON.parse(result.json);
    expect(parsed.bytes).toBe(expectedBytes);
  });

  test("handles arrays", () => {
    const result = safeJson([1, 2, 3], 100);
    expect(result).toEqual({
      json: "[1,2,3]",
      truncated: false,
    });
  });

  test("handles numbers", () => {
    expect(safeJson(42, 100)).toEqual({
      json: "42",
      truncated: false,
    });
  });

  test("handles booleans", () => {
    expect(safeJson(true, 100)).toEqual({
      json: "true",
      truncated: false,
    });
  });

  test("reports non-truncated payload metadata", () => {
    const result = safeJson({ ok: true }, 100);
    expect(result.truncated).toBe(false);
    expect(Buffer.byteLength(result.json, "utf8")).toBeLessThanOrEqual(100);
  });
});
