import { describe, expect, test } from "bun:test";
import {
  runWithToolContext,
  getToolContext,
  nextToolSeq,
  type ToolContext,
} from "../src/tools/context";

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    db: {} as any,
    runId: "test-run",
    nodeId: "test-node",
    iteration: 0,
    attempt: 0,
    rootDir: "/tmp",
    allowNetwork: false,
    maxOutputBytes: 200_000,
    timeoutMs: 60_000,
    seq: 0,
    ...overrides,
  };
}

describe("runWithToolContext", () => {
  test("makes context available inside callback", async () => {
    const ctx = makeContext({ runId: "r1", nodeId: "n1" });
    await runWithToolContext(ctx, async () => {
      const stored = getToolContext();
      expect(stored).toBeDefined();
      expect(stored!.runId).toBe("r1");
      expect(stored!.nodeId).toBe("n1");
    });
  });

  test("returns callback result", async () => {
    const ctx = makeContext();
    const result = await runWithToolContext(ctx, async () => 42);
    expect(result).toBe(42);
  });

  test("context is undefined outside runWithToolContext", () => {
    expect(getToolContext()).toBeUndefined();
  });

  test("nested contexts are isolated", async () => {
    const outer = makeContext({ runId: "outer" });
    const inner = makeContext({ runId: "inner" });

    await runWithToolContext(outer, async () => {
      expect(getToolContext()!.runId).toBe("outer");

      await runWithToolContext(inner, async () => {
        expect(getToolContext()!.runId).toBe("inner");
      });

      // Outer context restored
      expect(getToolContext()!.runId).toBe("outer");
    });
  });

  test("concurrent contexts are isolated", async () => {
    const ctx1 = makeContext({ runId: "c1" });
    const ctx2 = makeContext({ runId: "c2" });

    const [r1, r2] = await Promise.all([
      runWithToolContext(ctx1, async () => {
        await new Promise((r) => setTimeout(r, 10));
        return getToolContext()!.runId;
      }),
      runWithToolContext(ctx2, async () => {
        await new Promise((r) => setTimeout(r, 10));
        return getToolContext()!.runId;
      }),
    ]);

    expect(r1).toBe("c1");
    expect(r2).toBe("c2");
  });
});

describe("nextToolSeq", () => {
  test("increments seq counter", () => {
    const ctx = makeContext({ seq: 0 });
    expect(nextToolSeq(ctx)).toBe(1);
    expect(nextToolSeq(ctx)).toBe(2);
    expect(nextToolSeq(ctx)).toBe(3);
    expect(ctx.seq).toBe(3);
  });

  test("starts from existing seq value", () => {
    const ctx = makeContext({ seq: 10 });
    expect(nextToolSeq(ctx)).toBe(11);
  });
});
