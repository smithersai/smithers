/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { SmithersRenderer } from "../src/dom/renderer.js";
import React from "react";
describe("SmithersRenderer", () => {
    test("renders simple element", async () => {
        const renderer = new SmithersRenderer();
        const result = await renderer.render(React.createElement("smithers:workflow", { name: "test" }));
        expect(result.xml).not.toBeNull();
        if (result.xml?.kind === "element") {
            expect(result.xml.tag).toBe("smithers:workflow");
        }
    });
    test("renders nested elements", async () => {
        const renderer = new SmithersRenderer();
        const result = await renderer.render(React.createElement("smithers:workflow", { name: "test" }, React.createElement("smithers:task", {
            id: "t1",
            output: "out",
            __smithersKind: "static",
            __smithersPayload: { val: 1 },
        })));
        expect(result.tasks).toHaveLength(1);
        expect(result.tasks[0].nodeId).toBe("t1");
    });
    test("renders text children", async () => {
        const renderer = new SmithersRenderer();
        const result = await renderer.render(React.createElement("smithers:task", {
            id: "t1",
            output: "out",
            agent: { generate: async () => ({}) },
            __smithersKind: "agent",
        }, "Write a poem"));
        expect(result.tasks[0].prompt).toBe("Write a poem");
    });
    test("getRoot returns null before render", () => {
        const renderer = new SmithersRenderer();
        expect(renderer.getRoot()).toBeNull();
    });
    test("getRoot returns host node after render", async () => {
        const renderer = new SmithersRenderer();
        await renderer.render(React.createElement("smithers:workflow", { name: "test" }));
        const root = renderer.getRoot();
        expect(root).not.toBeNull();
        expect(root.kind).toBe("element");
    });
    test("handles re-render with updated props", async () => {
        const renderer = new SmithersRenderer();
        await renderer.render(React.createElement("smithers:task", {
            id: "t1",
            output: "out",
            __smithersKind: "static",
            __smithersPayload: { v: 1 },
        }));
        const result = await renderer.render(React.createElement("smithers:task", {
            id: "t1",
            output: "out",
            __smithersKind: "static",
            __smithersPayload: { v: 2 },
        }));
        expect(result.tasks).toHaveLength(1);
    });
    test("renders with multiple parallel tasks", async () => {
        const renderer = new SmithersRenderer();
        const result = await renderer.render(React.createElement("smithers:parallel", null, React.createElement("smithers:task", {
            id: "a",
            output: "out",
        }), React.createElement("smithers:task", {
            id: "b",
            output: "out",
        })));
        expect(result.tasks).toHaveLength(2);
    });
    test("renders React component children", async () => {
        function MyWorkflow() {
            return React.createElement("smithers:workflow", { name: "composed" }, React.createElement("smithers:task", {
                id: "t1",
                output: "out",
            }));
        }
        const renderer = new SmithersRenderer();
        const result = await renderer.render(React.createElement(MyWorkflow));
        expect(result.tasks).toHaveLength(1);
    });
});
