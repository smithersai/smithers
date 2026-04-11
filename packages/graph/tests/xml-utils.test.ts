import { describe, expect, test } from "bun:test";
import { canonicalizeXml, parseXmlJson } from "../src/utils/xml";
import type { XmlNode, XmlElement } from "../src/XmlNode";

describe("canonicalizeXml", () => {
  test("returns 'null' for null input", () => {
    expect(canonicalizeXml(null)).toBe("null");
  });

  test("canonicalizes text node", () => {
    const node: XmlNode = { kind: "text", text: "hello" };
    const result = JSON.parse(canonicalizeXml(node));
    expect(result).toEqual({ kind: "text", text: "hello" });
  });

  test("sorts props alphabetically", () => {
    const node: XmlElement = {
      kind: "element",
      tag: "smithers:task",
      props: { z: "1", a: "2", m: "3" },
      children: [],
    };
    const result = JSON.parse(canonicalizeXml(node));
    const propKeys = Object.keys(result.props);
    expect(propKeys).toEqual(["a", "m", "z"]);
  });

  test("produces deterministic output", () => {
    const node: XmlElement = {
      kind: "element",
      tag: "test",
      props: { b: "2", a: "1" },
      children: [{ kind: "text", text: "child" }],
    };
    const first = canonicalizeXml(node);
    const second = canonicalizeXml(node);
    expect(first).toBe(second);
  });

  test("handles nested elements", () => {
    const node: XmlElement = {
      kind: "element",
      tag: "parent",
      props: {},
      children: [
        {
          kind: "element",
          tag: "child",
          props: { id: "1" },
          children: [],
        },
      ],
    };
    const result = JSON.parse(canonicalizeXml(node));
    expect(result.children).toHaveLength(1);
    expect(result.children[0].tag).toBe("child");
  });

  test("handles empty props", () => {
    const node: XmlElement = {
      kind: "element",
      tag: "test",
      props: {},
      children: [],
    };
    const result = JSON.parse(canonicalizeXml(node));
    expect(result.props).toEqual({});
  });
});

describe("parseXmlJson", () => {
  test("parses text node", () => {
    const json = JSON.stringify({ kind: "text", text: "hello" });
    const result = parseXmlJson(json);
    expect(result).toEqual({ kind: "text", text: "hello" });
  });

  test("parses element node", () => {
    const json = JSON.stringify({
      kind: "element",
      tag: "test",
      props: { id: "1" },
      children: [],
    });
    const result = parseXmlJson(json);
    expect(result!.kind).toBe("element");
  });

  test("parses null", () => {
    const result = parseXmlJson("null");
    expect(result).toBeNull();
  });

  test("roundtrips through canonicalize and parse", () => {
    const node: XmlElement = {
      kind: "element",
      tag: "smithers:task",
      props: { id: "t1" },
      children: [{ kind: "text", text: "prompt" }],
    };
    const json = canonicalizeXml(node);
    const parsed = parseXmlJson(json)!;
    expect(parsed.kind).toBe("element");
    if (parsed.kind === "element") {
      expect(parsed.tag).toBe("smithers:task");
    }
  });
});
