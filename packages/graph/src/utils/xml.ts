import type { XmlNode, XmlElement } from "@smithers/graph/XmlNode";

function sortProps(props: Record<string, string>): Record<string, string> {
  const entries = Object.entries(props).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return Object.fromEntries(entries);
}

function canonicalizeNode(node: XmlNode): unknown {
  if (node.kind === "text") {
    return { kind: "text", text: node.text };
  }
  const element = node as XmlElement;
  return {
    kind: "element",
    tag: element.tag,
    props: sortProps(element.props ?? {}),
    children: element.children.map(canonicalizeNode),
  };
}

export function canonicalizeXml(node: XmlNode | null): string {
  if (!node) return "null";
  return JSON.stringify(canonicalizeNode(node));
}

export function parseXmlJson(json: string): XmlNode | null {
  return JSON.parse(json) as XmlNode | null;
}
