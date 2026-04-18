import { describe, expect, test } from "bun:test";
import { applyFrameDelta, encodeFrameDelta, parseFrameDelta, serializeFrameDelta, } from "../src/frame-codec.js";
import { canonicalizeXml } from "@smithers-orchestrator/graph/utils/xml";
/**
 * @param {XmlNode[]} children
 * @returns {XmlNode}
 */
function workflowNode(children) {
    return {
        kind: "element",
        tag: "smithers:workflow",
        props: { name: "delta-test" },
        children,
    };
}
/**
 * @param {string} id
 * @param {string} state
 * @param {string} [label]
 * @returns {XmlNode}
 */
function taskNode(id, state, label) {
    return {
        kind: "element",
        tag: "smithers:task",
        props: {
            id,
            state,
            ...(label ? { label } : {}),
        },
        children: [],
    };
}
describe("frame-codec", () => {
    test("round-trips a state-only delta", () => {
        const prev = canonicalizeXml(workflowNode([
            taskNode("plan::0", "pending"),
            taskNode("implement::0", "pending"),
        ]));
        const next = canonicalizeXml(workflowNode([
            taskNode("plan::0", "finished"),
            taskNode("implement::0", "pending"),
        ]));
        const delta = encodeFrameDelta(prev, next);
        expect(delta.ops.length).toBeGreaterThan(0);
        const roundTrip = applyFrameDelta(prev, delta);
        expect(roundTrip).toBe(next);
    });
    test("round-trips add/remove node and prop mutations", () => {
        const prev = canonicalizeXml(workflowNode([
            taskNode("plan::0", "finished", "Plan"),
            taskNode("implement::0", "in-progress", "Implement"),
            taskNode("verify::0", "pending", "Verify"),
        ]));
        const next = canonicalizeXml(workflowNode([
            taskNode("plan::0", "finished", "Planning"),
            taskNode("verify::0", "pending", "Verify"),
            taskNode("review::0", "pending", "Review"),
            taskNode("ship::0", "pending", "Ship"),
        ]));
        const delta = encodeFrameDelta(prev, next);
        const encoded = serializeFrameDelta(delta);
        const parsed = parseFrameDelta(encoded);
        const roundTrip = applyFrameDelta(prev, parsed);
        expect(roundTrip).toBe(next);
        expect(parsed.ops.some((op) => op.op === "insert")).toBe(true);
        expect(parsed.ops.some((op) => op.op === "remove")).toBe(true);
    });
    test("emits an empty delta for identical frames", () => {
        const xml = canonicalizeXml(workflowNode([taskNode("plan::0", "pending")]));
        const delta = encodeFrameDelta(xml, xml);
        expect(delta.ops).toEqual([]);
        expect(applyFrameDelta(xml, delta)).toBe(xml);
    });
});
