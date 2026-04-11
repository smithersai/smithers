import { describe, expect, test } from "bun:test";
import {
  namespaceToString,
  parseNamespace,
  type MemoryNamespace,
} from "../src/types";

describe("namespaceToString", () => {
  test("workflow namespace", () => {
    const ns: MemoryNamespace = { kind: "workflow", id: "code-review" };
    expect(namespaceToString(ns)).toBe("workflow:code-review");
  });

  test("agent namespace", () => {
    const ns: MemoryNamespace = { kind: "agent", id: "reviewer" };
    expect(namespaceToString(ns)).toBe("agent:reviewer");
  });

  test("user namespace", () => {
    const ns: MemoryNamespace = { kind: "user", id: "alice" };
    expect(namespaceToString(ns)).toBe("user:alice");
  });

  test("global namespace", () => {
    const ns: MemoryNamespace = { kind: "global", id: "shared" };
    expect(namespaceToString(ns)).toBe("global:shared");
  });
});

describe("parseNamespace", () => {
  test("parses workflow:id", () => {
    const ns = parseNamespace("workflow:code-review");
    expect(ns).toEqual({ kind: "workflow", id: "code-review" });
  });

  test("parses agent:id", () => {
    const ns = parseNamespace("agent:reviewer");
    expect(ns).toEqual({ kind: "agent", id: "reviewer" });
  });

  test("parses user:id", () => {
    const ns = parseNamespace("user:alice");
    expect(ns).toEqual({ kind: "user", id: "alice" });
  });

  test("parses global:id", () => {
    const ns = parseNamespace("global:shared");
    expect(ns).toEqual({ kind: "global", id: "shared" });
  });

  test("falls back to global for unknown kind", () => {
    const ns = parseNamespace("unknown:something");
    expect(ns).toEqual({ kind: "global", id: "unknown:something" });
  });

  test("falls back to global for string without colon", () => {
    const ns = parseNamespace("bare-string");
    expect(ns).toEqual({ kind: "global", id: "bare-string" });
  });

  test("handles id with colons", () => {
    const ns = parseNamespace("workflow:ns:with:colons");
    expect(ns).toEqual({ kind: "workflow", id: "ns:with:colons" });
  });

  test("roundtrip: namespaceToString -> parseNamespace", () => {
    const original: MemoryNamespace = { kind: "workflow", id: "my-flow" };
    const str = namespaceToString(original);
    const parsed = parseNamespace(str);
    expect(parsed).toEqual(original);
  });
});
