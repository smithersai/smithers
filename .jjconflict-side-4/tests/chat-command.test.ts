import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../src/db/adapter";
import { ensureSmithersTables } from "../src/db/ensure";
import { createTempRepo, runSmithers } from "./e2e-helpers";

function openRepoDb(repo: ReturnType<typeof createTempRepo>) {
  const sqlite = new Database(repo.path("smithers.db"));
  const db = drizzle(sqlite);
  ensureSmithersTables(db as any);
  return {
    sqlite,
    adapter: new SmithersDb(db as any),
  };
}

test("chat defaults to the latest agent attempt in the latest run", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);

  try {
    await adapter.insertRun({
      runId: "chat-run",
      workflowName: "chat-fixture",
      status: "finished",
      createdAtMs: 1_000,
      startedAtMs: 1_000,
      finishedAtMs: 2_000,
    });

    await adapter.insertAttempt({
      runId: "chat-run",
      nodeId: "plan",
      iteration: 0,
      attempt: 1,
      state: "finished",
      startedAtMs: 1_100,
      finishedAtMs: 1_300,
      errorJson: null,
      jjPointer: null,
      jjCwd: repo.dir,
      cached: false,
      metaJson: JSON.stringify({
        kind: "agent",
        prompt: "First prompt",
        label: "Plan",
        agentId: "codex",
      }),
      responseText: null,
    });
    await adapter.insertEventWithNextSeq({
      runId: "chat-run",
      timestampMs: 1_200,
      type: "NodeOutput",
      payloadJson: JSON.stringify({
        nodeId: "plan",
        iteration: 0,
        attempt: 1,
        stream: "stdout",
        text: "first answer",
      }),
    });

    await adapter.insertAttempt({
      runId: "chat-run",
      nodeId: "review",
      iteration: 0,
      attempt: 1,
      state: "finished",
      startedAtMs: 1_500,
      finishedAtMs: 1_800,
      errorJson: null,
      jjPointer: null,
      jjCwd: repo.dir,
      cached: false,
      metaJson: JSON.stringify({
        kind: "agent",
        prompt: "Latest prompt",
        label: "Review",
        agentId: "openai-sdk",
      }),
      responseText: null,
    });
    await adapter.insertEventWithNextSeq({
      runId: "chat-run",
      timestampMs: 1_700,
      type: "NodeOutput",
      payloadJson: JSON.stringify({
        nodeId: "review",
        iteration: 0,
        attempt: 1,
        stream: "stdout",
        text: "latest answer",
      }),
    });

    const result = runSmithers(["chat"], {
      cwd: repo.dir,
      format: null,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Latest prompt");
    expect(result.stdout).toContain("latest answer");
    expect(result.stdout).not.toContain("First prompt");
    expect(result.stdout).not.toContain("first answer");
  } finally {
    sqlite.close();
  }
});

test("chat falls back to responseText when no streamed output was persisted", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);

  try {
    await adapter.insertRun({
      runId: "chat-fallback",
      workflowName: "chat-fixture",
      status: "finished",
      createdAtMs: 2_000,
      startedAtMs: 2_000,
      finishedAtMs: 3_000,
    });

    await adapter.insertAttempt({
      runId: "chat-fallback",
      nodeId: "implement",
      iteration: 0,
      attempt: 1,
      state: "finished",
      startedAtMs: 2_100,
      finishedAtMs: 2_800,
      errorJson: null,
      jjPointer: null,
      jjCwd: repo.dir,
      cached: false,
      metaJson: JSON.stringify({
        kind: "agent",
        prompt: "Implement the fix",
        label: "Implement",
        agentId: "openai-sdk",
      }),
      responseText: "Final assistant reply",
    });

    const result = runSmithers(["chat", "chat-fallback"], {
      cwd: repo.dir,
      format: null,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Implement the fix");
    expect(result.stdout).toContain("Final assistant reply");
  } finally {
    sqlite.close();
  }
});
