import { describe, expect, test } from "bun:test";
import { buildSnapshot } from "../src/buildSnapshot.js";
import { collectTasks } from "../src/collectTasks.js";
import { countNodes } from "../src/countNodes.js";
import { findNodeById } from "../src/findNodeById.js";
import { printTree } from "../src/printTree.js";
import type { DevToolsNode } from "../src/DevToolsNode.ts";

function tree(): DevToolsNode {
  return {
    id: 1,
    type: "workflow",
    name: "Root",
    props: { name: "Root" },
    depth: 0,
    children: [
      {
        id: 2,
        type: "sequence",
        name: "Sequence",
        props: {},
        depth: 1,
        children: [
          {
            id: 3,
            type: "task",
            name: "Task",
            props: {},
            task: {
              nodeId: "task-a",
              kind: "agent",
              agent: "gpt-5",
              label: "do-thing",
            },
            depth: 2,
            children: [],
          },
          {
            id: 4,
            type: "task",
            name: "Task",
            props: {},
            task: { nodeId: "task-b", kind: "static" },
            depth: 2,
            children: [],
          },
        ],
      },
      {
        id: 5,
        type: "parallel",
        name: "Parallel",
        props: {},
        depth: 1,
        children: [
          {
            id: 6,
            type: "task",
            name: "Task",
            props: {},
            task: { nodeId: "task-c", kind: "compute" },
            depth: 2,
            children: [],
          },
        ],
      },
    ],
  };
}

describe("countNodes", () => {
  test("counts nodes and tasks recursively", () => {
    const result = countNodes(tree());
    expect(result.nodes).toBe(6);
    expect(result.tasks).toBe(3);
  });

  test("single-node tree counts correctly", () => {
    const node: DevToolsNode = {
      id: 1,
      type: "task",
      name: "solo",
      props: {},
      task: { nodeId: "solo", kind: "static" },
      depth: 0,
      children: [],
    };
    expect(countNodes(node)).toEqual({ nodes: 1, tasks: 1 });
  });
});

describe("buildSnapshot", () => {
  test("returns empty snapshot for null tree", () => {
    const snap = buildSnapshot(null);
    expect(snap.tree).toBeNull();
    expect(snap.nodeCount).toBe(0);
    expect(snap.taskCount).toBe(0);
    expect(typeof snap.timestamp).toBe("number");
  });

  test("counts nodes and tasks from tree", () => {
    const snap = buildSnapshot(tree());
    expect(snap.nodeCount).toBe(6);
    expect(snap.taskCount).toBe(3);
    expect(snap.tree).toBeTruthy();
  });
});

describe("findNodeById", () => {
  test("finds a task by its nodeId", () => {
    const found = findNodeById(tree(), "task-b");
    expect(found?.task?.nodeId).toBe("task-b");
  });

  test("returns null when nodeId is not present", () => {
    expect(findNodeById(tree(), "nope")).toBeNull();
  });

  test("finds nested tasks inside parallel", () => {
    const found = findNodeById(tree(), "task-c");
    expect(found?.task?.kind).toBe("compute");
  });
});

describe("collectTasks", () => {
  test("returns all tasks in tree order", () => {
    const tasks = collectTasks(tree());
    expect(tasks.map((t) => t.task?.nodeId)).toEqual([
      "task-a",
      "task-b",
      "task-c",
    ]);
  });

  test("returns empty list when no tasks", () => {
    const node: DevToolsNode = {
      id: 1,
      type: "workflow",
      name: "empty",
      props: {},
      depth: 0,
      children: [],
    };
    expect(collectTasks(node)).toEqual([]);
  });
});

describe("printTree", () => {
  test("prints agent task with agent name", () => {
    const out = printTree(tree());
    expect(out).toContain("workflow");
    expect(out).toContain("task [task-a] (gpt-5)");
    expect(out).toContain("task [task-b] (static)");
    expect(out).toContain("task [task-c] (compute)");
  });

  test("indents nested children", () => {
    const out = printTree(tree());
    const lines = out.split("\n");
    const taskLine = lines.find((l) => l.includes("task-a"));
    expect(taskLine?.startsWith("    ")).toBe(true);
  });

  test("uses label when present", () => {
    const out = printTree(tree());
    expect(out).toContain(`"do-thing"`);
  });

  test("falls back to props.name when no task info", () => {
    const node: DevToolsNode = {
      id: 1,
      type: "workflow",
      name: "wf",
      props: { name: "MyFlow" },
      depth: 0,
      children: [],
    };
    const out = printTree(node);
    expect(out).toContain(`"MyFlow"`);
  });
});
