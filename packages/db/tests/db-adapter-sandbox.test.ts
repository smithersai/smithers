import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../src/adapter";
import { ensureSmithersTables } from "../src/ensure";

function createAdapter() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

const now = Date.now();

describe("SmithersDb sandbox helpers", () => {
  test("upsertSandbox and getSandbox", async () => {
    const { sqlite, adapter } = createAdapter();

    await adapter.upsertSandbox({
      runId: "run-1",
      sandboxId: "sb-1",
      runtime: "bubblewrap",
      remoteRunId: null,
      workspaceId: null,
      containerId: null,
      configJson: "{}",
      status: "pending",
      shippedAtMs: null,
      completedAtMs: null,
      bundlePath: null,
    });

    const row = await adapter.getSandbox("run-1", "sb-1");
    expect(row).toBeDefined();
    expect(row?.runId).toBe("run-1");
    expect(row?.sandboxId).toBe("sb-1");
    expect(row?.runtime).toBe("bubblewrap");

    sqlite.close();
  });

  test("upsertSandbox updates existing row", async () => {
    const { sqlite, adapter } = createAdapter();

    await adapter.upsertSandbox({
      runId: "run-1",
      sandboxId: "sb-1",
      runtime: "docker",
      remoteRunId: null,
      workspaceId: null,
      containerId: "container-a",
      configJson: "{}",
      status: "shipped",
      shippedAtMs: now,
      completedAtMs: null,
      bundlePath: null,
    });

    await adapter.upsertSandbox({
      runId: "run-1",
      sandboxId: "sb-1",
      runtime: "docker",
      remoteRunId: "child-1",
      workspaceId: null,
      containerId: "container-a",
      configJson: "{}",
      status: "finished",
      shippedAtMs: now,
      completedAtMs: now + 1,
      bundlePath: "/tmp/bundle",
    });

    const row = await adapter.getSandbox("run-1", "sb-1");
    expect(row?.status).toBe("finished");
    expect(row?.remoteRunId).toBe("child-1");
    expect(row?.bundlePath).toBe("/tmp/bundle");

    sqlite.close();
  });

  test("listSandboxes only returns rows for one run", async () => {
    const { sqlite, adapter } = createAdapter();

    await adapter.upsertSandbox({
      runId: "run-1",
      sandboxId: "sb-1",
      runtime: "bubblewrap",
      remoteRunId: null,
      workspaceId: null,
      containerId: null,
      configJson: "{}",
      status: "pending",
      shippedAtMs: null,
      completedAtMs: null,
      bundlePath: null,
    });
    await adapter.upsertSandbox({
      runId: "run-1",
      sandboxId: "sb-2",
      runtime: "docker",
      remoteRunId: null,
      workspaceId: null,
      containerId: "c-2",
      configJson: "{}",
      status: "pending",
      shippedAtMs: null,
      completedAtMs: null,
      bundlePath: null,
    });
    await adapter.upsertSandbox({
      runId: "run-2",
      sandboxId: "sb-x",
      runtime: "codeplane",
      remoteRunId: null,
      workspaceId: "w-1",
      containerId: null,
      configJson: "{}",
      status: "pending",
      shippedAtMs: null,
      completedAtMs: null,
      bundlePath: null,
    });

    const rows = await adapter.listSandboxes("run-1");
    expect(rows.length).toBe(2);
    expect(rows.map((row) => row.sandboxId).sort()).toEqual(["sb-1", "sb-2"]);

    sqlite.close();
  });

  test("getLatestChildRun uses parentRunId", async () => {
    const { sqlite, adapter } = createAdapter();

    await adapter.insertRun({
      runId: "parent",
      parentRunId: null,
      workflowName: "wf",
      workflowPath: null,
      workflowHash: null,
      status: "running",
      createdAtMs: now,
    });

    await adapter.insertRun({
      runId: "child-1",
      parentRunId: "parent",
      workflowName: "wf",
      workflowPath: null,
      workflowHash: null,
      status: "finished",
      createdAtMs: now + 1,
    });

    await adapter.insertRun({
      runId: "child-2",
      parentRunId: "parent",
      workflowName: "wf",
      workflowPath: null,
      workflowHash: null,
      status: "finished",
      createdAtMs: now + 2,
    });

    const latest = await adapter.getLatestChildRun("parent");
    expect(latest?.runId).toBe("child-2");

    sqlite.close();
  });
});
