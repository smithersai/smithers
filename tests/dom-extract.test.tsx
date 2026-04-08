/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import {
  extractFromHost,
  type HostElement,
  type HostText,
  type HostNode,
} from "../src/dom/extract";
import { z } from "zod";

function hostEl(
  tag: string,
  rawProps: Record<string, any> = {},
  children: HostNode[] = [],
): HostElement {
  const stringProps: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawProps)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      stringProps[k] = String(v);
    }
  }
  return { kind: "element", tag, props: stringProps, rawProps, children };
}

function hostText(text: string): HostText {
  return { kind: "text", text };
}

describe("extractFromHost", () => {
  test("returns empty result for null root", () => {
    const result = extractFromHost(null);
    expect(result.xml).toBeNull();
    expect(result.tasks).toEqual([]);
    expect(result.mountedTaskIds).toEqual([]);
  });

  test("extracts single task", () => {
    const root = hostEl("smithers:workflow", {}, [
      hostEl("smithers:task", {
        id: "t1",
        output: "my_table",
        __smithersKind: "static",
        __smithersPayload: { value: 1 },
      }),
    ]);
    const result = extractFromHost(root);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].nodeId).toBe("t1");
    expect(result.tasks[0].outputTableName).toBe("my_table");
    expect(result.tasks[0].staticPayload).toEqual({ value: 1 });
  });

  test("extracts ordinals in order", () => {
    const root = hostEl("smithers:workflow", {}, [
      hostEl("smithers:task", { id: "a", output: "t" }),
      hostEl("smithers:task", { id: "b", output: "t" }),
      hostEl("smithers:task", { id: "c", output: "t" }),
    ]);
    const result = extractFromHost(root);
    expect(result.tasks.map((t) => t.ordinal)).toEqual([0, 1, 2]);
  });

  test("throws on missing task id", () => {
    const root = hostEl("smithers:task", { output: "t" });
    expect(() => extractFromHost(root)).toThrow("Task id is required");
  });

  test("throws on missing task output", () => {
    const root = hostEl("smithers:task", { id: "t1" });
    expect(() => extractFromHost(root)).toThrow("missing output");
  });

  test("throws on duplicate task id", () => {
    const root = hostEl("smithers:workflow", {}, [
      hostEl("smithers:task", { id: "dup", output: "t" }),
      hostEl("smithers:task", { id: "dup", output: "t" }),
    ]);
    expect(() => extractFromHost(root)).toThrow("Duplicate Task id");
  });

  test("throws on nested ralph", () => {
    const root = hostEl("smithers:ralph", { id: "outer" }, [
      hostEl("smithers:ralph", { id: "inner" }, [
        hostEl("smithers:task", { id: "t1", output: "t" }),
      ]),
    ]);
    expect(() => extractFromHost(root)).toThrow("Nested <Ralph>");
  });

  test("throws on duplicate ralph id", () => {
    const root = hostEl("smithers:workflow", {}, [
      hostEl("smithers:ralph", { id: "loop" }, [
        hostEl("smithers:task", { id: "t1", output: "t" }),
      ]),
      hostEl("smithers:ralph", { id: "loop" }, [
        hostEl("smithers:task", { id: "t2", output: "t" }),
      ]),
    ]);
    expect(() => extractFromHost(root)).toThrow("Duplicate Ralph id");
  });

  test("extracts ralph iteration from opts", () => {
    const root = hostEl("smithers:ralph", { id: "myLoop" }, [
      hostEl("smithers:task", { id: "t1", output: "t" }),
    ]);
    const result = extractFromHost(root, {
      ralphIterations: new Map([["myLoop", 3]]),
    });
    expect(result.tasks[0].iteration).toBe(3);
  });

  test("ralph iteration from record opts", () => {
    const root = hostEl("smithers:ralph", { id: "myLoop" }, [
      hostEl("smithers:task", { id: "t1", output: "t" }),
    ]);
    const result = extractFromHost(root, {
      ralphIterations: { myLoop: 2 },
    });
    expect(result.tasks[0].iteration).toBe(2);
  });

  test("extracts task with agent kind", () => {
    const agent = { generate: async () => ({}) };
    const root = hostEl("smithers:task", {
      id: "t1",
      output: "t",
      agent,
      __smithersKind: "agent",
      children: "Write a poem",
    });
    const result = extractFromHost(root);
    expect(result.tasks[0].agent).toBe(agent);
    expect(result.tasks[0].prompt).toBe("Write a poem");
  });

  test("extracts compute task", () => {
    const fn = () => ({ value: 1 });
    const root = hostEl("smithers:task", {
      id: "t1",
      output: "t",
      __smithersKind: "compute",
      __smithersComputeFn: fn,
    });
    const result = extractFromHost(root);
    expect(result.tasks[0].computeFn).toBe(fn);
  });

  test("extracts dependsOn", () => {
    const root = hostEl("smithers:task", {
      id: "t1",
      output: "t",
      dependsOn: ["a", "b"],
    });
    const result = extractFromHost(root);
    expect(result.tasks[0].dependsOn).toEqual(["a", "b"]);
  });

  test("extracts needs", () => {
    const root = hostEl("smithers:task", {
      id: "t1",
      output: "t",
      needs: { plan: "plan-task" },
    });
    const result = extractFromHost(root);
    expect(result.tasks[0].needs).toEqual({ plan: "plan-task" });
  });

  test("extracts needsApproval flag", () => {
    const root = hostEl("smithers:task", {
      id: "t1",
      output: "t",
      needsApproval: true,
    });
    const result = extractFromHost(root);
    expect(result.tasks[0].needsApproval).toBe(true);
  });

  test("extracts approval mode", () => {
    const root = hostEl("smithers:task", {
      id: "t1",
      output: "t",
      needsApproval: true,
      approvalMode: "decision",
    });
    const result = extractFromHost(root);
    expect(result.tasks[0].approvalMode).toBe("decision");
  });

  test("extracts retry and timeout settings", () => {
    const root = hostEl("smithers:task", {
      id: "t1",
      output: "t",
      retries: 3,
      timeoutMs: 5000,
      continueOnFail: true,
    });
    const result = extractFromHost(root);
    expect(result.tasks[0].retries).toBe(3);
    expect(result.tasks[0].timeoutMs).toBe(5000);
    expect(result.tasks[0].continueOnFail).toBe(true);
  });

  test("defaults tasks to infinite retries with exponential backoff", () => {
    const root = hostEl("smithers:task", {
      id: "t1",
      output: "t",
    });
    const result = extractFromHost(root);
    expect(result.tasks[0].retries).toBe(Infinity);
    expect(result.tasks[0].retryPolicy).toEqual({
      backoff: "exponential",
      initialDelayMs: 1000,
    });
  });

  test("noRetry disables default retries and retry policy", () => {
    const root = hostEl("smithers:task", {
      id: "t1",
      output: "t",
      noRetry: true,
    });
    const result = extractFromHost(root);
    expect(result.tasks[0].retries).toBe(0);
    expect(result.tasks[0].retryPolicy).toBeUndefined();
  });

  test("extracts skipIf flag", () => {
    const root = hostEl("smithers:task", {
      id: "t1",
      output: "t",
      skipIf: true,
    });
    const result = extractFromHost(root);
    expect(result.tasks[0].skipIf).toBe(true);
  });

  test("extracts label and meta", () => {
    const root = hostEl("smithers:task", {
      id: "t1",
      output: "t",
      label: "My Task",
      meta: { source: "test" },
    });
    const result = extractFromHost(root);
    expect(result.tasks[0].label).toBe("My Task");
    expect(result.tasks[0].meta).toEqual({ source: "test" });
  });

  test("parallel assigns group id to tasks", () => {
    const root = hostEl("smithers:parallel", { id: "p1" }, [
      hostEl("smithers:task", { id: "t1", output: "t" }),
      hostEl("smithers:task", { id: "t2", output: "t" }),
    ]);
    const result = extractFromHost(root);
    expect(result.tasks[0].parallelGroupId).toBe("p1");
    expect(result.tasks[1].parallelGroupId).toBe("p1");
  });

  test("merge-queue defaults concurrency to 1", () => {
    const root = hostEl("smithers:merge-queue", {}, [
      hostEl("smithers:task", { id: "t1", output: "t" }),
    ]);
    const result = extractFromHost(root);
    expect(result.tasks[0].parallelMaxConcurrency).toBe(1);
  });

  test("parallel unbounded concurrency for non-positive values", () => {
    const root = hostEl("smithers:parallel", { maxConcurrency: 0 }, [
      hostEl("smithers:task", { id: "t1", output: "t" }),
    ]);
    const result = extractFromHost(root);
    expect(result.tasks[0].parallelMaxConcurrency).toBeUndefined();
  });

  test("extracts sandbox as an isolated task", () => {
    const root = hostEl("smithers:workflow", {}, [
      hostEl(
        "smithers:sandbox",
        {
          id: "safe",
          output: "sandbox_out",
          runtime: "docker",
          __smithersSandboxWorkflow: { build: () => null },
        },
        [
          hostEl("smithers:task", { id: "inside", output: "inner_out" }),
        ],
      ),
    ]);

    const result = extractFromHost(root);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].nodeId).toBe("safe");
    expect(result.tasks[0].outputTableName).toBe("sandbox_out");
    expect(result.tasks[0].meta?.__sandbox).toBe(true);
    expect(result.tasks[0].meta?.__sandboxRuntime).toBe("docker");
  });

  test("sandbox missing output throws", () => {
    const root = hostEl("smithers:sandbox", { id: "safe" });
    expect(() => extractFromHost(root)).toThrow("Sandbox safe is missing output");
  });

  test("subflow inline mode does not create standalone descriptor", () => {
    const root = hostEl("smithers:workflow", {}, [
      hostEl(
        "smithers:subflow",
        {
          id: "sf",
          mode: "inline",
          output: "subflow_out",
        },
        [hostEl("smithers:task", { id: "inner", output: "inner_out" })],
      ),
    ]);

    const result = extractFromHost(root);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].nodeId).toBe("inner");
    expect(result.mountedTaskIds).toEqual(["inner::0"]);
  });

  test("worktree assigns worktreeId and path to tasks", () => {
    const root = hostEl(
      "smithers:worktree",
      { id: "wt1", path: "/tmp/wt" },
      [hostEl("smithers:task", { id: "t1", output: "t" })],
    );
    const result = extractFromHost(root);
    expect(result.tasks[0].worktreeId).toBe("wt1");
    expect(result.tasks[0].worktreePath).toContain("wt");
  });

  test("throws on duplicate worktree id", () => {
    const root = hostEl("smithers:workflow", {}, [
      hostEl("smithers:worktree", { id: "wt", path: "/a" }, [
        hostEl("smithers:task", { id: "t1", output: "t" }),
      ]),
      hostEl("smithers:worktree", { id: "wt", path: "/b" }, [
        hostEl("smithers:task", { id: "t2", output: "t" }),
      ]),
    ]);
    expect(() => extractFromHost(root)).toThrow("Duplicate Worktree id");
  });

  test("throws on empty worktree path", () => {
    const root = hostEl("smithers:worktree", { path: "" }, [
      hostEl("smithers:task", { id: "t1", output: "t" }),
    ]);
    expect(() => extractFromHost(root)).toThrow("non-empty path");
  });

  test("mountedTaskIds include iteration", () => {
    const root = hostEl("smithers:task", { id: "myTask", output: "t" });
    const result = extractFromHost(root);
    expect(result.mountedTaskIds).toEqual(["myTask::0"]);
  });

  test("text nodes are skipped during walk", () => {
    const root = hostEl("smithers:workflow", {}, [
      hostText("some text"),
      hostEl("smithers:task", { id: "t1", output: "t" }),
    ]);
    const result = extractFromHost(root);
    expect(result.tasks).toHaveLength(1);
  });

  test("generates xml representation", () => {
    const root = hostEl("smithers:workflow", { name: "test" }, [
      hostEl("smithers:task", { id: "t1", output: "t" }),
    ]);
    const result = extractFromHost(root);
    expect(result.xml).not.toBeNull();
    if (result.xml && result.xml.kind === "element") {
      expect(result.xml.tag).toBe("smithers:workflow");
    }
  });

  test("extracts Zod schema as outputRef", () => {
    const schema = z.object({ value: z.string() });
    const root = hostEl("smithers:task", {
      id: "t1",
      output: schema,
    });
    const result = extractFromHost(root);
    expect(result.tasks[0].outputRef).toBe(schema);
  });

  test("extracts retryPolicy object", () => {
    const policy = { backoff: "exponential" as const, initialDelayMs: 100 };
    const root = hostEl("smithers:task", {
      id: "t1",
      output: "t",
      retryPolicy: policy,
    });
    const result = extractFromHost(root);
    expect(result.tasks[0].retryPolicy).toEqual(policy);
  });

  test("extracts cachePolicy object", () => {
    const cache = { by: () => "key", version: "v1" };
    const root = hostEl("smithers:task", {
      id: "t1",
      output: "t",
      cache,
    });
    const result = extractFromHost(root);
    expect(result.tasks[0].cachePolicy).toBe(cache);
  });

  test("filters non-string values from dependsOn", () => {
    const root = hostEl("smithers:task", {
      id: "t1",
      output: "t",
      dependsOn: ["valid", 42, null, "also-valid"],
    });
    const result = extractFromHost(root);
    expect(result.tasks[0].dependsOn).toEqual(["valid", "also-valid"]);
  });
});
