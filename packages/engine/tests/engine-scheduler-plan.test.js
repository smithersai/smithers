import { describe, expect, test } from "bun:test";
import { buildPlanTree, scheduleTasks, buildStateKey, } from "../src/scheduler.js";
/**
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {XmlNode[]} [children]
 * @returns {XmlNode}
 */
function makeXml(tag, props = {}, children = []) {
    return { kind: "element", tag, props, children };
}
/**
 * @param {string} id
 * @param {Record<string, any>} [props]
 * @returns {XmlNode}
 */
function makeTask(id, props = {}) {
    return makeXml("smithers:task", { id, ...props });
}
/**
 * @param {string} nodeId
 * @param {Partial<TaskDescriptor>} [overrides]
 * @returns {TaskDescriptor}
 */
function makeDescriptor(nodeId, overrides = {}) {
    return {
        nodeId,
        iteration: 0,
        ordinal: 0,
        outputTable: "output",
        continueOnFail: false,
        ...overrides,
    };
}
describe("buildPlanTree", () => {
    test("returns null plan for null xml", () => {
        const { plan, ralphs } = buildPlanTree(null);
        expect(plan).toBeNull();
        expect(ralphs).toEqual([]);
    });
    test("builds sequence from workflow", () => {
        const xml = makeXml("smithers:workflow", {}, [
            makeTask("a"),
            makeTask("b"),
        ]);
        const { plan } = buildPlanTree(xml);
        expect(plan.kind).toBe("sequence");
        expect(plan.children.length).toBe(2);
    });
    test("builds parallel node", () => {
        const xml = makeXml("smithers:workflow", {}, [
            makeXml("smithers:parallel", {}, [
                makeTask("a"),
                makeTask("b"),
            ]),
        ]);
        const { plan } = buildPlanTree(xml);
        const seq = plan;
        expect(seq.children[0].kind).toBe("parallel");
        expect(seq.children[0].children.length).toBe(2);
    });
    test("builds ralph node with defaults", () => {
        const xml = makeXml("smithers:workflow", {}, [
            makeXml("smithers:ralph", { id: "loop-1" }, [
                makeTask("a"),
            ]),
        ]);
        const { plan, ralphs } = buildPlanTree(xml);
        const seq = plan;
        const ralph = seq.children[0];
        expect(ralph.kind).toBe("ralph");
        expect(ralph.maxIterations).toBe(5);
        expect(ralph.onMaxReached).toBe("return-last");
        expect(ralphs.length).toBe(1);
        expect(ralphs[0].id).toBe("loop-1");
    });
    test("ralph extracts custom maxIterations and onMaxReached", () => {
        const xml = makeXml("smithers:workflow", {}, [
            makeXml("smithers:ralph", { id: "loop-1", maxIterations: "10", onMaxReached: "fail" }, [
                makeTask("a"),
            ]),
        ]);
        const { ralphs } = buildPlanTree(xml);
        expect(ralphs[0].maxIterations).toBe(10);
        expect(ralphs[0].onMaxReached).toBe("fail");
    });
    test("ralph extracts continueAsNewEvery", () => {
        const xml = makeXml("smithers:workflow", {}, [
            makeXml("smithers:ralph", { id: "loop-1", continueAsNewEvery: "7" }, [makeTask("a")]),
        ]);
        const { ralphs } = buildPlanTree(xml);
        expect(ralphs[0].continueAsNewEvery).toBe(7);
    });
    test("builds continue-as-new node", () => {
        const xml = makeXml("smithers:workflow", {}, [
            makeXml("smithers:continue-as-new", { stateJson: "{\"cursor\":\"abc\"}" }),
        ]);
        const { plan } = buildPlanTree(xml);
        const seq = plan;
        expect(seq.children[0].kind).toBe("continue-as-new");
        expect(seq.children[0].stateJson).toBe("{\"cursor\":\"abc\"}");
    });
    test("throws on nested ralph", () => {
        const xml = makeXml("smithers:workflow", {}, [
            makeXml("smithers:ralph", { id: "outer" }, [
                makeXml("smithers:ralph", { id: "inner" }, [
                    makeTask("a"),
                ]),
            ]),
        ]);
        expect(() => buildPlanTree(xml)).toThrow(/Nested/);
    });
    test("throws on duplicate ralph id", () => {
        const xml = makeXml("smithers:workflow", {}, [
            makeXml("smithers:ralph", { id: "dup" }, [makeTask("a")]),
            makeXml("smithers:ralph", { id: "dup" }, [makeTask("b")]),
        ]);
        expect(() => buildPlanTree(xml)).toThrow(/Duplicate/);
    });
    test("builds merge-queue as parallel", () => {
        const xml = makeXml("smithers:workflow", {}, [
            makeXml("smithers:merge-queue", {}, [
                makeTask("a"),
                makeTask("b"),
            ]),
        ]);
        const { plan } = buildPlanTree(xml);
        const seq = plan;
        expect(seq.children[0].kind).toBe("parallel");
    });
    test("builds worktree as group", () => {
        const xml = makeXml("smithers:workflow", {}, [
            makeXml("smithers:worktree", {}, [
                makeTask("a"),
            ]),
        ]);
        const { plan } = buildPlanTree(xml);
        const seq = plan;
        expect(seq.children[0].kind).toBe("group");
    });
    test("treats sandbox as a single task node", () => {
        const xml = makeXml("smithers:workflow", {}, [
            makeXml("smithers:sandbox", { id: "safe" }, [
                makeTask("inside"),
            ]),
        ]);
        const { plan } = buildPlanTree(xml);
        const seq = plan;
        expect(seq.children[0]).toEqual({ kind: "task", nodeId: "safe" });
    });
    test("skips tasks without id", () => {
        const xml = makeXml("smithers:workflow", {}, [
            makeXml("smithers:task", {}),
        ]);
        const { plan } = buildPlanTree(xml);
        const seq = plan;
        expect(seq.children.length).toBe(0);
    });
});
describe("scheduleTasks", () => {
    test("returns empty runnable for null plan", () => {
        const result = scheduleTasks(null, new Map(), new Map(), new Map(), new Map(), Date.now());
        expect(result.runnable).toEqual([]);
        expect(result.pendingExists).toBe(false);
    });
    test("schedules first pending task in sequence", () => {
        const plan = {
            kind: "sequence",
            children: [
                { kind: "task", nodeId: "a" },
                { kind: "task", nodeId: "b" },
            ],
        };
        const states = new Map();
        const descs = new Map([
            ["a", makeDescriptor("a")],
            ["b", makeDescriptor("b")],
        ]);
        const result = scheduleTasks(plan, states, descs, new Map(), new Map(), Date.now());
        expect(result.runnable.length).toBe(1);
        expect(result.runnable[0].nodeId).toBe("a");
    });
    test("skips to next task in sequence when first is finished", () => {
        const plan = {
            kind: "sequence",
            children: [
                { kind: "task", nodeId: "a" },
                { kind: "task", nodeId: "b" },
            ],
        };
        const states = new Map([
            [buildStateKey("a", 0), "finished"],
        ]);
        const descs = new Map([
            ["a", makeDescriptor("a")],
            ["b", makeDescriptor("b")],
        ]);
        const result = scheduleTasks(plan, states, descs, new Map(), new Map(), Date.now());
        expect(result.runnable.length).toBe(1);
        expect(result.runnable[0].nodeId).toBe("b");
    });
    test("schedules all pending tasks in parallel", () => {
        const plan = {
            kind: "parallel",
            children: [
                { kind: "task", nodeId: "a" },
                { kind: "task", nodeId: "b" },
                { kind: "task", nodeId: "c" },
            ],
        };
        const states = new Map();
        const descs = new Map([
            ["a", makeDescriptor("a")],
            ["b", makeDescriptor("b")],
            ["c", makeDescriptor("c")],
        ]);
        const result = scheduleTasks(plan, states, descs, new Map(), new Map(), Date.now());
        expect(result.runnable.length).toBe(3);
    });
    test("respects group concurrency limits", () => {
        const plan = {
            kind: "parallel",
            children: [
                { kind: "task", nodeId: "a" },
                { kind: "task", nodeId: "b" },
                { kind: "task", nodeId: "c" },
            ],
        };
        const states = new Map([
            [buildStateKey("a", 0), "in-progress"],
        ]);
        const descs = new Map([
            ["a", makeDescriptor("a", { parallelGroupId: "g1", parallelMaxConcurrency: 1 })],
            ["b", makeDescriptor("b", { parallelGroupId: "g1", parallelMaxConcurrency: 1 })],
            ["c", makeDescriptor("c", { parallelGroupId: "g1", parallelMaxConcurrency: 1 })],
        ]);
        const result = scheduleTasks(plan, states, descs, new Map(), new Map(), Date.now());
        expect(result.runnable.length).toBe(0);
    });
    test("detects waiting-approval state", () => {
        const plan = {
            kind: "sequence",
            children: [{ kind: "task", nodeId: "a" }],
        };
        const states = new Map([
            [buildStateKey("a", 0), "waiting-approval"],
        ]);
        const descs = new Map([["a", makeDescriptor("a")]]);
        const result = scheduleTasks(plan, states, descs, new Map(), new Map(), Date.now());
        expect(result.waitingApprovalExists).toBe(true);
    });
    test("async waiting approvals do not block unrelated later sequence tasks", () => {
        const plan = {
            kind: "sequence",
            children: [
                { kind: "task", nodeId: "a" },
                { kind: "task", nodeId: "b" },
            ],
        };
        const states = new Map([
            [buildStateKey("a", 0), "waiting-approval"],
        ]);
        const descs = new Map([
            ["a", makeDescriptor("a", { waitAsync: true, needsApproval: true })],
            ["b", makeDescriptor("b")],
        ]);
        const result = scheduleTasks(plan, states, descs, new Map(), new Map(), Date.now());
        expect(result.waitingApprovalExists).toBe(true);
        expect(result.runnable.map((task) => task.nodeId)).toEqual(["b"]);
    });
    test("async waiting approvals still block explicit dependencies", () => {
        const plan = {
            kind: "sequence",
            children: [
                { kind: "task", nodeId: "a" },
                { kind: "task", nodeId: "b" },
            ],
        };
        const states = new Map([
            [buildStateKey("a", 0), "waiting-approval"],
        ]);
        const descs = new Map([
            ["a", makeDescriptor("a", { waitAsync: true, needsApproval: true })],
            ["b", makeDescriptor("b", { dependsOn: ["a"] })],
        ]);
        const result = scheduleTasks(plan, states, descs, new Map(), new Map(), Date.now());
        expect(result.runnable).toEqual([]);
    });
    test("detects waiting-timer state", () => {
        const plan = {
            kind: "sequence",
            children: [{ kind: "task", nodeId: "a" }],
        };
        const states = new Map([
            [buildStateKey("a", 0), "waiting-timer"],
        ]);
        const descs = new Map([["a", makeDescriptor("a")]]);
        const result = scheduleTasks(plan, states, descs, new Map(), new Map(), Date.now());
        expect(result.waitingTimerExists).toBe(true);
    });
    test("respects retry wait", () => {
        const now = 1000;
        const plan = {
            kind: "sequence",
            children: [{ kind: "task", nodeId: "a" }],
        };
        const states = new Map();
        const descs = new Map([["a", makeDescriptor("a")]]);
        const retryWait = new Map([[buildStateKey("a", 0), 2000]]);
        const result = scheduleTasks(plan, states, descs, new Map(), retryWait, now);
        expect(result.runnable.length).toBe(0);
        expect(result.nextRetryAtMs).toBe(2000);
    });
    test("failed task with continueOnFail is terminal", () => {
        const plan = {
            kind: "sequence",
            children: [
                { kind: "task", nodeId: "a" },
                { kind: "task", nodeId: "b" },
            ],
        };
        const states = new Map([
            [buildStateKey("a", 0), "failed"],
        ]);
        const descs = new Map([
            ["a", makeDescriptor("a", { continueOnFail: true })],
            ["b", makeDescriptor("b")],
        ]);
        const result = scheduleTasks(plan, states, descs, new Map(), new Map(), Date.now());
        expect(result.runnable[0].nodeId).toBe("b");
    });
    test("failed task without continueOnFail blocks sequence", () => {
        const plan = {
            kind: "sequence",
            children: [
                { kind: "task", nodeId: "a" },
                { kind: "task", nodeId: "b" },
            ],
        };
        const states = new Map([
            [buildStateKey("a", 0), "failed"],
        ]);
        const descs = new Map([
            ["a", makeDescriptor("a", { continueOnFail: false })],
            ["b", makeDescriptor("b")],
        ]);
        const result = scheduleTasks(plan, states, descs, new Map(), new Map(), Date.now());
        expect(result.runnable.length).toBe(0);
    });
    test("ralph reports readyRalphs when all children terminal", () => {
        const plan = {
            kind: "ralph",
            id: "loop-1",
            children: [{ kind: "task", nodeId: "a" }],
            until: false,
            maxIterations: 5,
            onMaxReached: "return-last",
        };
        const states = new Map([
            [buildStateKey("a", 0), "finished"],
        ]);
        const descs = new Map([["a", makeDescriptor("a")]]);
        const result = scheduleTasks(plan, states, descs, new Map(), new Map(), Date.now());
        expect(result.readyRalphs.length).toBe(1);
        expect(result.readyRalphs[0].id).toBe("loop-1");
    });
    test("returns continuation request when continue-as-new is reached", () => {
        const plan = {
            kind: "continue-as-new",
            stateJson: "{\"cursor\":\"abc\"}",
        };
        const result = scheduleTasks(plan, new Map(), new Map(), new Map(), new Map(), Date.now());
        expect(result.continuation).toBeDefined();
        expect(result.continuation?.stateJson).toBe("{\"cursor\":\"abc\"}");
    });
    test("ralph with until=true is terminal", () => {
        const plan = {
            kind: "ralph",
            id: "loop-1",
            children: [{ kind: "task", nodeId: "a" }],
            until: true,
            maxIterations: 5,
            onMaxReached: "return-last",
        };
        const states = new Map();
        const descs = new Map([["a", makeDescriptor("a")]]);
        const result = scheduleTasks(plan, states, descs, new Map(), new Map(), Date.now());
        expect(result.readyRalphs.length).toBe(0);
    });
    test("respects dependency ordering", () => {
        const plan = {
            kind: "parallel",
            children: [
                { kind: "task", nodeId: "a" },
                { kind: "task", nodeId: "b" },
            ],
        };
        const states = new Map();
        const descs = new Map([
            ["a", makeDescriptor("a")],
            ["b", makeDescriptor("b", { dependsOn: ["a"] })],
        ]);
        const result = scheduleTasks(plan, states, descs, new Map(), new Map(), Date.now());
        expect(result.runnable.length).toBe(1);
        expect(result.runnable[0].nodeId).toBe("a");
    });
});
describe("buildStateKey", () => {
    test("combines nodeId and iteration", () => {
        expect(buildStateKey("task-1", 0)).toBe("task-1::0");
        expect(buildStateKey("task-1", 3)).toBe("task-1::3");
    });
});
