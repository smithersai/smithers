import { describe, expect, test } from "bun:test";
import { applyDelta } from "../src/applyDelta.js";
import { diffSnapshots } from "../src/diffSnapshots.js";
import type { DevToolsNode } from "../src/DevToolsNode.ts";
import type { DevToolsSnapshotV1 } from "../src/DevToolsSnapshotV1.ts";

function node(
  id: number,
  children: DevToolsNode[] = [],
  props: Record<string, unknown> = {},
): DevToolsNode {
  return {
    id,
    type: "task",
    name: `node-${id}`,
    props,
    task: { nodeId: `task-${id}`, kind: "static", iteration: 0 },
    children,
    depth: 0,
  };
}

function withDepth(root: DevToolsNode): DevToolsNode {
  const copy = structuredClone(root);
  const stack: Array<{ node: DevToolsNode; depth: number }> = [{ node: copy, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    current.node.depth = current.depth;
    for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: current.node.children[index], depth: current.depth + 1 });
    }
  }
  return copy;
}

function snapshot(seq: number, root: DevToolsNode): DevToolsSnapshotV1 {
  return {
    version: 1,
    runId: "run-diff",
    frameNo: seq,
    seq,
    root: withDepth(root),
  };
}

function wideTree(count: number): DevToolsNode {
  return node(1, Array.from({ length: count }, (_, index) => node(index + 2)));
}

describe("diffSnapshots + applyDelta round trip", () => {
  const cases: Array<{ name: string; from: DevToolsSnapshotV1; to: DevToolsSnapshotV1 }> = [
    {
      name: "empty to single root child",
      from: snapshot(1, node(1, [])),
      to: snapshot(2, node(1, [node(2)])),
    },
    {
      name: "single root to nested 5-deep",
      from: snapshot(3, node(1, [node(2)])),
      to: snapshot(4, node(1, [node(2, [node(3, [node(4, [node(5, [node(6)])])])])])),
    },
    {
      name: "nested 5-deep to flat 20-wide",
      from: snapshot(5, node(1, [node(2, [node(3, [node(4, [node(5, [node(6)])])])])])),
      to: snapshot(6, wideTree(20)),
    },
    {
      name: "swap two siblings",
      from: snapshot(7, node(1, [node(2), node(3)])),
      to: snapshot(8, node(1, [node(3), node(2)])),
    },
    {
      name: "change only props on a leaf",
      from: snapshot(9, node(1, [node(2, [node(3, [], { value: "a" })])])),
      to: snapshot(10, node(1, [node(2, [node(3, [], { value: "b" })])])),
    },
    {
      name: "change only task sidecar on a leaf",
      from: snapshot(11, node(1, [node(2)])),
      to: snapshot(12, {
        ...node(1, [
          {
            ...node(2),
            task: { nodeId: "task-2", kind: "agent", agent: "claude", iteration: 2 },
          },
        ]),
      }),
    },
    {
      name: "100-node no-op",
      from: snapshot(13, wideTree(100)),
      to: snapshot(14, wideTree(100)),
    },
    {
      name: "1000-node tree deletes half subtree",
      from: snapshot(15, wideTree(1000)),
      to: snapshot(16, wideTree(500)),
    },
  ];

  for (const scenario of cases) {
    test(scenario.name, () => {
      const delta = diffSnapshots(scenario.from, scenario.to);
      const patched = applyDelta(scenario.from, delta);
      expect(patched).toEqual(scenario.to);
      if (scenario.name === "100-node no-op") {
        expect(delta.ops).toEqual([]);
      }
    });
  }

  test("empty root becomes real root: diff emits replaceRoot, applyDelta rehydrates", () => {
    const empty = snapshot(100, node(0, []));
    empty.root.name = "(empty)";
    const filled = snapshot(
      101,
      (() => {
        const root: DevToolsNode = {
          id: 42,
          type: "workflow",
          name: "hello",
          props: {},
          children: [node(2, [], { value: "hi" })],
          depth: 0,
        };
        return root;
      })(),
    );
    const delta = diffSnapshots(empty, filled);
    expect(delta.ops.length).toBe(1);
    expect(delta.ops[0]).toMatchObject({ op: "replaceRoot" });
    const patched = applyDelta(empty, delta);
    expect(patched).toEqual(filled);
  });

  test("round-trips unicode props on child nodes", () => {
    const unicode = "ユニコード🎉";
    const from = snapshot(17, node(1, [node(2, [], { value: "plain" })]));
    const toRoot: DevToolsNode = {
      id: 1,
      type: "task",
      name: "node-1",
      props: {},
      task: { nodeId: "task-1", kind: "static", iteration: 0 },
      children: [
        {
          id: 2,
          type: "task",
          name: "node-2",
          props: { value: unicode, nested: { emoji: "✨" } },
          task: { nodeId: `task-${unicode}`, kind: "agent", agent: unicode, iteration: 0 },
          children: [],
          depth: 1,
        },
      ],
      depth: 0,
    };
    const to = snapshot(18, toRoot);
    const delta = diffSnapshots(from, to);
    const patched = applyDelta(from, delta);
    expect(patched).toEqual(to);
    expect((patched.root.children[0]?.props.value as string)).toBe(unicode);
  });

  test("meets perf budget for 500-node diff with 10 changes (<10ms p95)", () => {
    const baseline = wideTree(500);
    const mutated = structuredClone(baseline);
    for (let index = 0; index < 10; index += 1) {
      (mutated.children[index].props as Record<string, unknown>).value = `changed-${index}`;
    }
    const from = snapshot(200, baseline);
    const to = snapshot(201, mutated);
    const samples: number[] = [];
    for (let trial = 0; trial < 30; trial += 1) {
      const started = performance.now();
      diffSnapshots(from, to);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
    expect(p95).toBeLessThan(10);
  });
});
