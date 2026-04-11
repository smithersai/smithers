import { describe, expect, it } from "bun:test";
import React from "react";
import { SmithersRenderer } from "@smithers/react-reconciler";
import type { HostNode, WorkflowGraph } from "@smithers/graph/types";

function graphFrom(root: HostNode | null): WorkflowGraph {
  return {
    xml: root as any,
    tasks: [],
    mountedTaskIds: [],
  };
}

describe("SmithersRenderer", () => {
  it("installs and registers the React DevTools hook for bippy consumers", () => {
    const hook = (globalThis as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
    expect(hook).toBeDefined();
    expect(typeof hook.inject).toBe("function");
  });

  it("uses @smithers/graph extractGraph by default", async () => {
    const renderer = new SmithersRenderer();

    const graph = await renderer.render(
      React.createElement("smithers:task", {
        id: "task-a",
        output: "result",
        __smithersKind: "static",
        __smithersPayload: { value: 1 },
      }),
    );

    expect(graph.tasks).toHaveLength(1);
    expect(graph.tasks[0]?.nodeId).toBe("task-a");
    expect(graph.tasks[0]?.outputTableName).toBe("result");
    expect(graph.tasks[0]?.staticPayload).toEqual({ value: 1 });
  });

  it("builds a HostNode tree and hands it to extractGraph", async () => {
    let captured: unknown = null;
    const renderer = new SmithersRenderer({
      extractGraph: (root) => {
        captured = root;
        return graphFrom(root);
      },
    });

    const graph = await renderer.render(
      React.createElement(
        "smithers:sequence",
        { id: "root", __private: "hidden" },
        React.createElement(
          "smithers:task",
          {
            id: "task-a",
            output: "result",
            enabled: true,
            compute: () => "ignored",
          },
          "Prompt text",
        ),
      ),
    );

    expect(graph.xml).toBe(captured as any);
    expect((captured as HostNode).kind).toBe("element");
    const root = captured as Extract<HostNode, { kind: "element" }>;
    expect(root.tag).toBe("smithers:sequence");
    expect(root.props).toEqual({ id: "root" });
    expect(root.rawProps.__private).toBe("hidden");

    const task = root.children[0] as Extract<HostNode, { kind: "element" }>;
    expect(task.tag).toBe("smithers:task");
    expect(task.props).toEqual({
      id: "task-a",
      output: "result",
      enabled: "true",
    });
    expect(typeof task.rawProps.compute).toBe("function");
    expect(task.children).toEqual([{ kind: "text", text: "Prompt text" }]);
  });

  it("updates the existing container on re-render", async () => {
    const renderer = new SmithersRenderer({ extractGraph: graphFrom });

    await renderer.render(
      React.createElement("smithers:task", { id: "first", output: "out" }),
    );
    await renderer.render(
      React.createElement("smithers:task", { id: "second", output: "out" }),
    );

    const root = renderer.getRoot() as Extract<HostNode, { kind: "element" }>;
    expect(root.tag).toBe("smithers:task");
    expect(root.props.id).toBe("second");
  });
});
