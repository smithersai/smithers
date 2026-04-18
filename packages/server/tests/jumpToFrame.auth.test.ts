/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import React from "react";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { Gateway } from "../src/gateway.js";

function makeDbPath(name: string) {
  return join(
    tmpdir(),
    `smithers-jump-auth-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function createConnectionContext(userId: string | null, role = "operator") {
  return {
    connectionId: `conn-${Math.random().toString(36).slice(2)}`,
    transport: "test",
    authenticated: true,
    sessionToken: "session",
    role,
    scopes: ["*"],
    userId,
    subscribedRuns: new Set<string>(),
    heartbeatTimer: null,
  };
}

async function request(
  gateway: Gateway,
  connection: ReturnType<typeof createConnectionContext>,
  method: string,
  params?: Record<string, unknown>,
) {
  return (gateway as any).routeRequest(connection, {
    type: "req",
    id: `${method}-${Math.random().toString(36).slice(2)}`,
    method,
    params,
  });
}

describe("jumpToFrame auth", () => {
  const dbPaths: string[] = [];
  let gateway: Gateway | undefined;

  afterEach(async () => {
    if (gateway) {
      await gateway.close();
      gateway = undefined;
    }
    for (const dbPath of dbPaths) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    }
    dbPaths.length = 0;
  });

  test("only owner or admin may call jumpToFrame", async () => {
    const dbPath = makeDbPath("owner");
    dbPaths.push(dbPath);

    const api = createSmithers(
      {
        output: z.object({ value: z.number() }),
      },
      { dbPath },
    );

    const workflow = api.smithers(() =>
      React.createElement(
        api.Workflow,
        { name: "jump-auth" },
        React.createElement(
          api.Task,
          { id: "task:a", output: api.outputs.output },
          { value: 1 },
        ),
      ),
    );

    gateway = new Gateway();
    gateway.register("jump-auth", workflow);

    const adapter = new SmithersDb(api.db);
    const runId = "run-jump-auth";

    await adapter.insertRun({
      runId,
      workflowName: "wf",
      status: "finished",
      createdAtMs: Date.now(),
      configJson: JSON.stringify({
        auth: {
          triggeredBy: "user:owner",
          role: "operator",
          scopes: ["*"],
          createdAt: new Date().toISOString(),
        },
      }),
    });
    await adapter.insertFrame({
      runId,
      frameNo: 0,
      createdAtMs: Date.now(),
      xmlJson: JSON.stringify({ kind: "element", tag: "smithers:workflow", props: {} }),
      xmlHash: "hash-0",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "frame-0",
    });

    const notOwner = await request(
      gateway,
      createConnectionContext("user:not-owner", "operator"),
      "jumpToFrame",
      { runId, frameNo: 0, confirm: true },
    );
    expect(notOwner.ok).toBe(false);
    expect(notOwner.error.code).toBe("Unauthorized");

    const owner = await request(
      gateway,
      createConnectionContext("user:owner", "operator"),
      "jumpToFrame",
      { runId, frameNo: 0, confirm: true },
    );
    expect(owner.ok).toBe(true);

    const admin = await request(
      gateway,
      createConnectionContext("user:admin", "admin"),
      "jumpToFrame",
      { runId, frameNo: 0, confirm: true },
    );
    expect(admin.ok).toBe(true);
  });

  test("legacy runs without owner metadata require admin", async () => {
    const dbPath = makeDbPath("legacy");
    dbPaths.push(dbPath);

    const api = createSmithers(
      {
        output: z.object({ value: z.number() }),
      },
      { dbPath },
    );

    const workflow = api.smithers(() =>
      React.createElement(
        api.Workflow,
        { name: "jump-auth-legacy" },
        React.createElement(
          api.Task,
          { id: "task:a", output: api.outputs.output },
          { value: 1 },
        ),
      ),
    );

    gateway = new Gateway();
    gateway.register("jump-auth-legacy", workflow);

    const adapter = new SmithersDb(api.db);
    const runId = "run-jump-auth-legacy";

    await adapter.insertRun({
      runId,
      workflowName: "wf",
      status: "finished",
      createdAtMs: Date.now(),
      configJson: JSON.stringify({}),
    });
    await adapter.insertFrame({
      runId,
      frameNo: 0,
      createdAtMs: Date.now(),
      xmlJson: JSON.stringify({ kind: "element", tag: "smithers:workflow", props: {} }),
      xmlHash: "hash-0",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "frame-0",
    });

    const operator = await request(
      gateway,
      createConnectionContext("user:any", "operator"),
      "jumpToFrame",
      { runId, frameNo: 0, confirm: true },
    );
    expect(operator.ok).toBe(false);
    expect(operator.error.code).toBe("Unauthorized");

    const admin = await request(
      gateway,
      createConnectionContext("user:any", "admin"),
      "jumpToFrame",
      { runId, frameNo: 0, confirm: true },
    );
    expect(admin.ok).toBe(true);
  });

  test("pause path fails with RewindFailed when task does not terminate within 10s", async () => {
    const dbPath = makeDbPath("mid-exec");
    dbPaths.push(dbPath);

    const api = createSmithers(
      { output: z.object({ value: z.number() }) },
      { dbPath },
    );
    const workflow = api.smithers(() =>
      React.createElement(
        api.Workflow,
        { name: "jump-midexec" },
        React.createElement(
          api.Task,
          { id: "task:a", output: api.outputs.output },
          { value: 1 },
        ),
      ),
    );
    gateway = new Gateway();
    gateway.register("jump-midexec", workflow);

    const adapter = new SmithersDb(api.db);
    const runId = "run-mid-exec";
    await adapter.insertRun({
      runId,
      workflowName: "wf",
      status: "running",
      createdAtMs: Date.now(),
      configJson: JSON.stringify({ auth: { triggeredBy: "user:owner" } }),
    });
    await adapter.insertFrame({
      runId,
      frameNo: 0,
      createdAtMs: Date.now() - 1000,
      xmlJson: JSON.stringify({ kind: "element", tag: "smithers:workflow", props: {} }),
      xmlHash: "hash-0",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "frame-0",
    });
    // Need a second frame so frameNo 0 is not the latest (otherwise jumpToFrame
    // takes its no-op early-return path and never calls pauseRunLoop).
    await adapter.insertFrame({
      runId,
      frameNo: 1,
      createdAtMs: Date.now(),
      xmlJson: JSON.stringify({ kind: "element", tag: "smithers:workflow", props: { f: 1 } }),
      xmlHash: "hash-1",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "frame-1",
    });

    // Simulate a zombie activeRun: the abort controller never leads to
    // activeRuns.delete. The gateway must surface this as `RewindFailed`.
    const zombieAbort = new AbortController();
    const activeRuns = (gateway as unknown as {
      activeRuns: Map<string, { workflowKey: string; workflow: unknown; abort: AbortController; input: unknown }>;
    }).activeRuns;
    activeRuns.set(runId, {
      workflowKey: "jump-midexec",
      workflow,
      abort: zombieAbort,
      input: {},
    });
    // Sanity check: gateway sees the zombie.
    expect(activeRuns.has(runId)).toBe(true);

    const started = Date.now();
    const response = await request(
      gateway,
      createConnectionContext("user:owner", "operator"),
      "jumpToFrame",
      { runId, frameNo: 0, confirm: true },
    );
    const elapsed = Date.now() - started;
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe("RewindFailed");
    // Must have waited at least ~10s before giving up.
    expect(elapsed).toBeGreaterThanOrEqual(9_500);

    // Clean up so afterEach closes cleanly.
    (gateway as unknown as {
      activeRuns: Map<string, unknown>;
    }).activeRuns.delete(runId);
  }, 30_000);
});
