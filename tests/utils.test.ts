import { describe, expect, test } from "bun:test";
import { camelToSnake } from "../src/utils/camelToSnake";
import { unwrapZodType } from "../src/unwrapZodType";
import {
  ERROR_REFERENCE_URL,
  SmithersError,
  isSmithersError,
  errorToJson,
} from "../src/utils/errors";
import { newRunId } from "../src/utils/ids";
import { stablePathId, resolveStableId } from "../src/utils/tree-ids";
import { canonicalizeXml, parseXmlJson } from "../src/utils/xml";
import { computeRetryDelayMs } from "../src/utils/retry";
import { truncateToBytes, safeJson } from "../src/tools/logToolCall";
import { z } from "zod";

describe("camelToSnake", () => {
  test("converts camelCase to snake_case", () => {
    expect(camelToSnake("outputSchema")).toBe("output_schema");
  });

  test("converts PascalCase", () => {
    expect(camelToSnake("MyComponent")).toBe("_my_component");
  });

  test("leaves lowercase unchanged", () => {
    expect(camelToSnake("simple")).toBe("simple");
  });

  test("handles consecutive uppercase letters", () => {
    expect(camelToSnake("parseHTML")).toBe("parse_h_t_m_l");
  });

  test("handles empty string", () => {
    expect(camelToSnake("")).toBe("");
  });
});

describe("unwrapZodType", () => {
  test("unwraps optional", () => {
    const inner = z.string();
    const optional = inner.optional();
    const result = unwrapZodType(optional);
    // Should reach the inner string type
    expect(result).not.toBe(optional);
  });

  test("unwraps nullable", () => {
    const inner = z.number();
    const nullable = inner.nullable();
    const result = unwrapZodType(nullable);
    expect(result).not.toBe(nullable);
  });

  test("unwraps default", () => {
    const inner = z.number();
    const withDefault = inner.default(42);
    const result = unwrapZodType(withDefault);
    expect(result).not.toBe(withDefault);
  });

  test("returns non-wrapper types as-is", () => {
    const str = z.string();
    expect(unwrapZodType(str)).toBe(str);
  });

  test("handles null/undefined input", () => {
    expect(unwrapZodType(null)).toBeNull();
    expect(unwrapZodType(undefined)).toBeUndefined();
  });

  test("unwraps nested wrappers", () => {
    const base = z.string();
    const wrapped = base.optional().nullable();
    const result = unwrapZodType(wrapped);
    expect(result).not.toBe(wrapped);
  });
});

describe("SmithersError", () => {
  test("creates error with code and message", () => {
    const err = new SmithersError("AGENT_CLI_ERROR", "Task failed");
    expect(err.code).toBe("AGENT_CLI_ERROR");
    expect(err.message).toBe(`Task failed See ${ERROR_REFERENCE_URL}`);
    expect(err).toBeInstanceOf(Error);
  });

  test("includes optional details", () => {
    const err = new SmithersError("MISSING_OUTPUT", "msg", { nodeId: "a" });
    expect(err.details).toEqual({ nodeId: "a" });
  });
});

describe("isSmithersError", () => {
  test("returns true for SmithersError", () => {
    const err = new SmithersError("MISSING_OUTPUT", "msg");
    expect(isSmithersError(err)).toBe(true);
  });

  test("returns true for any error-like object with code", () => {
    expect(isSmithersError({ code: "X", message: "y" })).toBe(true);
  });

  test("returns false for plain Error", () => {
    expect(isSmithersError(new Error("plain"))).toBe(false);
  });

  test("returns false for null/undefined", () => {
    expect(isSmithersError(null)).toBe(false);
    expect(isSmithersError(undefined)).toBe(false);
  });
});

describe("errorToJson", () => {
  test("serializes Error instances", () => {
    const err = new Error("boom");
    const json = errorToJson(err);
    expect(json).toHaveProperty("name", "Error");
    expect(json).toHaveProperty("message", "boom");
    expect(json).toHaveProperty("stack");
  });

  test("serializes SmithersError with code and details", () => {
    const err = new SmithersError("INVALID_INPUT", "failed", { key: "val" });
    const json = errorToJson(err) as any;
    expect(json.code).toBe("INVALID_INPUT");
    expect(json.details).toEqual({ key: "val" });
  });

  test("serializes objects as-is", () => {
    const obj = { custom: true };
    expect(errorToJson(obj)).toBe(obj);
  });

  test("serializes primitives as message string", () => {
    expect(errorToJson("string error")).toEqual({ message: "string error" });
    expect(errorToJson(42)).toEqual({ message: "42" });
  });
});

describe("newRunId", () => {
  test("returns a string", () => {
    expect(typeof newRunId()).toBe("string");
  });

  test("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newRunId()));
    expect(ids.size).toBe(100);
  });
});

describe("stablePathId", () => {
  test("returns root for empty path", () => {
    expect(stablePathId("task", [])).toBe("task:root");
  });

  test("joins path segments with dots", () => {
    expect(stablePathId("task", [0, 1, 2])).toBe("task:0.1.2");
  });
});

describe("resolveStableId", () => {
  test("returns explicit string id when provided", () => {
    expect(resolveStableId("custom", "task", [0])).toBe("custom");
  });

  test("falls back to path-based id for empty string", () => {
    expect(resolveStableId("", "task", [0])).toBe("task:0");
  });

  test("falls back for whitespace-only string", () => {
    expect(resolveStableId("  ", "task", [0])).toBe("task:0");
  });

  test("falls back for non-string values", () => {
    expect(resolveStableId(undefined, "task", [1, 2])).toBe("task:1.2");
    expect(resolveStableId(null, "task", [0])).toBe("task:0");
    expect(resolveStableId(42, "task", [3])).toBe("task:3");
  });
});

describe("canonicalizeXml", () => {
  test("returns 'null' for null input", () => {
    expect(canonicalizeXml(null)).toBe("null");
  });

  test("serializes text node", () => {
    const node = { kind: "text" as const, text: "hello" };
    const result = JSON.parse(canonicalizeXml(node));
    expect(result).toEqual({ kind: "text", text: "hello" });
  });

  test("sorts element props alphabetically", () => {
    const node = {
      kind: "element" as const,
      tag: "div",
      props: { b: "2", a: "1" },
      children: [],
    };
    const result = JSON.parse(canonicalizeXml(node));
    const keys = Object.keys(result.props);
    expect(keys).toEqual(["a", "b"]);
  });
});

describe("parseXmlJson", () => {
  test("parses JSON string to XmlNode", () => {
    const json = '{"kind":"text","text":"hi"}';
    const result = parseXmlJson(json);
    expect(result).toEqual({ kind: "text", text: "hi" });
  });

  test("returns null for 'null' string", () => {
    expect(parseXmlJson("null")).toBeNull();
  });
});

describe("computeRetryDelayMs", () => {
  test("returns 0 without policy", () => {
    expect(computeRetryDelayMs(undefined, 1)).toBe(0);
  });

  test("returns 0 when initialDelayMs is 0", () => {
    expect(computeRetryDelayMs({ initialDelayMs: 0 }, 1)).toBe(0);
  });

  test("returns 0 when initialDelayMs is negative", () => {
    expect(computeRetryDelayMs({ initialDelayMs: -100 }, 1)).toBe(0);
  });

  test("fixed backoff uses constant delay", () => {
    const policy = { backoff: "fixed" as const, initialDelayMs: 100 };
    expect(computeRetryDelayMs(policy, 1)).toBe(100);
    expect(computeRetryDelayMs(policy, 3)).toBe(100);
  });

  test("linear backoff scales with attempt", () => {
    const policy = { backoff: "linear" as const, initialDelayMs: 100 };
    expect(computeRetryDelayMs(policy, 1)).toBe(100);
    expect(computeRetryDelayMs(policy, 2)).toBe(200);
    expect(computeRetryDelayMs(policy, 3)).toBe(300);
  });

  test("exponential backoff doubles per attempt", () => {
    const policy = { backoff: "exponential" as const, initialDelayMs: 100 };
    expect(computeRetryDelayMs(policy, 1)).toBe(100);
    expect(computeRetryDelayMs(policy, 2)).toBe(200);
    expect(computeRetryDelayMs(policy, 3)).toBe(400);
  });

  test("defaults to fixed when backoff not specified", () => {
    const policy = { initialDelayMs: 50 };
    expect(computeRetryDelayMs(policy, 1)).toBe(50);
    expect(computeRetryDelayMs(policy, 5)).toBe(50);
  });

  test("clamps attempt to at least 1", () => {
    const policy = { backoff: "linear" as const, initialDelayMs: 100 };
    expect(computeRetryDelayMs(policy, 0)).toBe(100);
    expect(computeRetryDelayMs(policy, -1)).toBe(100);
  });

  test("floors fractional initialDelayMs", () => {
    expect(computeRetryDelayMs({ initialDelayMs: 99.7 }, 1)).toBe(99);
  });
});

describe("truncateToBytes", () => {
  test("returns string unchanged when within limit", () => {
    expect(truncateToBytes("hello", 100)).toBe("hello");
  });

  test("truncates to byte limit", () => {
    const long = "a".repeat(200);
    const result = truncateToBytes(long, 50);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(50);
  });

  test("handles multi-byte characters safely", () => {
    const emoji = "🎉".repeat(20);
    const result = truncateToBytes(emoji, 10);
    // Should not produce broken UTF-8
    expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result);
  });
});

describe("safeJson", () => {
  test("returns JSON when within limit", () => {
    expect(safeJson({ a: 1 }, 1000)).toEqual({
      json: '{"a":1}',
      truncated: false,
    });
  });

  test("returns null for undefined value", () => {
    expect(safeJson(undefined, 100)).toEqual({
      json: "null",
      truncated: false,
    });
  });

  test("truncates large values with metadata", () => {
    const large = { data: "x".repeat(1000) };
    const safe = safeJson(large, 50);
    expect(safe.truncated).toBe(true);
    const result = JSON.parse(safe.json);
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeGreaterThan(50);
    expect(typeof result.preview).toBe("string");
  });
});
