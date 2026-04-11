import { describe, expect, it } from "bun:test";
import { Readable } from "node:stream";
import React from "react";
import { z } from "zod";
import {
  Approval,
  ApprovalGate,
  Aspects,
  Branch,
  CheckSuite,
  ClassifyAndRoute,
  ContentPipeline,
  ContinueAsNew,
  Debate,
  DecisionTable,
  DriftDetector,
  EscalationChain,
  GatherAndSynthesize,
  HumanTask,
  Kanban,
  Loop,
  MergeQueue,
  Optimizer,
  Panel,
  Parallel,
  Poller,
  Ralph,
  ReviewLoop,
  Runbook,
  Saga,
  Sandbox,
  ScanFixVerify,
  Sequence,
  Signal,
  Subflow,
  SuperSmithers,
  Supervisor,
  Task,
  Timer,
  TryCatchFinally,
  Voice,
  WaitForEvent,
  Workflow,
  Worktree,
} from "../src/components/index";
import { SmithersRenderer } from "../src/reconciler";
import type { HostNode, WorkflowGraph } from "@smithers/graph/types";

function graphFrom(root: HostNode | null): WorkflowGraph {
  return {
    xml: root as any,
    tasks: [],
    mountedTaskIds: [],
  };
}

function elements(root: HostNode | null): Array<Extract<HostNode, { kind: "element" }>> {
  const found: Array<Extract<HostNode, { kind: "element" }>> = [];
  function walk(node: HostNode | null) {
    if (!node || node.kind === "text") return;
    found.push(node);
    for (const child of node.children) walk(child);
  }
  walk(root);
  return found;
}

describe("components", () => {
  it("exports every component ported from core", () => {
    const exported = {
      Approval,
      ApprovalGate,
      Aspects,
      Branch,
      CheckSuite,
      ClassifyAndRoute,
      ContentPipeline,
      ContinueAsNew,
      Debate,
      DecisionTable,
      DriftDetector,
      EscalationChain,
      GatherAndSynthesize,
      HumanTask,
      Kanban,
      Loop,
      MergeQueue,
      Optimizer,
      Panel,
      Parallel,
      Poller,
      Ralph,
      ReviewLoop,
      Runbook,
      Saga,
      Sandbox,
      ScanFixVerify,
      Sequence,
      Signal,
      Subflow,
      SuperSmithers,
      Supervisor,
      Task,
      Timer,
      TryCatchFinally,
      Voice,
      WaitForEvent,
      Workflow,
      Worktree,
    };

    expect(Object.entries(exported).filter(([, value]) => typeof value !== "function")).toEqual([]);
  });

  it("renders primitive components as smithers-prefixed host elements", async () => {
    const outputSchema = z.object({ value: z.string() });
    const signalSchema = z.object({ changed: z.boolean() });
    const renderer = new SmithersRenderer({ extractGraph: graphFrom });
    const voiceProvider = {
      name: "test-voice",
      speak: async () => Readable.from([]),
    };

    await renderer.render(
      React.createElement(
        Workflow,
        { name: "demo", cache: true },
        React.createElement(
          Sequence,
          null,
          React.createElement(
            Worktree,
            { id: "wt", path: "." },
            React.createElement(
              Voice,
              { provider: voiceProvider, speaker: "narrator" },
              React.createElement(
                Parallel,
                { id: "group", maxConcurrency: 2 },
                React.createElement(
                  Task,
                  {
                    id: "task-a",
                    output: outputSchema,
                    agent: { generate: async () => "ok" },
                  },
                  "Do work",
                ),
                React.createElement(Approval, {
                  id: "approve-a",
                  output: outputSchema,
                  request: { title: "Approve A" },
                }),
                React.createElement(Timer, {
                  id: "timer-a",
                  duration: "1s",
                }),
                React.createElement(Signal, {
                  id: "signal-a",
                  schema: signalSchema,
                }),
                React.createElement(Sandbox, {
                  id: "sandbox-a",
                  output: outputSchema,
                  workflow: () => null,
                }),
              ),
            ),
          ),
        ),
      ),
    );

    const tags = elements(renderer.getRoot()).map((node) => node.tag);
    expect(tags).toContain("smithers:workflow");
    expect(tags).toContain("smithers:sequence");
    expect(tags).toContain("smithers:worktree");
    expect(tags).toContain("smithers:voice");
    expect(tags).toContain("smithers:parallel");
    expect(tags.filter((tag) => tag === "smithers:task")).toHaveLength(2);
    expect(tags).toContain("smithers:timer");
    expect(tags).toContain("smithers:wait-for-event");
    expect(tags).toContain("smithers:sandbox");
  });

  it("honors skipIf on structural components", async () => {
    const renderer = new SmithersRenderer({ extractGraph: graphFrom });

    await renderer.render(
      React.createElement(
        Sequence,
        null,
        React.createElement(Parallel, { skipIf: true }, "hidden"),
        React.createElement(Timer, { id: "timer", duration: "1s" }),
      ),
    );

    const tags = elements(renderer.getRoot()).map((node) => node.tag);
    expect(tags).not.toContain("smithers:parallel");
    expect(tags).toContain("smithers:timer");
  });

  it("passes task props through to @smithers/core extraction", async () => {
    const outputSchema = z.object({ value: z.number() });
    const primary = { generate: async () => ({ value: 1 }) };
    const fallback = { generate: async () => ({ value: 2 }) };
    const scorers = {
      quality: {
        scorer: {
          id: "quality",
          name: "Quality",
          description: "Quality score",
          score: async () => ({ score: 1 }),
        },
      },
    };
    const memory = {
      recall: {
        namespace: { kind: "global" as const, id: "test" },
      },
    };
    const renderer = new SmithersRenderer();

    const graph = await renderer.render(
      React.createElement(
        Task,
        {
          id: "task-full",
          output: outputSchema,
          outputSchema,
          agent: primary,
          fallbackAgent: fallback,
          dependsOn: ["ready"],
          needs: { input: "ready" },
          needsApproval: true,
          async: true,
          timeoutMs: 100,
          heartbeatTimeoutMs: 50,
          retries: 2,
          retryPolicy: { backoff: "linear", initialDelayMs: 10 },
          continueOnFail: true,
          cache: { key: "cache-key", scope: "run" },
          scorers,
          memory,
          allowTools: ["Read"],
          label: "Full task",
          meta: { feature: "props" },
        },
        "Do the work",
      ),
    );

    const task = graph.tasks[0]!;
    expect(task.nodeId).toBe("task-full");
    expect(task.dependsOn).toEqual(["ready"]);
    expect(task.needs).toEqual({ input: "ready" });
    expect(task.needsApproval).toBe(true);
    expect(task.waitAsync).toBe(true);
    expect(task.timeoutMs).toBe(100);
    expect(task.heartbeatTimeoutMs).toBe(50);
    expect(task.retries).toBe(2);
    expect(task.retryPolicy).toEqual({ backoff: "linear", initialDelayMs: 10 });
    expect(task.continueOnFail).toBe(true);
    expect(task.cachePolicy).toEqual({ key: "cache-key", scope: "run" });
    expect(task.scorers).toEqual(scorers);
    expect(task.memoryConfig).toEqual(memory);
    expect(task.label).toBe("Full task");
    expect(task.meta).toEqual({ feature: "props" });
    expect(Array.isArray(task.agent)).toBe(true);
    expect(task.prompt).toBe("Do the work");
  });
});
