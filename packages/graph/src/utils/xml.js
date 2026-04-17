
/** @typedef {import("../XmlNode.ts").XmlNode} XmlNode */
/**
 * @param {Record<string, string>} props
 * @returns {Record<string, string>}
 */
function sortProps(props) {
    const entries = Object.entries(props).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return Object.fromEntries(entries);
}
/**
 * @param {XmlNode} node
 * @returns {unknown}
 */
function canonicalizeNode(node) {
    if (node.kind === "text") {
        return { kind: "text", text: node.text };
    }
    const element = node;
    return {
        kind: "element",
        tag: element.tag,
        props: sortProps(element.props ?? {}),
        children: element.children.map(canonicalizeNode),
    };
}
/**
 * @param {XmlNode | null} node
 * @returns {string}
 */
export function canonicalizeXml(node) {
    if (!node)
        return "null";
    return JSON.stringify(canonicalizeNode(node));
}
/**
 * @param {string} json
 * @returns {XmlNode | null}
 */
export function parseXmlJson(json) {
    return JSON.parse(json);
}
