import { describe, expect, test } from "bun:test";
import { SmithersDevToolsCore } from "../src/SmithersDevToolsCore.js";
import type { DevToolsNode } from "../src/DevToolsNode.ts";
import type { DevToolsSnapshot } from "../src/DevToolsSnapshot.ts";

function sampleTree(): DevToolsNode {
  return {
    id: 1,
    type: "workflow",
    name: "wf",
    props: {},
    depth: 0,
    children: [
      {
        id: 2,
        type: "task",
        name: "task",
        props: {},
        task: { nodeId: "a", kind: "static" },
        depth: 1,
        children: [],
      },
    ],
  };
}

describe("SmithersDevToolsCore", () => {
  test("captureSnapshot stores latest snapshot and tree", () => {
    const core = new SmithersDevToolsCore();
    expect(core.snapshot).toBeNull();
    expect(core.tree).toBeNull();
    const snap = core.captureSnapshot(sampleTree());
    expect(snap.nodeCount).toBe(2);
    expect(snap.taskCount).toBe(1);
    expect(core.snapshot).toBe(snap);
    expect(core.tree?.type).toBe("workflow");
  });

  test("emitCommit fires onCommit handler with snapshot", () => {
    const commits: Array<{ event: string; snapshot: DevToolsSnapshot }> = [];
    const core = new SmithersDevToolsCore({
      onCommit(event, snapshot) {
        commits.push({ event, snapshot });
      },
    });
    const snap = core.captureSnapshot(sampleTree());
    core.emitCommit(snap);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.event).toBe("commit");
    expect(commits[0]?.snapshot).toBe(snap);
  });

  test("emitUnmount fires onCommit with unmount event", () => {
    const commits: Array<{ event: string }> = [];
    const core = new SmithersDevToolsCore({
      onCommit(event) {
        commits.push({ event });
      },
    });
    core.captureSnapshot(sampleTree());
    core.emitUnmount();
    expect(commits[0]?.event).toBe("unmount");
  });

  test("findTask and listTasks operate on latest tree", () => {
    const core = new SmithersDevToolsCore();
    expect(core.listTasks()).toEqual([]);
    expect(core.findTask("a")).toBeNull();
    core.captureSnapshot(sampleTree());
    expect(core.listTasks()).toHaveLength(1);
    expect(core.findTask("a")?.task?.nodeId).toBe("a");
  });

  test("printTree returns placeholder before commit, then pretty-prints", () => {
    const core = new SmithersDevToolsCore();
    expect(core.printTree()).toContain("no tree");
    core.captureSnapshot(sampleTree());
    expect(core.printTree()).toContain("workflow");
  });

  test("attachEventBus and engine events drive run/task state", () => {
    type Listener = (event: unknown) => void;
    const listeners: Listener[] = [];
    const bus = {
      on(_event: "event", h: Listener) {
        listeners.push(h);
      },
      removeListener(_event: "event", h: Listener) {
        const i = listeners.indexOf(h);
        if (i >= 0) listeners.splice(i, 1);
      },
      emit(e: unknown) {
        for (const l of listeners.slice()) l(e);
      },
    };
    const core = new SmithersDevToolsCore();
    core.attachEventBus(bus);
    bus.emit({ type: "RunStarted", runId: "r1", timestampMs: 1 });
    expect(core.getRun("r1")?.status).toBe("running");
    core.detachEventBuses();
    expect(listeners).toHaveLength(0);
  });
});
