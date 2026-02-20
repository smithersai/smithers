import { describe, expect, test } from "bun:test";
import type { XmlElement } from "../src";
import { buildPlanTree, scheduleTasks, buildStateKey as key } from "../src/engine/scheduler";
import { el } from "./helpers";

// Shared minimal descriptor factory for scheduleTasks
function mk(id: string) {
  return {
    nodeId: id,
    ordinal: 0,
    iteration: 0,
    outputTable: null,
    outputTableName: "t",
    needsApproval: false,
    skipIf: false,
    retries: 0,
    timeoutMs: null,
    continueOnFail: false,
  } as any;
}

describe("scheduler: buildPlanTree — <Worktree>", () => {
  test("wraps <smithers:worktree> subtree as a group with correct children", () => {
    const xml: XmlElement = el("smithers:workflow", {}, [
      el("smithers:worktree", { id: "wt", path: "/tmp/wt" }, [
        el("smithers:task", { id: "a" }, []),
        el("smithers:task", { id: "b" }, []),
      ]),
    ]);

    const { plan, ralphs } = buildPlanTree(xml);
    expect(ralphs.length).toBe(0);
    expect(plan && plan.kind).toBe("sequence");
    const seq = plan as any;
    expect(seq.children.length).toBe(1);
    expect(seq.children[0].kind).toBe("group");
    const group = seq.children[0];
    expect(group.children.map((c: any) => c.kind)).toEqual(["task", "task"]);
    expect(group.children.map((c: any) => c.nodeId)).toEqual(["a", "b"]);
  });

  test("inside <Sequence>, worktree group preserves sequential gating", () => {
    const xml: XmlElement = el("smithers:workflow", {}, [
      el("smithers:sequence", {}, [
        el("smithers:worktree", { id: "wt", path: "/tmp/wt" }, [
          el("smithers:task", { id: "wa" }, []),
          el("smithers:task", { id: "wb" }, []),
        ]),
        el("smithers:task", { id: "after" }, []),
      ]),
    ]);

    const { plan } = buildPlanTree(xml);
    const desc = new Map<string, any>([
      ["wa", mk("wa")],
      ["wb", mk("wb")],
      ["after", mk("after")],
    ]);
    const states = new Map<string, any>();
    const ralph = new Map<string, any>();

    // Initially, only wa/wb should be runnable; "after" gated by sequence
    let s = scheduleTasks(plan!, states as any, desc as any, ralph as any);
    expect(s.runnable.map((t) => t.nodeId).sort()).toEqual(["wa", "wb"]);

    // Mark wa/wb finished; now "after" becomes runnable
    states.set("wa::0", "finished");
    states.set("wb::0", "finished");
    s = scheduleTasks(plan!, states as any, desc as any, ralph as any);
    expect(s.runnable.map((t) => t.nodeId)).toEqual(["after"]);
  });

  test("inside <Parallel>, worktree children are runnable alongside siblings", () => {
    const xml: XmlElement = el("smithers:workflow", {}, [
      el("smithers:parallel", { maxConcurrency: "2" }, [
        el("smithers:worktree", { id: "wt", path: "/tmp/wt" }, [
          el("smithers:task", { id: "wa" }, []),
          el("smithers:task", { id: "wb" }, []),
        ]),
        el("smithers:task", { id: "peer" }, []),
      ]),
    ]);

    const { plan } = buildPlanTree(xml);
    expect(plan && plan.kind).toBe("sequence");
    const par = (plan as any).children[0];
    expect(par.kind).toBe("parallel");

    const desc = new Map<string, any>([
      ["wa", mk("wa")],
      ["wb", mk("wb")],
      ["peer", mk("peer")],
    ]);
    const states = new Map<string, any>();
    const ralph = new Map<string, any>();
    const s = scheduleTasks(plan!, states as any, desc as any, ralph as any);
    expect(s.runnable.map((t) => t.nodeId).sort()).toEqual([
      "peer",
      "wa",
      "wb",
    ]);
  });

  test("empty worktree produces group with no children", () => {
    const xml: XmlElement = el("smithers:workflow", {}, [
      el("smithers:worktree", { id: "wt", path: "/tmp/wt" }, []),
    ]);
    const { plan } = buildPlanTree(xml);
    const group = (plan as any).children[0];
    expect(group.kind).toBe("group");
    expect(group.children).toEqual([]);
  });

  test("nested worktrees produce nested groups leading to task", () => {
    const xml: XmlElement = el("smithers:workflow", {}, [
      el("smithers:worktree", { id: "outer", path: "/tmp/outer" }, [
        el("smithers:worktree", { id: "inner", path: "/tmp/inner" }, [
          el("smithers:task", { id: "t" }, []),
        ]),
      ]),
    ]);
    const { plan } = buildPlanTree(xml);
    const outer = (plan as any).children[0];
    expect(outer.kind).toBe("group");
    const inner = outer.children[0];
    expect(inner.kind).toBe("group");
    const leaf = inner.children[0];
    expect(leaf.kind).toBe("task");
    expect(leaf.nodeId).toBe("t");
  });
});

describe("scheduler: per-group concurrency caps in scheduleTasks()", () => {
  function mkWithCap(id: string, gid?: string, cap?: number) {
    return {
      nodeId: id,
      ordinal: 0,
      iteration: 0,
      outputTable: null,
      outputTableName: "t",
      needsApproval: false,
      skipIf: false,
      retries: 0,
      timeoutMs: null,
      continueOnFail: false,
      parallelGroupId: gid,
      parallelMaxConcurrency: cap,
    } as any;
  }

  // state-key helper imported at top

  test("cap=2 with one in-progress allows one additional", () => {
    const xml = el("smithers:workflow", {}, [
      el("smithers:merge-queue", { id: "g" }, [
        el("smithers:task", { id: "a" }, []),
        el("smithers:task", { id: "b" }, []),
        el("smithers:task", { id: "c" }, []),
      ]),
    ]) as any;
    const { plan } = buildPlanTree(xml);
    const desc = new Map<string, any>([
      ["a", mkWithCap("a", "g", 2)],
      ["b", mkWithCap("b", "g", 2)],
      ["c", mkWithCap("c", "g", 2)],
    ]);
    const states = new Map<string, any>([[key("a", 0), "in-progress"]]);
    const ralph = new Map<string, any>();
    const s = scheduleTasks(plan!, states as any, desc as any, ralph as any);
    // Only one of b/c should be runnable due to remaining group capacity = 1
    expect(s.runnable.length).toBe(1);
    expect(s.runnable[0]!.nodeId).toBe("b");
  });

  test("cap=1 admits at most one pending from the group", () => {
    const xml = el("smithers:workflow", {}, [
      el("smithers:merge-queue", { id: "q" }, [
        el("smithers:task", { id: "m1" }, []),
        el("smithers:task", { id: "m2" }, []),
      ]),
    ]) as any;
    const { plan } = buildPlanTree(xml);
    const desc = new Map<string, any>([
      ["m1", mkWithCap("m1", "q", 1)],
      ["m2", mkWithCap("m2", "q", 1)],
    ]);
    const states = new Map<string, any>();
    const ralph = new Map<string, any>();
    const s = scheduleTasks(plan!, states as any, desc as any, ralph as any);
    expect(s.runnable.length).toBe(1);
    expect(s.runnable[0]!.nodeId).toBe("m1");
  });
});
