/**
 * Reproduction for https://github.com/jjhub-ai/smithers/issues/111
 *
 * Nested <Loop>/<Ralph> separated by a structural node (<Sequence>, <Parallel>,
 * etc.) should be allowed. Direct nesting (<Ralph><Ralph>) should remain rejected.
 */
import { describe, expect, test } from "bun:test";
import { buildPlanTree } from "@smithers/engine/scheduler";
import { extractFromHost, type HostElement } from "@smithers/graph/dom/extract";
import { el } from "./helpers";

// ── Minimal HostElement factory for extract.ts tests ─────────────────
function hostEl(
  tag: string,
  rawProps: Record<string, any> = {},
  children: HostElement[] = [],
): HostElement {
  const props: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawProps)) {
    if (typeof v === "string") props[k] = v;
  }
  return { kind: "element", tag, props, rawProps, children };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. scheduler.ts – buildPlanTree
// ═══════════════════════════════════════════════════════════════════════
describe("issue #111 – buildPlanTree nested ralph", () => {
  test("direct nesting is rejected", () => {
    const xml = el("smithers:ralph", { id: "outer" }, [
      el("smithers:ralph", { id: "inner" }, [
        el("smithers:task", { id: "t1" }),
      ]),
    ]);
    expect(() => buildPlanTree(xml)).toThrow("Nested <Ralph>");
  });

  test("ralph > sequence > ralph is allowed", () => {
    const xml = el("smithers:ralph", { id: "outer" }, [
      el("smithers:sequence", {}, [
        el("smithers:ralph", { id: "inner" }, [
          el("smithers:task", { id: "t1" }),
        ]),
      ]),
    ]);
    const { plan, ralphs } = buildPlanTree(xml);
    expect(plan).toBeDefined();
    expect(ralphs).toHaveLength(2);
    expect(ralphs.map((r) => r.id).sort()).toEqual(["inner@@outer=0", "outer"]);
  });

  test("ralph > parallel > ralph is allowed", () => {
    const xml = el("smithers:ralph", { id: "outer" }, [
      el("smithers:parallel", {}, [
        el("smithers:ralph", { id: "inner" }, [
          el("smithers:task", { id: "t1" }),
        ]),
      ]),
    ]);
    const { plan, ralphs } = buildPlanTree(xml);
    expect(plan).toBeDefined();
    expect(ralphs).toHaveLength(2);
  });

  test("ralph > worktree (group) > ralph is allowed", () => {
    const xml = el("smithers:ralph", { id: "outer" }, [
      el("smithers:worktree", { id: "wt", path: "/tmp/test" }, [
        el("smithers:ralph", { id: "inner" }, [
          el("smithers:task", { id: "t1" }),
        ]),
      ]),
    ]);
    const { plan, ralphs } = buildPlanTree(xml);
    expect(plan).toBeDefined();
    expect(ralphs).toHaveLength(2);
  });

  test("three levels: ralph > sequence > ralph > sequence > ralph", () => {
    const xml = el("smithers:ralph", { id: "L1" }, [
      el("smithers:sequence", {}, [
        el("smithers:ralph", { id: "L2" }, [
          el("smithers:sequence", {}, [
            el("smithers:ralph", { id: "L3" }, [
              el("smithers:task", { id: "t1" }),
            ]),
          ]),
        ]),
      ]),
    ]);
    const { ralphs } = buildPlanTree(xml);
    expect(ralphs).toHaveLength(3);
  });

  test("sibling ralphs inside sequence are allowed", () => {
    const xml = el("smithers:sequence", {}, [
      el("smithers:ralph", { id: "a" }, [
        el("smithers:task", { id: "t1" }),
      ]),
      el("smithers:ralph", { id: "b" }, [
        el("smithers:task", { id: "t2" }),
      ]),
    ]);
    const { ralphs } = buildPlanTree(xml);
    expect(ralphs).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. extract.ts – extractFromHost
// ═══════════════════════════════════════════════════════════════════════
describe("issue #111 – extractFromHost nested ralph", () => {
  test("direct nesting is rejected", () => {
    const root = hostEl("smithers:ralph", { id: "outer" }, [
      hostEl("smithers:ralph", { id: "inner" }, [
        hostEl("smithers:task", {
          id: "t1",
          output: "out",
          __smithersPayload: "data",
        }),
      ]),
    ]);
    expect(() => extractFromHost(root)).toThrow("Nested <Ralph>");
  });

  test("ralph > sequence > ralph is allowed", () => {
    const root = hostEl("smithers:ralph", { id: "outer" }, [
      hostEl("smithers:sequence", {}, [
        hostEl("smithers:ralph", { id: "inner" }, [
          hostEl("smithers:task", {
            id: "t1",
            output: "out",
            __smithersPayload: "data",
          }),
        ]),
      ]),
    ]);
    const result = extractFromHost(root);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].ralphId).toBe("inner@@outer=0");
  });

  test("inner task gets innermost ralphId", () => {
    const root = hostEl("smithers:ralph", { id: "outer" }, [
      hostEl("smithers:sequence", {}, [
        hostEl("smithers:ralph", { id: "inner" }, [
          hostEl("smithers:task", {
            id: "t1",
            output: "out",
            __smithersPayload: "data",
          }),
        ]),
        hostEl("smithers:task", {
          id: "t2",
          output: "out",
          __smithersPayload: "data",
        }),
      ]),
    ]);
    const result = extractFromHost(root);
    // t1 is inside inner loop, scoped by outer=0
    const t1 = result.tasks.find((t) => t.nodeId === "t1@@outer=0")!;
    // t2 is only inside outer loop, no scope suffix
    const t2 = result.tasks.find((t) => t.nodeId === "t2")!;
    expect(t1.ralphId).toBe("inner@@outer=0");
    expect(t2.ralphId).toBe("outer");
  });
});
