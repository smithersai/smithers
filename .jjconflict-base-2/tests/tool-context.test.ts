import { describe, expect, test } from "bun:test";
import {
  runWithToolContext,
  getToolContext,
  nextToolSeq,
  type ToolContext,
} from "../src/tools/context";
import { ensureSmithersTables } from "../src/db/ensure";
import { SmithersDb } from "../src/db/adapter";
import { createTestDb } from "./helpers";
import { ddl, schema } from "./schema";

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  const { db, cleanup } = createTestDb(schema, ddl);
  ensureSmithersTables(db as any);
  const adapter = new SmithersDb(db as any);
  return {
    db: adapter,
    runId: "run-1",
    nodeId: "node-1",
    iteration: 0,
    attempt: 1,
    rootDir: "/tmp",
    allowNetwork: false,
    maxOutputBytes: 200_000,
    timeoutMs: 5000,
    seq: 0,
    ...overrides,
  };
}

describe("tool context", () => {
  test("getToolContext returns undefined outside runWithToolContext", () => {
    expect(getToolContext()).toBeUndefined();
  });

  test("getToolContext returns context inside runWithToolContext", async () => {
    const ctx = makeCtx();
    await runWithToolContext(ctx, async () => {
      const retrieved = getToolContext();
      expect(retrieved).toBeDefined();
      expect(retrieved!.runId).toBe("run-1");
      expect(retrieved!.nodeId).toBe("node-1");
    });
  });

  test("context is isolated between concurrent runs", async () => {
    const ctx1 = makeCtx({ runId: "run-a", seq: 0 });
    const ctx2 = makeCtx({ runId: "run-b", seq: 0 });

    const results = await Promise.all([
      runWithToolContext(ctx1, async () => {
        await new Promise((r) => setTimeout(r, 10));
        return getToolContext()!.runId;
      }),
      runWithToolContext(ctx2, async () => {
        return getToolContext()!.runId;
      }),
    ]);

    expect(results).toEqual(["run-a", "run-b"]);
  });

  test("nextToolSeq increments seq on context", () => {
    const ctx = makeCtx({ seq: 0 });
    expect(nextToolSeq(ctx)).toBe(1);
    expect(nextToolSeq(ctx)).toBe(2);
    expect(nextToolSeq(ctx)).toBe(3);
    expect(ctx.seq).toBe(3);
  });

  test("context is no longer available after runWithToolContext completes", async () => {
    const ctx = makeCtx();
    await runWithToolContext(ctx, async () => {
      expect(getToolContext()).toBeDefined();
    });
    expect(getToolContext()).toBeUndefined();
  });
});
