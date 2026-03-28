/**
 * DevTools prototype — attacking the hard / uncertain parts:
 *
 * 1. Can Bippy intercept a CUSTOM react-reconciler (not react-dom)?
 * 2. Can we map fibers back to Smithers concepts through wrapper fibers?
 * 3. Can we extract task metadata (nodeId, agent, kind) from memoizedProps?
 * 4. Does multi-commit tracking work (re-renders updating the snapshot)?
 * 5. Do nested structures resolve correctly (Parallel inside Sequence, etc.)?
 * 6. Does printTree produce readable output?
 * 7. Are snapshot counts accurate?
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { installRDTHook } from "bippy";

// Install BEFORE any React/Smithers code loads
if (!("__REACT_DEVTOOLS_GLOBAL_HOOK__" in globalThis)) {
  installRDTHook();
}

describe("devtools: bippy + custom reconciler", () => {
  // These are populated in beforeAll via dynamic imports
  let devtools: any;
  let React: any;
  let SmithersRenderer: any;
  let Task: any;
  let Workflow: any;
  let Sequence: any;
  let Parallel: any;
  let Loop: any;
  let Branch: any;
  let outputSchemas: any;
  const commits: Array<{ event: string; snapshot: any }> = [];

  beforeAll(async () => {
    // Import devtools FIRST so instrument() runs before renderer loads
    const devtoolsMod = await import("../src/devtools/SmithersDevTools");

    devtools = new devtoolsMod.SmithersDevTools({
      onCommit(event: string, snapshot: any) {
        commits.push({ event, snapshot });
      },
    });
    devtools.start();

    // NOW import React/Smithers (reconciler will see the installed hook)
    const [rendererMod, componentsMod, schemaMod, reactMod] =
      await Promise.all([
        import("../src/dom/renderer"),
        import("../src/components"),
        import("./schema"),
        import("react"),
      ]);

    React = reactMod.default;
    SmithersRenderer = rendererMod.SmithersRenderer;
    Task = componentsMod.Task;
    Workflow = componentsMod.Workflow;
    Sequence = componentsMod.Sequence;
    Parallel = componentsMod.Parallel;
    Loop = componentsMod.Loop;
    Branch = componentsMod.Branch;
    outputSchemas = schemaMod.outputSchemas;
  });

  // Helper: React.createElement shorthand
  function h(type: any, props?: any, ...children: any[]) {
    return React.createElement(type, props, ...children);
  }

  // ---------------------------------------------------------------------------
  // CHALLENGE 1: Bippy intercepting a custom reconciler
  // ---------------------------------------------------------------------------

  test("challenge 1: bippy intercepts smithers custom reconciler commits", async () => {
    const renderer = new SmithersRenderer();
    const commitsBefore = commits.length;

    await renderer.render(
      h(Workflow, { name: "test-intercept" },
        h(Task, { id: "t1", output: outputSchemas.outputA }, { value: 42 }),
      ),
    );

    expect(commits.length).toBeGreaterThan(commitsBefore);
    expect(commits[commits.length - 1].event).toBe("commit");
  });

  // ---------------------------------------------------------------------------
  // CHALLENGE 2: Fiber → Smithers node mapping through wrapper components
  // ---------------------------------------------------------------------------

  test("challenge 2: maps fiber tree to smithers node types", async () => {
    const renderer = new SmithersRenderer();

    await renderer.render(
      h(Workflow, { name: "mapping-test" },
        h(Sequence, null,
          h(Task, { id: "step1", output: outputSchemas.outputA }, { value: 1 }),
          h(Task, { id: "step2", output: outputSchemas.outputB }, { value: 2 }),
        ),
      ),
    );

    const tree = devtools.tree;
    expect(tree).not.toBeNull();
    expect(tree.type).toBe("workflow");

    const seq = tree.children.find((c: any) => c.type === "sequence");
    expect(seq).toBeDefined();

    const tasks = devtools.listTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(2);

    const t1 = devtools.findTask("step1");
    const t2 = devtools.findTask("step2");
    expect(t1).not.toBeNull();
    expect(t2).not.toBeNull();
    expect(t1.type).toBe("task");
    expect(t2.type).toBe("task");
  });

  // ---------------------------------------------------------------------------
  // CHALLENGE 3: Task metadata extraction from memoizedProps
  // ---------------------------------------------------------------------------

  test("challenge 3: extracts task metadata (kind, nodeId, label)", async () => {
    const renderer = new SmithersRenderer();

    await renderer.render(
      h(Workflow, { name: "metadata-test" },
        h(Task, {
          id: "compute-task",
          output: outputSchemas.outputA,
          label: "My Compute",
          children: () => ({ value: 42 }),
        }),
        h(Task, {
          id: "static-task",
          output: outputSchemas.outputB,
          children: { value: 99 },
        }),
      ),
    );

    const compute = devtools.findTask("compute-task");
    expect(compute).not.toBeNull();
    expect(compute.task).toBeDefined();
    expect(compute.task.nodeId).toBe("compute-task");
    expect(compute.task.kind).toBe("compute");
    expect(compute.task.label).toBe("My Compute");

    const staticTask = devtools.findTask("static-task");
    expect(staticTask).not.toBeNull();
    expect(staticTask.task).toBeDefined();
    expect(staticTask.task.nodeId).toBe("static-task");
    expect(staticTask.task.kind).toBe("static");
  });

  // ---------------------------------------------------------------------------
  // CHALLENGE 4: Multi-commit tracking (re-renders)
  // ---------------------------------------------------------------------------

  test("challenge 4: tracks multiple commits (re-renders)", async () => {
    const renderer = new SmithersRenderer();

    // First render
    await renderer.render(
      h(Workflow, { name: "multi-commit" },
        h(Task, { id: "first", output: outputSchemas.outputA }, { value: 1 }),
      ),
    );

    const snap1 = devtools.snapshot;
    expect(snap1).not.toBeNull();

    // Second render — simulates re-render after task completion
    await renderer.render(
      h(Workflow, { name: "multi-commit" },
        h(Task, { id: "first", output: outputSchemas.outputA, skipIf: true }, { value: 1 }),
        h(Task, { id: "second", output: outputSchemas.outputB }, { value: 2 }),
      ),
    );

    const snap2 = devtools.snapshot;
    expect(snap2).not.toBeNull();
    expect(snap2.timestamp).toBeGreaterThanOrEqual(snap1.timestamp);

    const second = devtools.findTask("second");
    expect(second).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // CHALLENGE 5: Nested / complex structures
  // ---------------------------------------------------------------------------

  test("challenge 5: handles nested parallel/sequence/branch/loop", async () => {
    const renderer = new SmithersRenderer();

    await renderer.render(
      h(Workflow, { name: "nested-test" },
        h(Sequence, null,
          h(Task, { id: "setup", output: outputSchemas.outputA }, { value: 0 }),
          h(Parallel, null,
            h(Task, { id: "par-a", output: outputSchemas.outputB }, { value: 1 }),
            h(Task, { id: "par-b", output: outputSchemas.outputC }, { value: 2 }),
          ),
          h(Branch, { if: true },
            h(Task, { id: "branch-true", output: outputSchemas.outputA }, { value: 3 }),
          ),
          h(Loop, { until: false, maxIterations: 3 },
            h(Task, { id: "loop-task", output: outputSchemas.outputB }, { value: 4 }),
          ),
        ),
      ),
    );

    const tree = devtools.tree;
    expect(tree).not.toBeNull();
    expect(tree.type).toBe("workflow");

    // Collect all node types
    const allTypes = new Set<string>();
    function collectTypes(node: any) {
      allTypes.add(node.type);
      for (const child of node.children) collectTypes(child);
    }
    collectTypes(tree);

    expect(allTypes.has("workflow")).toBe(true);
    expect(allTypes.has("sequence")).toBe(true);
    expect(allTypes.has("parallel")).toBe(true);
    expect(allTypes.has("task")).toBe(true);
    expect(allTypes.has("loop")).toBe(true);

    // Verify task discovery through nesting
    const tasks = devtools.listTasks();
    const taskIds = tasks.map((t: any) => t.task?.nodeId).filter(Boolean);
    expect(taskIds).toContain("setup");
    expect(taskIds).toContain("par-a");
    expect(taskIds).toContain("par-b");
    expect(taskIds).toContain("loop-task");

    // Nested tasks should have greater depth
    const parA = devtools.findTask("par-a");
    const setup = devtools.findTask("setup");
    expect(parA).not.toBeNull();
    expect(setup).not.toBeNull();
    expect(parA.depth).toBeGreaterThan(setup.depth);
  });

  // ---------------------------------------------------------------------------
  // CHALLENGE 6: printTree output
  // ---------------------------------------------------------------------------

  test("challenge 6: printTree produces readable output", async () => {
    const renderer = new SmithersRenderer();

    await renderer.render(
      h(Workflow, { name: "print-test" },
        h(Sequence, null,
          h(Task, {
            id: "a",
            output: outputSchemas.outputA,
            label: "Setup",
            children: { value: 1 },
          }),
          h(Parallel, null,
            h(Task, { id: "b", output: outputSchemas.outputB }, { value: 2 }),
            h(Task, { id: "c", output: outputSchemas.outputC }, { value: 3 }),
          ),
        ),
      ),
    );

    const printed = devtools.printTree();
    expect(printed).toContain("workflow");
    expect(printed).toContain("sequence");
    expect(printed).toContain("parallel");
    expect(printed).toContain("task");
    expect(printed).toContain("[a]");
    expect(printed).toContain("[b]");
    expect(printed).toContain("[c]");
    expect(printed).toContain("Setup");
  });

  // ---------------------------------------------------------------------------
  // CHALLENGE 7: Snapshot counts are accurate
  // ---------------------------------------------------------------------------

  test("challenge 7: snapshot counts nodes and tasks correctly", async () => {
    const renderer = new SmithersRenderer();

    await renderer.render(
      h(Workflow, { name: "count-test" },
        h(Sequence, null,
          h(Task, { id: "x", output: outputSchemas.outputA }, { value: 1 }),
          h(Task, { id: "y", output: outputSchemas.outputB }, { value: 2 }),
          h(Task, { id: "z", output: outputSchemas.outputC }, { value: 3 }),
        ),
      ),
    );

    const snap = devtools.snapshot;
    expect(snap).not.toBeNull();
    expect(snap.taskCount).toBe(3);
    // At minimum: workflow + sequence + 3 tasks = 5
    expect(snap.nodeCount).toBeGreaterThanOrEqual(5);
  });

  // ---------------------------------------------------------------------------
  // CHALLENGE 8: Smithers event bus integration — task execution tracking
  // ---------------------------------------------------------------------------

  test("challenge 8: tracks task execution state via EventBus", async () => {
    const { EventBus } = await import("../src/events");
    const bus = new EventBus({});

    // Attach devtools to the event bus
    devtools.attachEventBus(bus);

    const runId = "test-run-8";
    const now = Date.now();

    await bus.emitEvent({ type: "RunStarted", runId, timestampMs: now });
    await bus.emitEvent({ type: "NodePending", runId, nodeId: "t1", iteration: 0, timestampMs: now + 1 });
    await bus.emitEvent({ type: "NodeStarted", runId, nodeId: "t1", iteration: 0, attempt: 1, timestampMs: now + 2 });
    await bus.emitEvent({ type: "ToolCallStarted", runId, nodeId: "t1", iteration: 0, attempt: 1, toolName: "bash", seq: 0, timestampMs: now + 3 });
    await bus.emitEvent({ type: "ToolCallFinished", runId, nodeId: "t1", iteration: 0, attempt: 1, toolName: "bash", seq: 0, status: "success", timestampMs: now + 4 });
    await bus.emitEvent({ type: "NodeFinished", runId, nodeId: "t1", iteration: 0, attempt: 1, timestampMs: now + 5 });
    await bus.emitEvent({ type: "RunFinished", runId, timestampMs: now + 6 });

    // Verify run state
    const run = devtools.getRun(runId);
    expect(run).toBeDefined();
    expect(run!.status).toBe("finished");
    expect(run!.startedAt).toBe(now);
    expect(run!.finishedAt).toBe(now + 6);
    expect(run!.events.length).toBe(7);

    // Verify task state
    const task = devtools.getTaskState(runId, "t1");
    expect(task).toBeDefined();
    expect(task!.status).toBe("finished");
    expect(task!.nodeId).toBe("t1");
    expect(task!.attempt).toBe(1);
    expect(task!.startedAt).toBe(now + 2);
    expect(task!.finishedAt).toBe(now + 5);
    expect(task!.toolCalls.length).toBe(1);
    expect(task!.toolCalls[0].name).toBe("bash");
    expect(task!.toolCalls[0].status).toBe("success");
  });

  // ---------------------------------------------------------------------------
  // CHALLENGE 9: Failure/retry tracking
  // ---------------------------------------------------------------------------

  test("challenge 9: tracks retries and failures", async () => {
    const { EventBus } = await import("../src/events");
    const bus = new EventBus({});
    devtools.attachEventBus(bus);

    const runId = "test-run-9";
    const now = Date.now();

    await bus.emitEvent({ type: "RunStarted", runId, timestampMs: now });
    await bus.emitEvent({ type: "NodeStarted", runId, nodeId: "flaky", iteration: 0, attempt: 1, timestampMs: now + 1 });
    await bus.emitEvent({ type: "NodeFailed", runId, nodeId: "flaky", iteration: 0, attempt: 1, error: new Error("timeout"), timestampMs: now + 2 });
    await bus.emitEvent({ type: "NodeRetrying", runId, nodeId: "flaky", iteration: 0, attempt: 2, timestampMs: now + 3 });
    await bus.emitEvent({ type: "NodeStarted", runId, nodeId: "flaky", iteration: 0, attempt: 2, timestampMs: now + 4 });
    await bus.emitEvent({ type: "NodeFinished", runId, nodeId: "flaky", iteration: 0, attempt: 2, timestampMs: now + 5 });

    const task = devtools.getTaskState(runId, "flaky");
    expect(task).toBeDefined();
    expect(task!.status).toBe("finished");
    expect(task!.attempt).toBe(2); // succeeded on second attempt
  });

  // ---------------------------------------------------------------------------
  // CHALLENGE 10: Approval workflow tracking
  // ---------------------------------------------------------------------------

  test("challenge 10: tracks approval workflow state", async () => {
    const { EventBus } = await import("../src/events");
    const bus = new EventBus({});
    devtools.attachEventBus(bus);

    const runId = "test-run-10";
    const now = Date.now();

    await bus.emitEvent({ type: "RunStarted", runId, timestampMs: now });
    await bus.emitEvent({ type: "NodeWaitingApproval", runId, nodeId: "review", iteration: 0, timestampMs: now + 1 });

    let run = devtools.getRun(runId);
    expect(run!.status).toBe("waiting-approval");

    const task = devtools.getTaskState(runId, "review");
    expect(task!.status).toBe("waiting-approval");
  });

  // ---------------------------------------------------------------------------
  // CHALLENGE 11: Frame tracking (re-renders after task completion)
  // ---------------------------------------------------------------------------

  test("challenge 11: tracks frame commits", async () => {
    const { EventBus } = await import("../src/events");
    const bus = new EventBus({});
    devtools.attachEventBus(bus);

    const runId = "test-run-11";
    const now = Date.now();

    await bus.emitEvent({ type: "RunStarted", runId, timestampMs: now });
    await bus.emitEvent({ type: "FrameCommitted", runId, frameNo: 1, xmlHash: "abc123", timestampMs: now + 1 });
    await bus.emitEvent({ type: "FrameCommitted", runId, frameNo: 2, xmlHash: "def456", timestampMs: now + 2 });

    const run = devtools.getRun(runId);
    expect(run!.frameNo).toBe(2);
  });
});
