import { describe, expect, test } from "bun:test";
import type { XmlElement } from "../src";
import { buildPlanTree } from "../src/engine/scheduler";
import { el } from "./helpers";

describe("scheduler: explicit worktree + merge-queue plan shape", () => {
  test("worktree is group; merge-queue is parallel (concurrency enforced via descriptors)", () => {
    const xml: XmlElement = el("smithers:workflow", {}, [
      el("smithers:worktree", { id: "wt", path: "/tmp/wt" }, [
        el("smithers:task", { id: "a" }, []),
        el("smithers:task", { id: "b" }, []),
      ]),
      el("smithers:merge-queue", { id: "mq" }, [
        el("smithers:task", { id: "m1" }, []),
        el("smithers:task", { id: "m2" }, []),
      ]),
    ]);

    const { plan } = buildPlanTree(xml);
    expect(plan && plan.kind).toBe("sequence");
    const seq = plan as any;
    expect(seq.children.length).toBe(2);

    const group = seq.children[0];
    expect(group.kind).toBe("group");
    expect(group.children.map((c: any) => c.nodeId)).toEqual(["a", "b"]);

    const par = seq.children[1];
    expect(par.kind).toBe("parallel");
    expect(par.children.map((c: any) => c.nodeId)).toEqual(["m1", "m2"]);
  });
});
