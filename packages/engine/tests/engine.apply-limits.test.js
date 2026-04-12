import { describe, expect, test } from "bun:test";
import { applyConcurrencyLimits } from "../src/engine.js";
/**
 * @param {string} id
 * @param {string} [group]
 * @param {number} [cap]
 * @returns {TaskDescriptor}
 */
function td(id, group, cap) {
    return {
        nodeId: id,
        ordinal: 0,
        iteration: 0,
        ralphId: undefined,
        outputTable: null,
        outputTableName: "t",
        outputSchema: undefined,
        needsApproval: false,
        skipIf: false,
        retries: 0,
        timeoutMs: null,
        continueOnFail: false,
        agent: undefined,
        prompt: undefined,
        staticPayload: undefined,
        label: undefined,
        meta: undefined,
        parallelGroupId: group,
        parallelMaxConcurrency: cap,
    };
}
/**
 * @param {string} id
 */
function key(id, it = 0) {
    return `${id}::${it}`;
}
describe("engine: applyConcurrencyLimits()", () => {
    test("respects global capacity regardless of group info", () => {
        const all = [td("x", "g", 1), td("a", "g", 1), td("b", "g", 1)];
        const runnable = [all[1], all[2]];
        const states = new Map([[key("x"), "in-progress"]]);
        // maxConcurrency=2 means only one new task admitted
        const selected = applyConcurrencyLimits(runnable, states, 2, all);
        expect(selected.length).toBe(1);
        expect(["a", "b"]).toContain(selected[0].nodeId);
    });
    test("admits up to remaining global capacity when none in-progress", () => {
        const all = [td("a"), td("b"), td("c")];
        const runnable = [all[0], all[1], all[2]];
        const states = new Map();
        const selected = applyConcurrencyLimits(runnable, states, 2, all);
        expect(selected.map((t) => t.nodeId).length).toBe(2);
        expect(["a", "b"]).toEqual(selected.map((t) => t.nodeId));
    });
});
