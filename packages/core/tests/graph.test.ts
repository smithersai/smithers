import { describe, expect, test } from "bun:test";
import {
  extractGraph,
  type HostElement,
  type HostNode,
  type HostText,
} from "../src/graph.ts";

function hostEl(
  tag: string,
  rawProps: Record<string, unknown> = {},
  children: HostNode[] = [],
): HostElement {
  const props: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawProps)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      props[key] = String(value);
    }
  }
  return { kind: "element", tag, props, rawProps, children };
}

function hostText(text: string): HostText {
  return { kind: "text", text };
}

describe("extractGraph", () => {
  test("returns an empty graph for null root", () => {
    const graph = extractGraph(null);
    expect(graph.xml).toBeNull();
    expect(graph.tasks).toEqual([]);
    expect(graph.mountedTaskIds).toEqual([]);
  });

  test("extracts task descriptors without React", () => {
    const graph = extractGraph(
      hostEl("smithers:workflow", {}, [
        hostEl("smithers:task", {
          id: "plan",
          output: "plans",
          __smithersKind: "static",
          __smithersPayload: { title: "Ship" },
        }),
      ]),
    );

    expect(graph.xml).toEqual({
      kind: "element",
      tag: "smithers:workflow",
      props: {},
      children: [
        {
          kind: "element",
          tag: "smithers:task",
          props: {
            id: "plan",
            output: "plans",
            __smithersKind: "static",
          },
          children: [],
        },
      ],
    });
    expect(graph.tasks).toHaveLength(1);
    expect(graph.tasks[0].nodeId).toBe("plan");
    expect(graph.tasks[0].outputTableName).toBe("plans");
    expect(graph.tasks[0].staticPayload).toEqual({ title: "Ship" });
    expect(graph.mountedTaskIds).toEqual(["plan::0"]);
  });

  test("extracts merge queue concurrency and ralph iteration", () => {
    const graph = extractGraph(
      hostEl("smithers:ralph", { id: "loop" }, [
        hostEl("smithers:merge-queue", {}, [
          hostEl("smithers:task", { id: "a", output: "rows" }),
          hostEl("smithers:task", { id: "b", output: "rows" }),
        ]),
      ]),
      { ralphIterations: new Map([["loop", 3]]) },
    );

    expect(graph.tasks.map((task) => task.iteration)).toEqual([3, 3]);
    expect(graph.tasks[0].parallelGroupId).toBe(graph.tasks[1].parallelGroupId);
    expect(graph.tasks[0].parallelMaxConcurrency).toBe(1);
  });

  test("walks branch-like groups and preserves nested task descriptors", () => {
    const graph = extractGraph(
      hostEl("smithers:branch", {}, [
        hostEl("smithers:task", { id: "chosen", output: "rows" }),
      ]),
    );

    expect(graph.tasks.map((task) => task.nodeId)).toEqual(["chosen"]);
    expect(graph.xml?.kind).toBe("element");
  });

  test("extracts worktree, voice, approval, and async wait metadata", () => {
    const provider = { speak: true };
    const graph = extractGraph(
      hostEl("smithers:worktree", { id: "wt", path: "feature", branch: "b" }, [
        hostEl("smithers:voice", { provider, speaker: "will" }, [
          hostEl("smithers:task", {
            id: "review",
            output: "rows",
            needsApproval: true,
            approvalMode: "select",
            approvalOnDeny: "continue",
            approvalOptions: [{ key: "yes", label: "Yes" }],
          }),
          hostEl("smithers:wait-for-event", {
            id: "wait",
            output: "events",
            event: "ready",
            correlationId: "c1",
          }),
        ]),
      ]),
      { baseRootDir: "/tmp/project" },
    );

    expect(graph.tasks).toHaveLength(2);
    expect(graph.tasks[0].worktreeId).toBe("wt");
    expect(graph.tasks[0].worktreePath).toBe("/tmp/project/feature");
    expect(graph.tasks[0].worktreeBranch).toBe("b");
    expect(graph.tasks[0].voice).toBe(provider);
    expect(graph.tasks[0].voiceSpeaker).toBe("will");
    expect(graph.tasks[0].needsApproval).toBe(true);
    expect(graph.tasks[0].approvalMode).toBe("select");
    expect(graph.tasks[0].approvalOptions).toEqual([{ key: "yes", label: "Yes" }]);
    expect(graph.tasks[1].meta).toMatchObject({
      __waitForEvent: true,
      __eventName: "ready",
      __correlationId: "c1",
    });
  });

  test("extracts subflow, sandbox, timer, check-suite-like, poller-like, and debate-like structures", () => {
    const graph = extractGraph(
      hostEl("smithers:workflow", {}, [
        hostEl("smithers:subflow", { id: "child", output: "children" }),
        hostEl("smithers:sandbox", { id: "box", output: "sandboxes", runtime: "macos" }),
        hostEl("smithers:timer", { id: "sleep", duration: "10s" }),
        hostEl("smithers:check-suite", {}, [
          hostEl("smithers:task", { id: "check", output: "checks" }),
        ]),
        hostEl("smithers:poller", {}, [
          hostEl("smithers:task", { id: "poll", output: "polls" }),
        ]),
        hostEl("smithers:debate", {}, [
          hostEl("smithers:parallel", {}, [
            hostEl("smithers:task", { id: "for", output: "votes" }),
            hostEl("smithers:task", { id: "against", output: "votes" }),
          ]),
        ]),
      ]),
    );

    expect(graph.tasks.map((task) => task.nodeId)).toEqual([
      "child",
      "box",
      "sleep",
      "check",
      "poll",
      "for",
      "against",
    ]);
    expect(graph.tasks.find((task) => task.nodeId === "child")?.meta).toMatchObject({
      __subflow: true,
    });
    expect(graph.tasks.find((task) => task.nodeId === "box")?.meta).toMatchObject({
      __sandbox: true,
      __sandboxRuntime: "macos",
    });
    expect(graph.tasks.find((task) => task.nodeId === "sleep")?.meta).toMatchObject({
      __timer: true,
      __timerDuration: "10s",
    });
    expect(graph.tasks.find((task) => task.nodeId === "for")?.parallelGroupId).toBe(
      graph.tasks.find((task) => task.nodeId === "against")?.parallelGroupId,
    );
  });

  test("uses scoped ralph iterations in mounted ids", () => {
    const graph = extractGraph(
      hostEl("smithers:ralph", { id: "loop" }, [
        hostEl("smithers:task", { id: "step", output: "rows" }),
      ]),
      { ralphIterations: { loop: 2 } },
    );

    expect(graph.tasks[0].iteration).toBe(2);
    expect(graph.tasks[0].ralphId).toBe("loop");
    expect(graph.mountedTaskIds).toEqual(["step::2"]);
  });

  test("throws for invalid duplicate task ids", () => {
    const root = hostEl("smithers:workflow", {}, [
      hostEl("smithers:task", { id: "dup", output: "rows" }),
      hostEl("smithers:task", { id: "dup", output: "rows" }),
    ]);
    expect(() => extractGraph(root)).toThrow("Duplicate");
  });

  test("preserves text nodes in xml extraction", () => {
    const graph = extractGraph(hostEl("section", {}, [hostText("hello")]));
    expect(graph.xml).toEqual({
      kind: "element",
      tag: "section",
      props: {},
      children: [{ kind: "text", text: "hello" }],
    });
  });

  test("throws the MDX preload error when agent prompt renders as an object", () => {
    const root = hostEl("smithers:task", {
      id: "agent",
      output: "rows",
      agent: {},
      __smithersKind: "agent",
      children: {},
    });

    try {
      extractGraph(root);
      throw new Error("expected extractGraph to throw");
    } catch (error) {
      expect((error as { readonly code?: string }).code).toBe("MDX_PRELOAD_INACTIVE");
    }
  });
});
