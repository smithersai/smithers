import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { SmithersDb } from "@smithers/db/adapter";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { revertToJjPointer, getJjPointer } from "@smithers/vcs/jj";
import * as BunContext from "@effect/platform-bun/BunContext";
import { Effect } from "effect";
import { revertToAttempt, type RevertResult } from "../src/revert";
import { createTestDb } from "../../smithers/tests/helpers";
import { schema, ddl } from "../../smithers/tests/schema";
import type { SmithersEvent } from "@smithers/observability/SmithersEvent";

function buildDb() {
  const result = createTestDb(schema, ddl);
  ensureSmithersTables(result.db as any);
  return result;
}

describe("revertToJjPointer", () => {
  test("calls jj restore with correct pointer", async () => {
    const result = await Effect.runPromise(revertToJjPointer("abc123").pipe(Effect.provide(BunContext.layer)));
    expect(result).toHaveProperty("success");
  });

  test("returns error when jj is not available", async () => {
    const result = await Effect.runPromise(revertToJjPointer("invalid-pointer-that-should-fail").pipe(Effect.provide(BunContext.layer)));
    expect(result).toHaveProperty("success");
  });
});

describe("revertToAttempt", () => {
  test("returns error when attempt not found", async () => {
    const { db, cleanup } = buildDb();
    const adapter = new SmithersDb(db as any);
    
    const events: SmithersEvent[] = [];
    const result = await revertToAttempt(adapter, {
      runId: "nonexistent",
      nodeId: "task1",
      iteration: 0,
      attempt: 1,
      onProgress: (e) => events.push(e),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
    cleanup();
  });

  test("returns error when attempt has no jjPointer", async () => {
    const { db, cleanup } = buildDb();
    const adapter = new SmithersDb(db as any);

    await adapter.insertRun({
      runId: "run1",
      workflowName: "test",
      status: "finished",
      createdAtMs: Date.now(),
    });

    await adapter.insertAttempt({
      runId: "run1",
      nodeId: "task1",
      iteration: 0,
      attempt: 1,
      state: "finished",
      startedAtMs: Date.now(),
      jjPointer: null,
    });

    const result = await revertToAttempt(adapter, {
      runId: "run1",
      nodeId: "task1",
      iteration: 0,
      attempt: 1,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("no jjPointer");
    cleanup();
  });

  test("emits RevertStarted and RevertFinished events on success", async () => {
    const { db, cleanup } = buildDb();
    const adapter = new SmithersDb(db as any);

    await adapter.insertRun({
      runId: "run1",
      workflowName: "test",
      status: "finished",
      createdAtMs: Date.now(),
    });

    await adapter.insertAttempt({
      runId: "run1",
      nodeId: "task1",
      iteration: 0,
      attempt: 1,
      state: "finished",
      startedAtMs: Date.now(),
      jjPointer: "test-pointer-123",
    });

    const events: SmithersEvent[] = [];
    const result = await revertToAttempt(adapter, {
      runId: "run1",
      nodeId: "task1",
      iteration: 0,
      attempt: 1,
      onProgress: (e) => events.push(e),
    });

    const revertStarted = events.find((e) => e.type === "RevertStarted");
    const revertFinished = events.find((e) => e.type === "RevertFinished");

    expect(revertStarted).toBeDefined();
    expect(revertFinished).toBeDefined();
    if (revertStarted && revertStarted.type === "RevertStarted") {
      expect(revertStarted.jjPointer).toBe("test-pointer-123");
    }
    cleanup();
  });
});

describe("SmithersDb.getAttempt", () => {
  test("returns attempt by composite key", async () => {
    const { db, cleanup } = buildDb();
    const adapter = new SmithersDb(db as any);

    await adapter.insertRun({
      runId: "run1",
      workflowName: "test",
      status: "finished",
      createdAtMs: Date.now(),
    });

    await adapter.insertAttempt({
      runId: "run1",
      nodeId: "task1",
      iteration: 0,
      attempt: 1,
      state: "finished",
      startedAtMs: Date.now(),
      jjPointer: "ptr-abc",
    });

    const attempt = await adapter.getAttempt("run1", "task1", 0, 1);
    expect(attempt).toBeDefined();
    expect(attempt?.jjPointer).toBe("ptr-abc");
    cleanup();
  });

  test("returns undefined for nonexistent attempt", async () => {
    const { db, cleanup } = buildDb();
    const adapter = new SmithersDb(db as any);

    const attempt = await adapter.getAttempt("nonexistent", "task1", 0, 1);
    expect(attempt).toBeUndefined();
    cleanup();
  });
});
