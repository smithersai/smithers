import { describe, expect, test } from "bun:test";
import { canonicalizeXml, parseXmlJson } from "../src/utils/xml";

describe("canonicalizeXml", () => {
  test("normalizes element node", () => {
    const node = {
      kind: "element" as const,
      tag: "div",
      props: { class: "foo" },
      children: [],
    };
    const result = JSON.parse(canonicalizeXml(node));
    expect(result.kind).toBe("element");
    expect(result.tag).toBe("div");
  });

  test("normalizes text node", () => {
    const node = { kind: "text" as const, text: "hello" };
    const result = JSON.parse(canonicalizeXml(node));
    expect(result.kind).toBe("text");
    expect(result.text).toBe("hello");
  });

  test("handles nested children", () => {
    const node = {
      kind: "element" as const,
      tag: "parent",
      props: {},
      children: [
        { kind: "text" as const, text: "child" },
        {
          kind: "element" as const,
          tag: "inner",
          props: {},
          children: [],
        },
      ],
    };
    const result = JSON.parse(canonicalizeXml(node));
    expect(result.children.length).toBe(2);
  });

  test("returns null for null input", () => {
    expect(canonicalizeXml(null as any)).toBe("null");
  });
});

describe("parseXmlJson", () => {
  test("parses valid XML JSON string", () => {
    const json = JSON.stringify({
      kind: "element",
      tag: "workflow",
      props: {},
      children: [],
    });
    const result = parseXmlJson(json);
    expect(result).toBeDefined();
    expect(result?.kind).toBe("element");
    if (result?.kind === "element") {
      expect(result.tag).toBe("workflow");
    }
  });

  test("returns null for invalid JSON", () => {
    expect(() => parseXmlJson("not-json")).toThrow();
  });

  test("returns null for null string", () => {
    expect(parseXmlJson("null")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(() => parseXmlJson("")).toThrow();
  });
});
